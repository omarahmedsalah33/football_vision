import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { assertCan, ROLES, type Actor, type Role } from "../authz/permissions";
import { getEntitlements } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { invitations, memberships, organizations, users } from "../db/schema";
import { AppError, conflict, forbidden, notFound, quotaExceeded } from "../http/errors";

export const INVITATION_TTL_DAYS = 7;

export const inviteInput = z.object({
  email: z.email().max(200),
  role: z.enum(ROLES),
});
export const changeRoleInput = z.object({ role: z.enum(ROLES) });

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Who may give or take which role. Owners can do anything; admins manage every role except
 * owner, and cannot change or remove an owner.
 */
export function canAssign(actorRole: Role, currentRole: Role | null, newRole: Role | null): boolean {
  if (actorRole === "owner") return true;
  if (actorRole !== "admin") return false;
  return currentRole !== "owner" && newRole !== "owner";
}

async function lockOrg(tx: DbOrTx, orgId: string) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .for("update");
  if (!org) throw notFound("Workspace");
  return org;
}

async function activeOwnerCount(tx: DbOrTx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner"), eq(memberships.status, "active")));
  return row.n;
}

export async function listMembers(db: DbOrTx, actor: Actor) {
  assertCan(actor, "match.read");
  return db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, actor.orgId), isNull(users.deletedAt)))
    .orderBy(asc(memberships.createdAt));
}

export async function listPendingInvitations(db: DbOrTx, actor: Actor, now = new Date()) {
  assertCan(actor, "members.manage");
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, actor.orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .orderBy(desc(invitations.createdAt));
}

/**
 * Creates an invitation and returns the one-time token. Pending invitations count against the
 * plan's member limit, checked under a lock on the workspace so concurrent invites can't overshoot.
 */
export async function createInvitation(db: DbOrTx, actor: Actor, input: z.infer<typeof inviteInput>, now = new Date()) {
  assertCan(actor, "members.manage");
  if (!canAssign(actor.role, null, input.role)) throw forbidden();
  const email = input.email.toLowerCase();

  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor.orgId);
    if (org.kind === "personal") throw conflict("Personal workspaces can't have members. Create a club workspace to invite people.");

    const [existingMember] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, org.id), sql`lower(${users.email}) = ${email}`));
    if (existingMember) throw conflict("This person is already a member.");

    const [{ members }] = await tx
      .select({ members: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.orgId, org.id), eq(memberships.status, "active")));
    const [{ pending }] = await tx
      .select({ pending: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(eq(invitations.orgId, org.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)),
      );
    const { limits } = await getEntitlements(tx, org.id, now);
    if (members + pending >= limits.maxMembers) {
      throw quotaExceeded(
        `Your plan allows ${limits.maxMembers} ${limits.maxMembers === 1 ? "member" : "members"}, including pending invitations.`,
      );
    }

    const token = randomBytes(32).toString("base64url");
    const [invitation] = await tx
      .insert(invitations)
      .values({
        orgId: org.id,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: actor.userId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
      })
      .returning();
    await recordAudit(tx, {
      orgId: org.id,
      actorUserId: actor.userId,
      action: "member.invited",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { role: input.role },
    });
    return { id: invitation.id, token, expiresAt: invitation.expiresAt };
  });
}

export async function revokeInvitation(db: DbOrTx, actor: Actor, invitationId: string) {
  assertCan(actor, "members.manage");
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.orgId, actor.orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (!inv) throw notFound("Invitation");
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "member.invitation_revoked", targetType: "invitation", targetId: inv.id });
  });
}

/** Public preview for the invitation page; reveals nothing for invalid tokens. */
export async function previewInvitation(db: DbOrTx, token: string, now = new Date()) {
  const [row] = await db
    .select({ orgName: organizations.name, role: invitations.role, email: invitations.email, expiresAt: invitations.expiresAt })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
        isNull(organizations.deletedAt),
      ),
    );
  return row ?? null;
}

/**
 * Accepts an invitation for a signed-in user. The user's verified email must match the invited
 * address, so a forwarded or leaked link is useless to anyone else. Single use.
 */
export async function acceptInvitation(
  db: DbOrTx,
  userId: string,
  verifiedEmails: string[],
  token: string,
  now = new Date(),
): Promise<{ orgId: string; orgSlug: string }> {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(token)))
      .for("update");
    const invalid = new AppError(404, "invitation_invalid", "This invitation is invalid, expired or already used.");
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= now) throw invalid;
    if (!verifiedEmails.map((e) => e.toLowerCase()).includes(inv.email)) {
      throw new AppError(403, "invitation_email_mismatch", `This invitation was sent to ${inv.email}. Sign in with that email address to accept it.`);
    }
    const org = await lockOrg(tx, inv.orgId).catch(() => {
      throw invalid;
    });

    await tx
      .insert(memberships)
      .values({ orgId: org.id, userId, role: inv.role })
      .onConflictDoNothing({ target: [memberships.orgId, memberships.userId] });
    await tx.update(invitations).set({ acceptedAt: now, acceptedBy: userId }).where(eq(invitations.id, inv.id));
    await recordAudit(tx, { orgId: org.id, actorUserId: userId, action: "member.joined", targetType: "invitation", targetId: inv.id, metadata: { role: inv.role } });
    return { orgId: org.id, orgSlug: org.slug };
  });
}

async function loadMembership(tx: DbOrTx, orgId: string, userId: string) {
  const [m] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .for("update");
  if (!m) throw notFound("Member");
  return m;
}

export async function changeRole(db: DbOrTx, actor: Actor, targetUserId: string, newRole: Role) {
  assertCan(actor, "members.manage");
  return db.transaction(async (tx) => {
    await lockOrg(tx, actor.orgId); // serialises owner-count checks per workspace
    const target = await loadMembership(tx, actor.orgId, targetUserId);
    if (!canAssign(actor.role, target.role as Role, newRole)) throw forbidden();
    if (target.role === newRole) return;
    if (target.role === "owner" && (await activeOwnerCount(tx, actor.orgId)) <= 1) {
      throw conflict("A workspace must always have at least one owner. Make someone else an owner first.");
    }
    await tx.update(memberships).set({ role: newRole }).where(eq(memberships.id, target.id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "member.role_changed",
      targetType: "user",
      targetId: targetUserId,
      metadata: { from: target.role, to: newRole },
    });
  });
}

/** Removes a member, or lets a member leave when they target themselves. */
export async function removeMember(db: DbOrTx, actor: Actor, targetUserId: string) {
  const leaving = targetUserId === actor.userId;
  if (!leaving) assertCan(actor, "members.manage");
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor.orgId);
    if (org.kind === "personal") throw conflict("You can't leave your personal workspace.");
    const target = await loadMembership(tx, actor.orgId, targetUserId);
    if (!leaving && !canAssign(actor.role, target.role as Role, null)) throw forbidden();
    if (target.role === "owner" && (await activeOwnerCount(tx, actor.orgId)) <= 1) {
      throw conflict("A workspace must always have at least one owner. Make someone else an owner first.");
    }
    await tx.delete(memberships).where(eq(memberships.id, target.id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: leaving ? "member.left" : "member.removed",
      targetType: "user",
      targetId: targetUserId,
    });
  });
}

