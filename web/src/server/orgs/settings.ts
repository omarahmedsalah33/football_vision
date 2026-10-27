import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { assertCan, type Actor } from "../authz/permissions";
import { getEntitlements, getUsage, usagePeriodStart } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { auditEvents, memberships, organizations, users, videos } from "../db/schema";
import { conflict, forbidden, invalidInput, notFound } from "../http/errors";

export const renameOrgInput = z.object({ name: z.string().trim().min(2).max(80) });
export const deleteOrgInput = z.object({ confirmName: z.string().max(80) });

export async function renameOrg(db: DbOrTx, actor: Actor, input: z.infer<typeof renameOrgInput>) {
  assertCan(actor, "org.manage");
  await db.transaction(async (tx) => {
    const [org] = await tx
      .update(organizations)
      .set({ name: input.name })
      .where(and(eq(organizations.id, actor.orgId), isNull(organizations.deletedAt)))
      .returning({ id: organizations.id });
    if (!org) throw notFound("Workspace");
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "org.renamed", metadata: { name: input.name } });
  });
}

/**
 * Deletes a club workspace (owners only; the caller must also have passed a recent-verification
 * check). Typing the exact name guards against deleting the wrong workspace. Footage and data are
 * purged by the worker after a grace period.
 */
export async function deleteOrg(db: DbOrTx, actor: Actor, input: z.infer<typeof deleteOrgInput>) {
  assertCan(actor, "org.delete");
  await db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, actor.orgId), isNull(organizations.deletedAt)))
      .for("update");
    if (!org) throw notFound("Workspace");
    if (org.kind === "personal") throw conflict("Your personal workspace is deleted together with your account.");
    if (input.confirmName.trim() !== org.name) throw invalidInput("Type the workspace name exactly to confirm.");
    await tx.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, org.id));
    await recordAudit(tx, { orgId: org.id, actorUserId: actor.userId, action: "org.deleted" });
  });
}

/** Plan, limits and current consumption, for the workspace usage dashboard. */
export async function usageSummary(db: DbOrTx, actor: Actor, now = new Date()) {
  assertCan(actor, "billing.manage");
  const ent = await getEntitlements(db, actor.orgId, now);
  const period = usagePeriodStart(now);
  const usage = await getUsage(db, actor.orgId, period);
  const [storage] = await db
    .select({ bytes: sql<string>`coalesce(sum(${videos.sizeBytes}), 0)::text`, count: sql<number>`count(*)::int` })
    .from(videos)
    .where(and(eq(videos.orgId, actor.orgId), inArray(videos.status, ["uploaded", "validated"])));
  const [members] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.status, "active")));
  return {
    planId: ent.planId,
    paidActive: ent.paidActive,
    limits: ent.limits,
    period,
    analyses: { used: usage.used, inProgress: usage.reserved, limit: ent.limits.monthlyAnalyses, unlimited: ent.unlimitedAnalyses },
    storage: { bytes: Number(storage.bytes), videos: storage.count },
    members: { count: members.n, limit: ent.limits.maxMembers },
  };
}

export async function auditLog(db: DbOrTx, actor: Actor, limit = 50) {
  if (!(actor.role === "owner" || actor.role === "admin")) throw forbidden();
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      createdAt: auditEvents.createdAt,
      actorName: users.displayName,
      targetType: auditEvents.targetType,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(eq(auditEvents.orgId, actor.orgId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}
