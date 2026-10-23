import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db/client";
import { plans, subscriptions, usagePeriods } from "../db/schema";

export const planLimitsSchema = z.object({
  monthlyAnalyses: z.number().int().min(0),
  maxUploadBytes: z.number().int().positive(),
  maxVideoDurationSeconds: z.number().int().positive(),
  maxMembers: z.number().int().positive(),
  maxTeams: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export type Entitlements = {
  planId: string;
  /** Whether the paid plan is currently in force; otherwise the free plan applies. */
  paidActive: boolean;
  limits: PlanLimits;
};

const FALLBACK_PLAN = "free";
// Statuses that keep paid entitlements. past_due is a grace period; the payment provider
// integration (phase 5) moves it to expired when the grace window ends.
const ENTITLED_STATUSES = new Set(["trialing", "active", "past_due"]);

/**
 * Resolves the limits that apply to an organization right now. Only server-side state is
 * consulted (subscription row written by verified billing events), never client input.
 */
export async function getEntitlements(db: DbOrTx, orgId: string, now = new Date()): Promise<Entitlements> {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
  const inForce =
    !!sub && ENTITLED_STATUSES.has(sub.status) && (!sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() > now.getTime());
  const planId = inForce ? sub.planId : FALLBACK_PLAN;

  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw new Error(`Plan ${planId} is not configured`);
  const merged = { ...(plan.limits as object), ...(inForce ? (sub.limitOverrides as object) : {}) };
  return { planId, paidActive: inForce, limits: planLimitsSchema.parse(merged) };
}

/** Usage periods are calendar months (UTC) until billing anchors exist. Returns YYYY-MM-01. */
export function usagePeriodStart(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function getUsage(db: DbOrTx, orgId: string, periodStart: string) {
  const [row] = await db
    .select()
    .from(usagePeriods)
    .where(and(eq(usagePeriods.orgId, orgId), eq(usagePeriods.periodStart, periodStart)));
  return { used: row?.analysesUsed ?? 0, reserved: row?.analysesReserved ?? 0 };
}

/**
 * Atomically reserves one analysis against the monthly allowance. The conditional UPDATE is a
 * single statement, so concurrent requests cannot both take the last unit. Returns false when the
 * allowance is exhausted. Must run in the same transaction that creates the job.
 */
export async function reserveAnalysis(tx: DbOrTx, orgId: string, periodStart: string, limit: number): Promise<boolean> {
  await tx.insert(usagePeriods).values({ orgId, periodStart }).onConflictDoNothing();
  const updated = await tx
    .update(usagePeriods)
    .set({ analysesReserved: sql`${usagePeriods.analysesReserved} + 1` })
    .where(
      and(
        eq(usagePeriods.orgId, orgId),
        eq(usagePeriods.periodStart, periodStart),
        sql`${usagePeriods.analysesUsed} + ${usagePeriods.analysesReserved} < ${limit}`,
      ),
    )
    .returning({ orgId: usagePeriods.orgId });
  return updated.length === 1;
}

/** Returns a reservation without consuming it (job cancelled or failed before producing results). */
export async function releaseAnalysis(tx: DbOrTx, orgId: string, periodStart: string): Promise<void> {
  await tx
    .update(usagePeriods)
    .set({ analysesReserved: sql`greatest(${usagePeriods.analysesReserved} - 1, 0)` })
    .where(and(eq(usagePeriods.orgId, orgId), eq(usagePeriods.periodStart, periodStart)));
}
