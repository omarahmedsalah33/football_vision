import { and, eq, sql } from "drizzle-orm";
import { assertCan, type Actor } from "../authz/permissions";
import { getEntitlements, getUsage, usagePeriodStart } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { memberships, organizations, plans } from "../db/schema";

/** Allowances this large are effectively unlimited (staff testing plan). */
const UNLIMITED = 10_000;

/**
 * What every member may see about their workspace: its kind, plan and this month's analyses.
 * Billing details (storage, limits per plan, invoices) stay on the settings page for billing roles.
 */
export async function workspaceOverview(db: DbOrTx, actor: Actor, now = new Date()) {
  assertCan(actor, "match.read");
  const ent = await getEntitlements(db, actor.orgId, now);
  const [[org], [plan], usage, [members]] = await Promise.all([
    db.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, actor.orgId)),
    db.select({ name: plans.name }).from(plans).where(eq(plans.id, ent.planId)),
    getUsage(db, actor.orgId, usagePeriodStart(now)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.status, "active"))),
  ]);
  const limit = ent.limits.monthlyAnalyses;
  return {
    kind: org?.kind ?? "personal",
    planId: ent.planId,
    planName: plan?.name ?? ent.planId,
    analyses: { used: usage.used, inProgress: usage.reserved, limit, unlimited: limit >= UNLIMITED },
    members: { count: members?.n ?? 1, limit: ent.limits.maxMembers },
  };
}

export type WorkspaceOverview = Awaited<ReturnType<typeof workspaceOverview>>;
