import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "@/server/db/client";
import { auditEvents, matches, memberships, organizations, users, usagePeriods, videos } from "@/server/db/schema";
import { getEntitlements, getUsage, reserveAnalysis, releaseAnalysis, usagePeriodStart } from "@/server/billing/entitlements";
import { hasUnlimitedTrial, isUnlimitedTrialEmail } from "@/server/billing/trial-exceptions";
import { workspaceOverview } from "@/server/orgs/overview";
import { cancelAnalysis, enqueueAnalysis } from "@/server/jobs/service";

const getUser = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { getUser } }) }));

describe("unlimited trial email policy", () => {
  it("matches only the two exact addresses, case-insensitively", () => {
    expect(isUnlimitedTrialEmail("MOHAMEDMOSTAFA1505@gmail.com")).toBe(true);
    expect(isUnlimitedTrialEmail("omarahmedsalah33@gmail.com")).toBe(true);
    expect(isUnlimitedTrialEmail("mohamedmostafa1505+other@gmail.com")).toBe(false);
    expect(isUnlimitedTrialEmail("someone@example.com")).toBe(false);
    expect(isUnlimitedTrialEmail(null)).toBe(false);
  });
});

const url = process.env.WORKER_API_INTEGRATION_TEST_DATABASE_URL;
describe.skipIf(!url)("unlimited trial (isolated PostgreSQL tenants)", () => {
  const { db, pool } = createDb(url!);
  const orgIds: string[] = [];
  const userIds: string[] = [];
  beforeEach(() => { getUser.mockReset(); });
  afterAll(async () => {
    for (const id of orgIds) await db.delete(organizations).where(eq(organizations.id, id));
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
    await pool.end();
  });
  async function fixture(email: string | null, kind: "personal" | "club" = "club") {
    const [user] = await db.insert(users).values({ authSubject: `trial-test-${randomUUID()}`, email }).returning();
    userIds.push(user.id);
    const [org] = await db.insert(organizations).values({
      name: "Unlimited trial test", slug: `trial-test-${randomUUID()}`, kind,
      personalOwnerId: kind === "personal" ? user.id : null,
    }).returning();
    orgIds.push(org.id);
    await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    if (kind === "club") await db.insert(auditEvents).values({ orgId: org.id, actorUserId: user.id, action: "org.created" });
    return { user, org, actor: { orgId: org.id, userId: user.id, role: "owner" as const } };
  }
  function verified(email: string) {
    getUser.mockResolvedValue({ emailAddresses: [{ emailAddress: email, verification: { status: "verified" } }] });
  }
  it.each([
    ["mohamedmostafa1505@gmail.com", "personal"],
    ["omarahmedsalah33@gmail.com", "club"],
  ] as const)("applies dynamically to existing %s workspaces (%s), without changing the plan", async (email, kind) => {
    const { org, actor } = await fixture(email, kind);
    verified(email);
    const ent = await getEntitlements(db, org.id);
    expect(ent).toMatchObject({ planId: "free", unlimitedAnalyses: true });
    expect(ent.limits.monthlyAnalyses).toBeLessThan(100);
    expect((await workspaceOverview(db, actor)).analyses.unlimited).toBe(true);
  });
  it("covers a new club created by the same account", async () => {
    const { org } = await fixture("omarahmedsalah33@gmail.com");
    verified("omarahmedsalah33@gmail.com");
    const [newOrg] = await db.insert(organizations).values({
      name: "Future club test", slug: `trial-test-${randomUUID()}`, kind: "club",
    }).returning();
    orgIds.push(newOrg.id);
    const [creation] = await db.select().from(auditEvents).where(eq(auditEvents.orgId, org.id));
    await db.insert(auditEvents).values({ orgId: newOrg.id, actorUserId: creation.actorUserId, action: "org.created" });
    expect(await hasUnlimitedTrial(db, newOrg.id)).toBe(true);
  });
  it("does not grant the exception to unrelated workspaces, even if an eligible account becomes an owner", async () => {
    const normal = await fixture("ordinary@example.com");
    const eligible = await fixture("omarahmedsalah33@gmail.com");
    await db.insert(memberships).values({ orgId: normal.org.id, userId: eligible.user.id, role: "owner" });
    expect(await hasUnlimitedTrial(db, normal.org.id)).toBe(false);
    expect(getUser).not.toHaveBeenCalled();
  });
  it("requires a verified matching email, not just the stored address", async () => {
    const { org } = await fixture("omarahmedsalah33@gmail.com");
    getUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "omarahmedsalah33@gmail.com", verification: { status: "unverified" } }] });
    expect(await hasUnlimitedTrial(db, org.id)).toBe(false);
    verified("different@example.com");
    expect(await hasUnlimitedTrial(db, org.id)).toBe(false);
    getUser.mockRejectedValue(new Error("Identity service unavailable"));
    await expect(hasUnlimitedTrial(db, org.id)).rejects.toMatchObject({ message: "Identity service unavailable" });
  });
  it("reserves and refunds normally beyond the free quota, while other workspaces remain capped", async () => {
    const { org } = await fixture("mohamedmostafa1505@gmail.com");
    verified("mohamedmostafa1505@gmail.com");
    const ent = await getEntitlements(db, org.id);
    const period = usagePeriodStart();
    await db.insert(usagePeriods).values({ orgId: org.id, periodStart: period, analysesUsed: 100000 });
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      db.transaction((tx) => reserveAnalysis(tx, org.id, period, ent.limits.monthlyAnalyses, ent.unlimitedAnalyses))));
    expect(results).toEqual([true, true, true, true]);
    expect(await getUsage(db, org.id, period)).toEqual({ used: 100000, reserved: 4 });
    await releaseAnalysis(db, org.id, period);
    expect((await getUsage(db, org.id, period)).reserved).toBe(3);
    expect(await reserveAnalysis(db, org.id, period, 1)).toBe(false);
  });
  it("does not infer a creator from owner membership when creation provenance is absent", async () => {
    const { org } = await fixture("omarahmedsalah33@gmail.com");
    await db.delete(auditEvents).where(eq(auditEvents.orgId, org.id));
    expect(await hasUnlimitedTrial(db, org.id)).toBe(false);
  });
  it("queues analysis after the allowance is exhausted and releases the reservation on cancellation", async () => {
    const { org, actor } = await fixture("omarahmedsalah33@gmail.com");
    verified("omarahmedsalah33@gmail.com");
    const period = usagePeriodStart();
    await db.insert(usagePeriods).values({ orgId: org.id, periodStart: period, analysesUsed: 100000 });
    const [match] = await db.insert(matches).values({ orgId: org.id, title: "Synthetic quota test" }).returning();
    await db.insert(videos).values({
      orgId: org.id, matchId: match.id, storageKey: `trial-test/${randomUUID()}`,
      status: "validated", declaredSizeBytes: 100, sizeBytes: 100, partSizeBytes: 100, partCount: 1,
      durationSeconds: 12,
    });
    const job = await enqueueAnalysis(db, actor, match.id, new Date(), "llm", true);
    expect(job.status).toBe("queued");
    expect(job.config).toMatchObject({ engine: "llm", playerTracking: true });
    expect((await getUsage(db, org.id, period)).reserved).toBe(1);
    expect((await enqueueAnalysis(db, actor, match.id)).id).toBe(job.id);
    await cancelAnalysis(db, actor, job.id);
    expect(await getUsage(db, org.id, period)).toEqual({ used: 100000, reserved: 0 });
  });
});
