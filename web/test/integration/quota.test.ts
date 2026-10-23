import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getEntitlements, getUsage, usagePeriodStart } from "../../src/server/billing/entitlements";
import { analysisJobs, subscriptions, videos } from "../../src/server/db/schema";
import { cancelAnalysis, enqueueAnalysis } from "../../src/server/jobs/service";
import { createMatch } from "../../src/server/matches/service";
import type { Actor } from "../../src/server/authz/permissions";
import { makeActor, testDb } from "../helpers";

const db = testDb();

async function readyMatch(actor: Actor) {
  const match = await createMatch(db, actor, { title: `Match ${randomUUID().slice(0, 4)}` });
  await db.insert(videos).values({
    orgId: actor.orgId,
    matchId: match.id,
    storageKey: `test/${randomUUID()}`,
    declaredSizeBytes: 100,
    sizeBytes: 100,
    partSizeBytes: 100,
    partCount: 1,
    status: "uploaded",
    createdBy: actor.userId,
  });
  return match;
}

const period = usagePeriodStart();

describe("analysis quota", () => {
  it("free plan: concurrent requests on different matches cannot exceed the monthly allowance", async () => {
    const actor = await makeActor(db, "owner");
    const limit = (await getEntitlements(db, actor.orgId)).limits.monthlyAnalyses;
    const ms = await Promise.all(Array.from({ length: limit + 4 }, () => readyMatch(actor)));

    const results = await Promise.allSettled(ms.map((m) => enqueueAnalysis(db, actor, m.id)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(ok).toHaveLength(limit);
    for (const r of rejected) expect(r.reason).toMatchObject({ status: 402, code: "quota_exceeded" });
    expect(await getUsage(db, actor.orgId, period)).toEqual({ used: 0, reserved: limit });
  });

  it("double-clicking 'analyse' creates one job and reserves once", async () => {
    const actor = await makeActor(db, "owner");
    await db.insert(subscriptions).values({ orgId: actor.orgId, planId: "coach_pro", status: "active" });
    const match = await readyMatch(actor);

    const jobs = await Promise.all(Array.from({ length: 6 }, () => enqueueAnalysis(db, actor, match.id)));
    expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
    expect(await getUsage(db, actor.orgId, period)).toEqual({ used: 0, reserved: 1 });
  });

  it("cancelling a queued job releases its reservation exactly once", async () => {
    const actor = await makeActor(db, "owner");
    const match = await readyMatch(actor);
    const job = await enqueueAnalysis(db, actor, match.id);
    expect((await getUsage(db, actor.orgId, period)).reserved).toBe(1);

    await Promise.all([cancelAnalysis(db, actor, job.id), cancelAnalysis(db, actor, job.id)]);
    expect(await getUsage(db, actor.orgId, period)).toEqual({ used: 0, reserved: 0 });
    const [row] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, job.id));
    expect(row).toMatchObject({ status: "cancelled", usageSettled: true });
  });

  it("an expired paid subscription falls back to free limits", async () => {
    const actor = await makeActor(db, "owner");
    await db.insert(subscriptions).values({
      orgId: actor.orgId,
      planId: "club",
      status: "active",
      currentPeriodEnd: new Date(Date.now() - 60_000),
    });
    const ent = await getEntitlements(db, actor.orgId);
    expect(ent).toMatchObject({ planId: "free", paidActive: false });
  });

  it("canceled subscriptions do not keep paid limits, active ones do, overrides apply", async () => {
    const canceled = await makeActor(db, "owner");
    await db.insert(subscriptions).values({ orgId: canceled.orgId, planId: "club", status: "canceled" });
    expect((await getEntitlements(db, canceled.orgId)).planId).toBe("free");

    const enterprise = await makeActor(db, "owner");
    await db.insert(subscriptions).values({
      orgId: enterprise.orgId,
      planId: "enterprise",
      status: "active",
      limitOverrides: { monthlyAnalyses: 500 },
    });
    expect((await getEntitlements(db, enterprise.orgId)).limits.monthlyAnalyses).toBe(500);
  });

  it("cannot queue analysis before a video is uploaded", async () => {
    const actor = await makeActor(db, "owner");
    const match = await createMatch(db, actor, { title: "No video" });
    await expect(enqueueAnalysis(db, actor, match.id)).rejects.toMatchObject({ status: 409 });
    expect(await getUsage(db, actor.orgId, period)).toEqual({ used: 0, reserved: 0 });
  });
});
