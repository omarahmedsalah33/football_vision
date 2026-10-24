import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/server/authz/permissions";
import { analysisJobs, analysisResults, analysisTracks, auditEvents, players, subscriptions, videos } from "../../src/server/db/schema";
import {
  addComment,
  addObservation,
  archiveDrill,
  closePlan,
  createDrill,
  createPlan,
  deleteLog,
  developmentView,
  library,
  logSession,
  squadDevelopment,
} from "../../src/server/development/service";
import { createMatch } from "../../src/server/matches/service";
import { createPlayer, linkTrack } from "../../src/server/players/service";
import { makeActor, testDb } from "../helpers";

const db = testDb();
const NOW = new Date("2026-10-01T12:00:00Z");
const REVIEW = "2026-10-29";

/** A succeeded analysis of six tracked players; track n sprints n times in 20 minutes. */
async function analysedMatch(actor: Actor, playedOn: string) {
  const match = await createMatch(db, actor, { title: `Match ${playedOn}`, playedOn });
  const [video] = await db
    .insert(videos)
    .values({ orgId: actor.orgId, matchId: match.id, storageKey: `t/${randomUUID()}`, declaredSizeBytes: 10, partSizeBytes: 10, partCount: 1, status: "validated" })
    .returning();
  const [job] = await db
    .insert(analysisJobs)
    .values({ orgId: actor.orgId, matchId: match.id, videoId: video.id, kind: "analyze", idempotencyKey: `k-${randomUUID()}`, status: "succeeded", usagePeriodStart: "2026-10-01", finishedAt: new Date() })
    .returning();
  await db.insert(analysisResults).values({ jobId: job.id, orgId: actor.orgId, matchId: match.id, summary: { pitch: { length: 105, width: 68 } } });
  for (let n = 1; n <= 6; n++) {
    await db.insert(analysisTracks).values({
      jobId: job.id,
      orgId: actor.orgId,
      trackNo: n,
      team: n <= 3 ? "a" : "b",
      firstSeconds: 0,
      lastSeconds: 1200,
      coverage: 0.9,
      avgX: n <= 3 ? 40 : 65,
      avgY: 34,
      heatmap: [[1]],
      metrics: { minutes: 20, distance_m: 2000 + n * 100, distance_per_min: 100 + n * 5, hi_per_min: n, hi_distance_m: n * 20, sprints: n, sprints_per_10min: n / 2, top_speed_ms: 6 + n * 0.3, late_vs_early: 0.8 + n * 0.02 },
    });
  }
  return { match, job };
}

async function onPlan(actor: Actor, planId: string) {
  await db.insert(subscriptions).values({ orgId: actor.orgId, planId, status: "active" });
}

/** A club with a player whose tracked runs (track 1) are the lowest in three September matches. */
async function slowPlayer(plan = "club") {
  const owner = await makeActor(db, "owner");
  if (plan !== "free") await onPlan(owner, plan);
  const player = await createPlayer(db, owner, { name: "Karim", position: "midfielder" });
  for (const day of ["2026-09-05", "2026-09-12", "2026-09-19"]) {
    const { job } = await analysedMatch(owner, day);
    await linkTrack(db, owner, job.id, 1, player.id);
  }
  return { owner, player };
}

const sprintPlan = { reviewOn: REVIEW, objectives: [{ dimension: "sprints" }], exercises: [{ drillKey: "starter:repeated-sprints", dimension: "sprints", sessionsPerWeek: 2 }] };

describe("development plans", () => {
  it("turns evidence into priorities and a plan whose baseline is computed on the server", async () => {
    const { owner, player } = await slowPlayer();
    const view = await developmentView(db, owner, player.id, NOW);
    // Every running number is the lowest in each match: the three clearest are listed, with proof.
    expect(view.priorities.map((p) => [p.source, p.confidence])).toEqual([
      ["measured", "strong"],
      ["measured", "strong"],
      ["measured", "strong"],
    ]);
    const top = view.priorities[0];
    expect(top.evidence).toHaveLength(3);
    expect(top.drills.every((d) => d.dimensions.includes(top.dimension))).toBe(true);

    // Extra fields such as a client-sent baseline are ignored.
    const plan = await createPlan(
      db,
      owner,
      player.id,
      { reviewOn: REVIEW, objectives: [{ dimension: top.dimension, baseline: 99 }, { dimension: "sprints" }], exercises: [{ drillKey: top.drills[0].key, dimension: top.dimension, sessionsPerWeek: 2 }, { drillKey: "starter:repeated-sprints", dimension: "sprints", sessionsPerWeek: 1 }] },
      NOW,
    );
    expect(plan).toMatchObject({ startsOn: "2026-10-01", reviewOn: REVIEW, status: "active" });
    const after = await developmentView(db, owner, player.id, NOW);
    const [first, sprints] = after.activePlan!.objectives;
    expect(first).toMatchObject({ dimension: top.dimension, finding: top.finding, evidence: top.evidence });
    expect(first.baseline).toBe(top.goal.kind === "measured" ? top.goal.baseline : null);
    expect(sprints).toMatchObject({ kind: "measured", metric: "sprintsPerHour", baseline: 3, target: 4.6, baselineText: "3.0 per hour" });
    expect(sprints.progress.status).toBe("waiting");
    expect(after.activePlan!.exercises[1]).toMatchObject({ drillKey: "starter:repeated-sprints", sessionsPerWeek: 1, done: 0, planned: 1 });
    expect(after.activePlan!.exercises[1].drill.title).toBe("Repeated sprints: 6 × 30 m");
    expect(after.activePlan!.exercises[1].objectiveId).toBe(sprints.id);

    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.action, "plan.created")));
    expect(audit.targetId).toBe(plan.id);
  });

  it("checks the plan makes sense: one at a time, real drills that train the priority, targets above baseline", async () => {
    const { owner, player } = await slowPlayer();
    await expect(createPlan(db, owner, player.id, { ...sprintPlan, exercises: [{ drillKey: "starter:wall-passing", dimension: "sprints", sessionsPerWeek: 2 }] }, NOW)).rejects.toMatchObject({ status: 422 });
    await expect(createPlan(db, owner, player.id, { ...sprintPlan, exercises: [{ drillKey: "starter:nope", dimension: "sprints", sessionsPerWeek: 2 }] }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(createPlan(db, owner, player.id, { ...sprintPlan, objectives: [{ dimension: "sprints", target: 2 }] }, NOW)).rejects.toMatchObject({ status: 422 });
    await expect(createPlan(db, owner, player.id, { ...sprintPlan, reviewOn: "2026-10-03" }, NOW)).rejects.toMatchObject({ status: 422 });
    await expect(createPlan(db, owner, player.id, { ...sprintPlan, objectives: [{ dimension: "sprints" }, { dimension: "speed" }, { dimension: "stamina" }, { dimension: "workRate" }] }, NOW)).rejects.toMatchObject({ status: 422 });
    const empty = await createPlayer(db, owner, { name: "New" });
    await expect(createPlan(db, owner, empty.id, sprintPlan, NOW)).rejects.toMatchObject({ status: 422 }); // nothing measured yet
    await createPlan(db, owner, player.id, sprintPlan, NOW);
    await expect(createPlan(db, owner, player.id, sprintPlan, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it("staff roles: coaches prescribe, analysts only view, scouts and other workspaces see nothing", async () => {
    const { owner, player } = await slowPlayer();
    const coach = await makeActor(db, "coach", owner.orgId);
    const analyst = await makeActor(db, "analyst", owner.orgId);
    const scout = await makeActor(db, "scout", owner.orgId);
    const outsider = await makeActor(db, "owner");
    await expect(createPlan(db, analyst, player.id, sprintPlan, NOW)).rejects.toMatchObject({ status: 403 });
    const plan = await createPlan(db, coach, player.id, sprintPlan, NOW);
    expect((await developmentView(db, analyst, player.id, NOW)).access).toMatchObject({ canManage: false, canLog: false, staff: true });
    await expect(developmentView(db, scout, player.id, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(developmentView(db, outsider, player.id, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(closePlan(db, outsider, plan.id, { status: "completed" })).rejects.toMatchObject({ status: 404 });
    const outsiderCoach = await makeActor(db, "coach", outsider.orgId);
    await expect(closePlan(db, outsiderCoach, plan.id, { status: "completed" })).rejects.toMatchObject({ status: 404 });
    await expect(addComment(db, outsiderCoach, plan.id, { body: "hi" })).rejects.toMatchObject({ status: 404 });
    const view = await developmentView(db, owner, player.id, NOW);
    await expect(logSession(db, outsiderCoach, plan.id, { exerciseId: view.activePlan!.exercises[0].id, doneOn: "2026-10-01", durationMinutes: 20 }, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it("the plan limit holds even when two plans are created at the same moment", async () => {
    const owner = await makeActor(db, "owner"); // free plan: one active plan
    const a = await createPlayer(db, owner, { name: "A" });
    const b = await createPlayer(db, owner, { name: "B" });
    for (const day of ["2026-09-05", "2026-09-12"]) {
      const { job } = await analysedMatch(owner, day);
      await linkTrack(db, owner, job.id, 1, a.id);
      await linkTrack(db, owner, job.id, 2, b.id);
    }
    const results = await Promise.allSettled([createPlan(db, owner, a.id, sprintPlan, NOW), createPlan(db, owner, b.id, sprintPlan, NOW)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 402 } });
  });

  it("a player logs and reflects on their own plan; nobody else's", async () => {
    const { owner, player } = await slowPlayer();
    const me = await makeActor(db, "player", owner.orgId);
    const otherPlayer = await makeActor(db, "player", owner.orgId);
    await db.update(players).set({ userId: me.userId }).where(eq(players.id, player.id));
    const plan = await createPlan(db, owner, player.id, sprintPlan, NOW);
    const view = await developmentView(db, me, player.id, NOW);
    expect(view.access).toMatchObject({ self: true, canLog: true, canManage: false, canRateAsCoach: false });
    const exerciseId = view.activePlan!.exercises[0].id;

    const log = await logSession(db, me, plan.id, { exerciseId, doneOn: "2026-10-01", durationMinutes: 25, effort: 8, note: "Legs heavy on the last two" }, NOW);
    const coachLog = await logSession(db, owner, plan.id, { exerciseId, doneOn: "2026-10-01", durationMinutes: 20 }, NOW);
    await expect(logSession(db, me, plan.id, { exerciseId, doneOn: "2026-10-02", durationMinutes: 20 }, NOW)).rejects.toMatchObject({ status: 422 }); // future
    await expect(logSession(db, me, plan.id, { exerciseId, doneOn: "2026-09-30", durationMinutes: 20 }, NOW)).rejects.toMatchObject({ status: 422 }); // before the plan
    await expect(logSession(db, me, plan.id, { exerciseId: randomUUID(), doneOn: "2026-10-01", durationMinutes: 20 }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(logSession(db, otherPlayer, plan.id, { exerciseId, doneOn: "2026-10-01", durationMinutes: 20 }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(developmentView(db, otherPlayer, player.id, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(deleteLog(db, me, plan.id, coachLog.id)).rejects.toMatchObject({ status: 403 });

    expect(await addComment(db, me, plan.id, { body: "Felt quicker this week" })).toMatchObject({ authorKind: "player" });
    expect(await addComment(db, owner, plan.id, { body: "Good. Keep the rest times honest." })).toMatchObject({ authorKind: "coach" });
    // A player rates themself; that's a self view, never a coach rating.
    expect(await addObservation(db, me, player.id, { dimension: "scanning", rating: 2 }, NOW)).toMatchObject({ source: "self" });
    await expect(addObservation(db, me, player.id, { dimension: "sprints", rating: 2 }, NOW)).rejects.toMatchObject({ status: 422 }); // measured, not rated

    const after = await developmentView(db, me, player.id, NOW);
    expect(after.activePlan!.training).toMatchObject({ done: 2, planned: 2, minutes: 45, thisWeekDone: 2, thisWeekPlanned: 2 });
    expect(after.activePlan!.comments.map((c) => [c.authorKind, c.mine])).toEqual([
      ["player", true],
      ["coach", false],
    ]);
    await deleteLog(db, me, plan.id, log.id);
    expect((await developmentView(db, me, player.id, NOW)).activePlan!.training.done).toBe(1);
    expect((await squadDevelopment(db, owner, NOW)).get(player.id)).toMatchObject({ thisWeekDone: 1, thisWeekPlanned: 2, reviewDue: false });
  });

  it("measures progress on matches played after the plan started, and keeps closed plans as history", async () => {
    const { owner, player } = await slowPlayer();
    const plan = await createPlan(db, owner, player.id, sprintPlan, NOW);
    const one = await analysedMatch(owner, "2026-10-05");
    await linkTrack(db, owner, one.job.id, 2, player.id); // 2 sprints in 20 minutes: 6 per hour
    let o = (await developmentView(db, owner, player.id, NOW)).activePlan!.objectives[0];
    expect(o.progress).toMatchObject({ status: "early", current: 6, evidence: 1 });
    const two = await analysedMatch(owner, "2026-10-12");
    await linkTrack(db, owner, two.job.id, 2, player.id);
    o = (await developmentView(db, owner, player.id, NOW)).activePlan!.objectives[0];
    expect(o.progress).toMatchObject({ status: "reached", current: 6, change: 3, evidence: 2 });

    await closePlan(db, owner, plan.id, { status: "completed", closingNote: "Target reached in two matches." });
    const view = await developmentView(db, owner, player.id, new Date("2026-10-20T12:00:00Z"));
    expect(view.activePlan).toBeNull();
    expect(view.pastPlans[0]).toMatchObject({ status: "completed", closingNote: "Target reached in two matches." });
    await expect(logSession(db, owner, plan.id, { exerciseId: view.pastPlans[0].exercises[0].id, doneOn: "2026-10-12", durationMinutes: 20 }, NOW)).rejects.toMatchObject({ status: 409 });
    await expect(closePlan(db, owner, plan.id, { status: "completed" })).rejects.toMatchObject({ status: 409 });
  });

  it("coach ratings feed priorities and observed objectives; matches from another workspace are refused", async () => {
    const { owner, player } = await slowPlayer();
    const outsider = await makeActor(db, "owner");
    const theirMatch = await createMatch(db, outsider, { title: "Theirs" });
    await expect(addObservation(db, owner, player.id, { dimension: "scanning", rating: 2, matchId: theirMatch.id }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(addObservation(db, outsider, player.id, { dimension: "scanning", rating: 2 }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(addObservation(db, owner, player.id, { dimension: "scanning", rating: 2, observedOn: "2026-10-09" }, NOW)).rejects.toMatchObject({ status: 422 });
    await addObservation(db, owner, player.id, { dimension: "scanning", rating: 2, note: "Rarely checks before receiving", observedOn: "2026-09-20" }, NOW);
    const view = await developmentView(db, owner, player.id, NOW);
    const scanning = view.priorities.find((p) => p.dimension === "scanning")!;
    expect(scanning).toMatchObject({ source: "observed", confidence: "moderate" });

    await createPlan(db, owner, player.id, { reviewOn: REVIEW, objectives: [{ dimension: "scanning" }], exercises: [{ drillKey: "starter:scan-cue", dimension: "scanning", sessionsPerWeek: 3 }] }, NOW);
    let o = (await developmentView(db, owner, player.id, NOW)).activePlan!.objectives[0];
    expect(o).toMatchObject({ kind: "observed", baseline: 2, target: 3, baselineText: "2/5" });
    await addObservation(db, owner, player.id, { dimension: "scanning", rating: 3 }, NOW);
    o = (await developmentView(db, owner, player.id, NOW)).activePlan!.objectives[0];
    expect(o.progress.status).toBe("reached");
  });

  it("coaches add their own drills; they stay in their workspace", async () => {
    const { owner, player } = await slowPlayer();
    const analyst = await makeActor(db, "analyst", owner.orgId);
    const drill = {
      title: "Hill sprints",
      summary: "Short uphill sprints for acceleration.",
      dimensions: ["sprints"],
      difficulty: "intermediate",
      durationMinutes: 20,
      players: "1",
      equipment: [],
      space: "A 20 m slope",
      steps: ["Sprint 15 m uphill, walk down. 8 reps."],
      successCriteria: "Eight strong reps.",
    };
    await expect(createDrill(db, analyst, drill)).rejects.toMatchObject({ status: 403 });
    await expect(createDrill(db, owner, { ...drill, dimensions: ["telepathy"] })).rejects.toMatchObject({ status: 422 });
    const { key } = await createDrill(db, owner, drill);
    expect((await library(db, analyst))[0]).toMatchObject({ key, title: "Hill sprints", source: "custom" });
    const outsider = await makeActor(db, "owner");
    expect((await library(db, outsider)).some((d) => d.key === key)).toBe(false);
    await expect(archiveDrill(db, outsider, key)).rejects.toMatchObject({ status: 404 });
    // Another club can't put this drill in their plans.
    const theirs = await slowPlayer();
    await expect(createPlan(db, theirs.owner, theirs.player.id, { ...sprintPlan, exercises: [{ drillKey: key, dimension: "sprints", sessionsPerWeek: 1 }] }, NOW)).rejects.toMatchObject({ status: 404 });
    const plan = await createPlan(db, owner, player.id, { ...sprintPlan, exercises: [{ drillKey: key, dimension: "sprints", sessionsPerWeek: 1 }] }, NOW);
    await archiveDrill(db, owner, key);
    // The plan keeps the copy it was given.
    expect((await developmentView(db, owner, player.id, NOW)).activePlan!.exercises[0].drill.title).toBe("Hill sprints");
    expect(plan.status).toBe("active");
  });
});
