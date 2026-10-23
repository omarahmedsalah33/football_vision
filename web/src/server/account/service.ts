import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { recordAudit } from "../audit";
import type { DbOrTx } from "../db/client";
import { memberships, organizations, users } from "../db/schema";
import { AppError } from "../http/errors";

export type DeletionPlan = {
  /** Workspaces deleted with the account: the personal one and clubs where the user is alone. */
  deleteOrgs: { id: string; name: string }[];
  /** Workspaces the user simply leaves (someone else stays to own them). */
  leaveOrgs: { id: string; name: string }[];
  /** Workspaces that block deletion: the user is the only owner but others are still members. */
  blockers: { id: string; name: string }[];
};

/** Works out what deleting this account would do, without changing anything. */
export async function planAccountDeletion(db: DbOrTx, userId: string): Promise<DeletionPlan> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      kind: organizations.kind,
      role: memberships.role,
      otherMembers: sql<number>`(select count(*)::int from memberships m2 where m2.org_id = ${organizations.id} and m2.user_id <> ${userId} and m2.status = 'active')`,
      otherOwners: sql<number>`(select count(*)::int from memberships m3 where m3.org_id = ${organizations.id} and m3.user_id <> ${userId} and m3.status = 'active' and m3.role = 'owner')`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), isNull(organizations.deletedAt)));

  const plan: DeletionPlan = { deleteOrgs: [], leaveOrgs: [], blockers: [] };
  for (const r of rows) {
    const ref = { id: r.id, name: r.name };
    if (r.kind === "personal" || r.otherMembers === 0) plan.deleteOrgs.push(ref);
    else if (r.role !== "owner" || r.otherOwners > 0) plan.leaveOrgs.push(ref);
    else plan.blockers.push(ref);
  }
  return plan;
}

/**
 * Deletes the account locally: workspaces it alone owns are soft-deleted (their footage is purged by
 * the worker's maintenance sweep), memberships are removed and personal details are erased. The
 * identity-provider account is deleted by the caller after this commits. Idempotent.
 */
export async function deleteAccount(db: DbOrTx, userId: string, now = new Date()): Promise<DeletionPlan> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user) throw new AppError(404, "not_found", "Account not found.");
    if (user.deletedAt) return { deleteOrgs: [], leaveOrgs: [], blockers: [] };

    const plan = await planAccountDeletion(tx, userId);
    if (plan.blockers.length > 0) {
      throw new AppError(
        409,
        "ownership_transfer_required",
        `Make someone else an owner of ${plan.blockers.map((b) => b.name).join(", ")} before deleting your account.`,
        { workspaces: plan.blockers },
      );
    }

    for (const org of plan.deleteOrgs) {
      await tx.update(organizations).set({ deletedAt: now }).where(eq(organizations.id, org.id));
      await recordAudit(tx, { orgId: org.id, actorUserId: userId, action: "org.deleted", metadata: { reason: "account_deleted" } });
    }
    await tx.delete(memberships).where(eq(memberships.userId, userId));
    for (const org of plan.leaveOrgs) {
      await recordAudit(tx, { orgId: org.id, actorUserId: userId, action: "member.left", metadata: { reason: "account_deleted" } });
    }
    // Erase personal details; the row stays only so foreign keys (e.g. "created by") resolve to an
    // anonymous user instead of breaking.
    await tx
      .update(users)
      .set({ email: null, displayName: null, deletedAt: now })
      .where(eq(users.id, userId));
    await recordAudit(tx, { orgId: null, actorUserId: userId, action: "account.deleted" });
    return plan;
  });
}

/** Handles the identity provider telling us an account was deleted there (e.g. from its dashboard). */
export async function deleteAccountBySubject(db: DbOrTx, subject: string): Promise<"deleted" | "unknown" | "deleted_with_handover"> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.authSubject, subject));
  if (!user) return "unknown";
  try {
    await deleteAccount(db, user.id);
    return "deleted";
  } catch (err) {
    if (err instanceof AppError && err.code === "ownership_transfer_required") {
      // The person no longer exists at the provider, so they can't hand over ownership. Keep each
      // blocked workspace manageable by promoting its longest-standing admin (or, failing that, its
      // longest-standing member) to owner, then delete the account as usual.
      const blocked = (err.details as { workspaces: { id: string }[] }).workspaces;
      await db.transaction(async (tx) => {
        for (const org of blocked) {
          const [successor] = await tx
            .select({ id: memberships.id, userId: memberships.userId })
            .from(memberships)
            .where(and(eq(memberships.orgId, org.id), ne(memberships.userId, user.id), eq(memberships.status, "active")))
            .orderBy(sql`case when ${memberships.role} = 'admin' then 0 else 1 end`, memberships.createdAt)
            .limit(1);
          if (!successor) continue;
          await tx.update(memberships).set({ role: "owner" }).where(eq(memberships.id, successor.id));
          await recordAudit(tx, {
            orgId: org.id,
            actorUserId: null,
            action: "member.role_changed",
            targetType: "user",
            targetId: successor.userId,
            metadata: { to: "owner", reason: "previous_owner_account_deleted" },
          });
        }
      });
      await deleteAccount(db, user.id);
      return "deleted_with_handover";
    }
    throw err;
  }
}
