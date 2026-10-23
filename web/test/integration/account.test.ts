import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount, deleteAccountBySubject, planAccountDeletion } from "../../src/server/account/service";
import { memberships, organizations, users } from "../../src/server/db/schema";
import { ensureUser, resolveActor } from "../../src/server/orgs/service";
import { makeActor, makeOrg, testDb } from "../helpers";

const db = testDb();

async function newUser() {
  const subject = `clerk_${randomUUID()}`;
  const user = await ensureUser(db, { subject, email: `${subject}@example.com`, displayName: "Pat" });
  const [personal] = await db.select().from(organizations).where(eq(organizations.personalOwnerId, user.id));
  return { user, subject, personal };
}

async function join(userId: string, orgId: string, role: "owner" | "admin" | "coach" | "player") {
  await db.insert(memberships).values({ orgId, userId, role });
}

describe("account deletion", () => {
  it("plans deletes, leaves and blockers correctly", async () => {
    const { user, personal } = await newUser();
    const alone = await makeOrg(db, "Alone");
    await join(user.id, alone.id, "owner");
    const shared = await makeOrg(db, "Shared");
    await join(user.id, shared.id, "owner");
    await makeActor(db, "owner", shared.id);
    const guest = await makeOrg(db, "Guest");
    await join(user.id, guest.id, "coach");
    await makeActor(db, "owner", guest.id);
    const blocked = await makeOrg(db, "Blocked");
    await join(user.id, blocked.id, "owner");
    await makeActor(db, "coach", blocked.id);

    const plan = await planAccountDeletion(db, user.id);
    expect(plan.deleteOrgs.map((o) => o.id).sort()).toEqual([personal.id, alone.id].sort());
    expect(plan.leaveOrgs.map((o) => o.id).sort()).toEqual([shared.id, guest.id].sort());
    expect(plan.blockers.map((o) => o.id)).toEqual([blocked.id]);
  });

  it("refuses while the user is the only owner of a club with members, then succeeds after hand-over", async () => {
    const { user, personal } = await newUser();
    const club = await makeOrg(db, "Club");
    await join(user.id, club.id, "owner");
    const coach = await makeActor(db, "coach", club.id);

    await expect(deleteAccount(db, user.id)).rejects.toMatchObject({ status: 409, code: "ownership_transfer_required" });

    await db.update(memberships).set({ role: "owner" }).where(and(eq(memberships.orgId, club.id), eq(memberships.userId, coach.userId)));
    await deleteAccount(db, user.id);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ email: null, displayName: null });
    expect(row.deletedAt).not.toBeNull();
    const [p] = await db.select().from(organizations).where(eq(organizations.id, personal.id));
    expect(p.deletedAt).not.toBeNull();
    expect(await db.select().from(memberships).where(eq(memberships.userId, user.id))).toHaveLength(0);
    // The club lives on with its new owner.
    expect(await resolveActor(db, coach.userId, club.id)).toMatchObject({ role: "owner" });
    // Idempotent.
    await expect(deleteAccount(db, user.id)).resolves.toMatchObject({ deleteOrgs: [] });
  });

  it("a deleted account can never be revived by a lingering sign-in session", async () => {
    const { user, subject } = await newUser();
    await deleteAccount(db, user.id);
    await expect(ensureUser(db, { subject, email: "x@example.com" })).rejects.toMatchObject({ status: 403, code: "account_deleted" });
  });

  it("when the provider deletes a sole owner, the longest-standing admin becomes owner", async () => {
    const { user, subject } = await newUser();
    const club = await makeOrg(db, "Handover");
    await join(user.id, club.id, "owner");
    const player = await makeActor(db, "player", club.id);
    const admin = await makeActor(db, "admin", club.id);

    expect(await deleteAccountBySubject(db, subject)).toBe("deleted_with_handover");
    expect(await resolveActor(db, admin.userId, club.id)).toMatchObject({ role: "owner" });
    expect(await resolveActor(db, player.userId, club.id)).toMatchObject({ role: "player" });
    expect(await deleteAccountBySubject(db, `clerk_${randomUUID()}`)).toBe("unknown");
  });
});

describe("Clerk webhook endpoint", () => {
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
    ({ POST } = await import("../../src/app/api/webhooks/clerk/route"));
  });
  afterEach(() => vi.unstubAllEnvs());

  function signed(payload: object, opts: { id?: string; at?: Date; key?: string } = {}) {
    const id = opts.id ?? `msg_${randomUUID()}`;
    const at = opts.at ?? new Date();
    const body = JSON.stringify(payload);
    const signature = new Webhook(opts.key ?? secret).sign(id, at, body);
    return new NextRequest("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": signature,
      },
    });
  }

  it("is disabled (503) until a signing secret is configured", async () => {
    vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "");
    const res = await POST(signed({ type: "user.deleted", data: { id: "x" } }));
    expect(res.status).toBe(503);
  });

  it("rejects forged, tampered and stale deliveries", async () => {
    const { user, subject } = await newUser();
    const forged = signed({ type: "user.deleted", data: { id: subject } }, { key: `whsec_${randomBytes(24).toString("base64")}` });
    expect((await POST(forged)).status).toBe(400);

    const stale = signed({ type: "user.deleted", data: { id: subject } }, { at: new Date(Date.now() - 60 * 60_000) });
    expect((await POST(stale)).status).toBe(400);

    const good = signed({ type: "user.deleted", data: { id: subject } });
    const tampered = new NextRequest(good.url, {
      method: "POST",
      headers: good.headers,
      body: JSON.stringify({ type: "user.deleted", data: { id: "someone-else" } }),
    });
    expect((await POST(tampered)).status).toBe(400);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.deletedAt).toBeNull();
  });

  it("processes a genuine user.deleted once, and treats a replay as a duplicate", async () => {
    const { user, subject } = await newUser();
    const id = `msg_${randomUUID()}`;
    const first = await POST(signed({ type: "user.deleted", data: { id: subject } }, { id }));
    expect(await first.json()).toEqual({ result: "processed" });
    const replay = await POST(signed({ type: "user.deleted", data: { id: subject } }, { id }));
    expect(await replay.json()).toEqual({ result: "duplicate" });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.deletedAt).not.toBeNull();
  });

  it("keeps the local email in sync on user.updated", async () => {
    const { user, subject } = await newUser();
    const res = await POST(
      signed({
        type: "user.updated",
        data: {
          id: subject,
          first_name: "Mona",
          last_name: "Aly",
          primary_email_address_id: "e2",
          email_addresses: [
            { id: "e1", email_address: "old@example.com" },
            { id: "e2", email_address: "New@Example.com" },
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ email: "new@example.com", displayName: "Mona Aly" });
  });
});
