import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { playerLabelsFor, setPlayerLabel } from "../../src/server/analysis/players";
import { analysisJobs, analysisTracks, videos } from "../../src/server/db/schema";
import { createMatch } from "../../src/server/matches/service";
import type { Actor } from "../../src/server/authz/permissions";
import { makeActor, testDb } from "../helpers";

const db = testDb();

async function analysedMatch(actor: Actor) {
  const match = await createMatch(db, actor, { title: "Derby" });
  const [video] = await db
    .insert(videos)
    .values({ orgId: actor.orgId, matchId: match.id, storageKey: `t/${randomUUID()}`, declaredSizeBytes: 10, partSizeBytes: 10, partCount: 1, status: "validated" })
    .returning();
  const [job] = await db
    .insert(analysisJobs)
    .values({ orgId: actor.orgId, matchId: match.id, videoId: video.id, kind: "analyze", idempotencyKey: `k-${randomUUID()}`, status: "succeeded", usagePeriodStart: "2026-10-01" })
    .returning();
  await db.insert(analysisTracks).values({
    jobId: job.id,
    orgId: actor.orgId,
    trackNo: 7,
    team: "a",
    firstSeconds: 0,
    lastSeconds: 600,
    coverage: 0.9,
    heatmap: [],
    metrics: { minutes: 9.5, distance_m: 1100 },
  });
  return job;
}

describe("naming tracked players", () => {
  it("staff can name a player; saving again updates the same record", async () => {
    const owner = await makeActor(db, "owner");
    const job = await analysedMatch(owner);
    const coach = await makeActor(db, "coach", owner.orgId);
    await setPlayerLabel(db, coach, job.id, 7, { name: "Omar Hassan", shirtNumber: 10 });
    await setPlayerLabel(db, coach, job.id, 7, { name: "Omar H.", shirtNumber: 9 });
    expect(await playerLabelsFor(db, owner, job.id)).toEqual([{ trackNo: 7, name: "Omar H.", shirtNumber: 9 }]);
  });

  it("read-only roles can see names but not change them; other clubs see nothing", async () => {
    const owner = await makeActor(db, "owner");
    const job = await analysedMatch(owner);
    await setPlayerLabel(db, owner, job.id, 7, { name: "Ali", shirtNumber: null });
    const scout = await makeActor(db, "scout", owner.orgId);
    expect(await playerLabelsFor(db, scout, job.id)).toHaveLength(1);
    await expect(setPlayerLabel(db, scout, job.id, 7, { name: "X", shirtNumber: null })).rejects.toMatchObject({ status: 403 });

    const other = await makeActor(db, "owner");
    await expect(setPlayerLabel(db, other, job.id, 7, { name: "X", shirtNumber: null })).rejects.toMatchObject({ status: 404 });
    expect(await playerLabelsFor(db, other, job.id)).toEqual([]);
  });

  it("unknown players can't be named", async () => {
    const owner = await makeActor(db, "owner");
    const job = await analysedMatch(owner);
    await expect(setPlayerLabel(db, owner, job.id, 99, { name: "Ghost", shirtNumber: null })).rejects.toMatchObject({ status: 404 });
  });
});
