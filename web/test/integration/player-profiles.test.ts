import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/server/authz/permissions";
import { analysisJobs, analysisResults, analysisTracks, matches, users, videos } from "../../src/server/db/schema";
import { completeOnboarding } from "../../src/server/onboarding/service";
import { ensureUser, resolveActor } from "../../src/server/orgs/service";
import { archivePlayer, createPlayer, linkTrack, listPlayers, myPlayer, profileStats, updatePlayer } from "../../src/server/players/service";
import { createMatch } from "../../src/server/matches/service";
import { makeActor, testDb } from "../helpers";

const db = testDb();

/** A match with a succeeded analysis of six tracked players (team A: 1–3, team B: 4–6). */
async function analysedMatch(actor: Actor, opts: { title?: string; playedOn?: string; speed?: number } = {}) {
  const match = await createMatch(db, actor, { title: opts.title ?? "League", playedOn: opts.playedOn });
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
    const fast = n === 2 ? (opts.speed ?? 8.5) : 6 + n * 0.1;
    await db.insert(analysisTracks).values({
      jobId: job.id,
      orgId: actor.orgId,
      trackNo: n,
      team: n <= 3 ? "a" : "b",
      firstSeconds: 0,
      lastSeconds: 1200,
      coverage: 0.9,
      avgX: n <= 3 ? 30 : 75,
      avgY: 34,
      heatmap: [[1]],
      metrics: { minutes: 20, distance_m: 2000 + n * 100, distance_per_min: 100 + n * 5, hi_per_min: n, hi_distance_m: n * 20, sprints: n, sprints_per_10min: n / 2, top_speed_ms: fast, late_vs_early: null },
    });
  }
  return { match, job };
}

describe("player profiles", () => {
  it("staff manage the squad; read-only roles can only look", async () => {
    const owner = await makeActor(db, "owner");
    const coach = await makeActor(db, "coach", owner.orgId);
    const scout = await makeActor(db, "scout", owner.orgId);
    const p = await createPlayer(db, coach, { name: "Omar Hassan", position: "midfielder", shirtNumber: 10 });
    await updatePlayer(db, coach, p.id, { name: "Omar Hassan", position: "forward", shirtNumber: 9, preferredFoot: "left" });
    expect((await listPlayers(db, scout)).map((x) => [x.name, x.position, x.shirtNumber])).toEqual([["Omar Hassan", "forward", 9]]);
    await expect(createPlayer(db, scout, { name: "X" })).rejects.toMatchObject({ status: 403 });
    await expect(archivePlayer(db, scout, p.id)).rejects.toMatchObject({ status: 403 });
    await archivePlayer(db, coach, p.id);
    expect(await listPlayers(db, owner)).toEqual([]);
  });

  it("validates details and keeps data minimal", async () => {
    const owner = await makeActor(db, "owner");
    await expect(createPlayer(db, owner, { name: "  " })).rejects.toMatchObject({ status: 422 });
    await expect(createPlayer(db, owner, { name: "Kid", birthYear: new Date().getUTCFullYear() })).rejects.toMatchObject({ status: 422 });
    await expect(createPlayer(db, owner, { name: "X", shirtNumber: 120 })).rejects.toMatchObject({ status: 422 });
  });

  it("other workspaces can't see, edit or link a profile", async () => {
    const owner = await makeActor(db, "owner");
    const p = await createPlayer(db, owner, { name: "Ali" });
    const { job } = await analysedMatch(owner);
    const other = await makeActor(db, "owner");
    expect(await listPlayers(db, other)).toEqual([]);
    await expect(updatePlayer(db, other, p.id, { name: "Hacked" })).rejects.toMatchObject({ status: 404 });
    await expect(linkTrack(db, other, job.id, 2, null)).rejects.toMatchObject({ status: 404 });
    // Linking to a player from another club fails even inside one's own analysis.
    const theirs = await createPlayer(db, other, { name: "Theirs" });
    await expect(linkTrack(db, owner, job.id, 2, theirs.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a player's own profile lives in their personal workspace, once", async () => {
    const user = await ensureUser(db, { subject: `clerk_${randomUUID()}`, email: "p@example.com", displayName: "Pat" });
    const club = await makeActor(db, "owner");
    const clubActor = { ...club, userId: user.id };
    await expect(createPlayer(db, clubActor, { name: "Pat" }, { me: true })).rejects.toMatchObject({ status: 422 });

    const { next } = await completeOnboarding(db, user.id, { persona: "player", profile: { name: "Pat", position: "defender", preferredFoot: "right", shirtNumber: 4, birthYear: 2008, clubName: "Nile FC" } });
    expect(next).toMatch(/^\/app\/me-[^/]+\/players\/[0-9a-f-]{36}$/);
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u).toMatchObject({ persona: "player" });
    expect(u.onboardedAt).not.toBeNull();
    const personalSlug = next.split("/")[2];
    const me = await resolveActor(db, user.id, personalSlug);
    expect(await myPlayer(db, me)).toMatchObject({ name: "Pat", clubName: "Nile FC", birthYear: 2008, userId: user.id });
    await expect(createPlayer(db, me, { name: "Pat again" }, { me: true })).rejects.toMatchObject({ status: 409 });
    // Onboarding again doesn't create a second profile.
    const again = await completeOnboarding(db, user.id, { persona: "player", profile: { name: "Pat" } });
    expect(again.next).toBe(next);
  });

  it("a profile is built from linked tracks, using only each match's latest analysis", async () => {
    const owner = await makeActor(db, "owner");
    const p = await createPlayer(db, owner, { name: "Sprinter" });
    const first = await analysedMatch(owner, { title: "Matchday 1", playedOn: "2026-09-01", speed: 9 });
    const second = await analysedMatch(owner, { title: "Matchday 2", playedOn: "2026-09-08", speed: 9.5 });
    await linkTrack(db, owner, first.job.id, 2, p.id);
    await linkTrack(db, owner, second.job.id, 2, p.id);

    let stats = (await profileStats(db, owner, [p.id])).get(p.id)!.stats;
    expect(stats.totals).toMatchObject({ matches: 2, minutes: 40, sprints: 4, topSpeedKmh: 34.2, topSpeedMatch: "Matchday 2", scoredMatches: 2 });
    expect(stats.matches.map((m) => m.title)).toEqual(["Matchday 2", "Matchday 1"]);
    expect(stats.strengths.map((s) => s.key)).toContain("speed");

    // A re-run of matchday 1 replaces its old result: the old link no longer counts.
    const [rerun] = await db
      .insert(analysisJobs)
      .values({ orgId: owner.orgId, matchId: first.match.id, videoId: first.job.videoId, kind: "analyze", idempotencyKey: `k-${randomUUID()}`, status: "succeeded", usagePeriodStart: "2026-10-01", finishedAt: new Date(Date.now() + 60_000) })
      .returning();
    await db.insert(analysisResults).values({ jobId: rerun.id, orgId: owner.orgId, matchId: first.match.id, summary: { pitch: { length: 105, width: 68 } } });
    stats = (await profileStats(db, owner, [p.id])).get(p.id)!.stats;
    expect(stats.totals.matches).toBe(1);

    // Deleted matches drop out of profiles.
    await db.update(matches).set({ deletedAt: new Date() }).where(eq(matches.id, second.match.id));
    stats = (await profileStats(db, owner, [p.id])).get(p.id)!.stats;
    expect(stats.totals.matches).toBe(0);
  });

  it("unlinking removes the match from the profile", async () => {
    const owner = await makeActor(db, "owner");
    const p = await createPlayer(db, owner, { name: "Ali" });
    const { job } = await analysedMatch(owner);
    await linkTrack(db, owner, job.id, 3, p.id);
    expect((await profileStats(db, owner, [p.id])).get(p.id)!.stats.totals.matches).toBe(1);
    await linkTrack(db, owner, job.id, 3, null);
    expect((await profileStats(db, owner, [p.id])).get(p.id)!.stats.totals.matches).toBe(0);
  });
});
