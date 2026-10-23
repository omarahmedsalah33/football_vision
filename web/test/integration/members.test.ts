import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/server/authz/permissions";
import { auditEvents, invitations, memberships, organizations, users } from "../../src/server/db/schema";
import { resolveActor } from "../../src/server/orgs/service";
import {
  acceptInvitation,
  canAssign,
  changeRole,
  createInvitation,
  hashToken,
  listMembers,
  previewInvitation,
  removeMember,
  revokeInvitation,
} from "../../src/server/members/service";
import { subscriptions } from "../../src/server/db/schema";
import { makeActor, makeUser, testDb } from "../helpers";

const db = testDb();

/** A club on the club plan (50 members), with an owner. */
async function club(): Promise<Actor> {
  const owner = await makeActor(db, "owner");
  await db.insert(subscriptions).values({ orgId: owner.orgId, planId: "club", status: "active" });
  return owner;
}

async function userWithEmail(email: string) {
  const u = await makeUser(db);
  await db.update(users).set({ email }).where(eq(users.id, u.id));
  return u;
}

const email = () => `${randomUUID().slice(0, 8)}@example.com`;
const FORBIDDEN = expect.objectContaining({ status: 403 });
const NOT_FOUND = expect.objectContaining({ status: 404 });
const CONFLICT = expect.objectContaining({ status: 409 });

describe("role assignment rules", () => {
  it("owners assign anything; admins never touch the owner role; others assign nothing", () => {
    expect(canAssign("owner", "owner", "player")).toBe(true);
    expect(canAssign("admin", "coach", "admin")).toBe(true);
    expect(canAssign("admin", null, "owner")).toBe(false);
    expect(canAssign("admin", "owner", "coach")).toBe(false);
    expect(canAssign("admin", "owner", null)).toBe(false);
    expect(canAssign("coach", "player", "analyst")).toBe(false);
  });
});

describe("invitations", () => {
  it("full flow: invite → preview → accept once; only the token hash is stored", async () => {
    const owner = await club();
    const address = email();
    const inv = await createInvitation(db, owner, { email: address.toUpperCase(), role: "coach" });

    const [row] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row.tokenHash).toBe(hashToken(inv.token));
    expect(JSON.stringify(row)).not.toContain(inv.token);
    expect(row.email).toBe(address);

    expect(await previewInvitation(db, inv.token)).toMatchObject({ role: "coach" });
    const joiner = await userWithEmail(address);
    const joined = await acceptInvitation(db, joiner.id, [address], inv.token);
    expect(joined.orgId).toBe(owner.orgId);
    expect(await resolveActor(db, joiner.id, owner.orgId)).toMatchObject({ role: "coach" });

    // Single use.
    await expect(acceptInvitation(db, joiner.id, [address], inv.token)).rejects.toMatchObject({ status: 404 });
    expect(await previewInvitation(db, inv.token)).toBeNull();
  });

  it("a forwarded link is useless to someone with a different verified email", async () => {
    const owner = await club();
    const inv = await createInvitation(db, owner, { email: email(), role: "analyst" });
    const strangerEmail = email();
    const stranger = await userWithEmail(strangerEmail);
    await expect(acceptInvitation(db, stranger.id, [strangerEmail], inv.token)).rejects.toMatchObject({
      status: 403,
      code: "invitation_email_mismatch",
    });
    await expect(resolveActor(db, stranger.id, owner.orgId)).rejects.toThrowError(NOT_FOUND);
  });

  it("expired, revoked and made-up tokens are rejected the same way", async () => {
    const owner = await club();
    const address = email();
    const user = await userWithEmail(address);

    const expired = await createInvitation(db, owner, { email: address, role: "scout" }, new Date(Date.now() - 8 * 86_400_000));
    await expect(acceptInvitation(db, user.id, [address], expired.token)).rejects.toMatchObject({ code: "invitation_invalid" });

    const revoked = await createInvitation(db, owner, { email: email(), role: "scout" });
    await revokeInvitation(db, owner, revoked.id);
    await expect(acceptInvitation(db, user.id, [address], revoked.token)).rejects.toMatchObject({ code: "invitation_invalid" });

    await expect(acceptInvitation(db, user.id, [address], "made-up-token")).rejects.toMatchObject({ code: "invitation_invalid" });
  });

  it("admins cannot invite owners; coaches cannot invite at all", async () => {
    const owner = await club();
    const admin = await makeActor(db, "admin", owner.orgId);
    const coach = await makeActor(db, "coach", owner.orgId);
    await expect(createInvitation(db, admin, { email: email(), role: "owner" })).rejects.toThrowError(FORBIDDEN);
    await expect(createInvitation(db, coach, { email: email(), role: "player" })).rejects.toThrowError(FORBIDDEN);
    await expect(createInvitation(db, admin, { email: email(), role: "admin" })).resolves.toBeTruthy();
  });

  it("pending invitations count toward the plan's member limit, even under concurrency", async () => {
    const owner = await makeActor(db, "owner"); // club org on the free plan: maxMembers = 1
    await db.update(organizations).set({ kind: "club" }).where(eq(organizations.id, owner.orgId));
    await db.insert(subscriptions).values({ orgId: owner.orgId, planId: "coach_pro", status: "active" }); // 5 members
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createInvitation(db, owner, { email: email(), role: "player" })),
    );
    // 1 owner + 4 invitations = 5.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
  });

  it("personal workspaces cannot invite members", async () => {
    const owner = await makeActor(db, "owner");
    await db.update(organizations).set({ kind: "personal" }).where(eq(organizations.id, owner.orgId));
    await expect(createInvitation(db, owner, { email: email(), role: "coach" })).rejects.toThrowError(CONFLICT);
  });

  it("another club cannot revoke or see this club's invitations", async () => {
    const a = await club();
    const b = await club();
    const inv = await createInvitation(db, a, { email: email(), role: "coach" });
    await expect(revokeInvitation(db, b, inv.id)).rejects.toThrowError(NOT_FOUND);
  });
});

describe("members", () => {
  it("never leaves a workspace without an owner, even when two owners demote each other at once", async () => {
    // Many simultaneous races make a missing lock show up reliably instead of by luck.
    const pairs = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const a = await club();
        const b = await makeActor(db, "owner", a.orgId);
        return [a, b] as const;
      }),
    );
    await Promise.allSettled(pairs.flatMap(([a, b]) => [changeRole(db, a, b.userId, "coach"), changeRole(db, b, a.userId, "coach")]));
    for (const [a] of pairs) {
      const owners = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, a.orgId), eq(memberships.role, "owner")));
      expect(owners).toHaveLength(1);
    }
  });

  it("the last owner can neither leave nor be removed", async () => {
    const owner = await club();
    await expect(removeMember(db, owner, owner.userId)).rejects.toThrowError(CONFLICT);
    await expect(changeRole(db, owner, owner.userId, "admin")).rejects.toThrowError(CONFLICT);
  });

  it("admins manage non-owners only; members can leave; changes are audited", async () => {
    const owner = await club();
    const admin = await makeActor(db, "admin", owner.orgId);
    const coach = await makeActor(db, "coach", owner.orgId);

    await expect(removeMember(db, admin, owner.userId)).rejects.toThrowError(FORBIDDEN);
    await changeRole(db, admin, coach.userId, "analyst");
    await removeMember(db, coach, coach.userId); // leaving needs no permission

    expect((await listMembers(db, owner)).map((m) => m.userId)).not.toContain(coach.userId);
    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.orgId, owner.orgId))).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member.role_changed", "member.left"]));
  });

  it("members of another club cannot change roles here", async () => {
    const a = await club();
    const coach = await makeActor(db, "coach", a.orgId);
    const b = await club();
    await expect(changeRole(db, b, coach.userId, "admin")).rejects.toThrowError(NOT_FOUND);
    await expect(removeMember(db, b, coach.userId)).rejects.toThrowError(NOT_FOUND);
  });
});
