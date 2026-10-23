import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Actor, Role } from "../authz/permissions";
import type { DbOrTx } from "../db/client";
import { memberships, organizations, users } from "../db/schema";
import { notFound } from "../http/errors";

export type Identity = {
  /** Identity-provider subject (Clerk user id). */
  subject: string;
  email?: string | null;
  displayName?: string | null;
};

export type UserRow = typeof users.$inferSelect;

function randomSuffix(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${base || "workspace"}-${randomSuffix(2)}`;
}

/**
 * Returns the local user for an authenticated identity, creating it and its personal workspace on
 * first sight. Safe under concurrent calls: both inserts are conflict-tolerant.
 */
export async function ensureUser(db: DbOrTx, identity: Identity): Promise<UserRow> {
  return db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ authSubject: identity.subject, email: identity.email ?? null, displayName: identity.displayName ?? null })
      .onConflictDoNothing({ target: users.authSubject });
    const [user] = await tx.select().from(users).where(eq(users.authSubject, identity.subject));

    const [personal] = await tx
      .insert(organizations)
      .values({
        name: identity.displayName ? `${identity.displayName}'s workspace` : "My workspace",
        slug: `me-${randomSuffix(5)}`,
        kind: "personal",
        personalOwnerId: user.id,
      })
      .onConflictDoNothing({ target: organizations.personalOwnerId })
      .returning();
    if (personal) {
      await tx.insert(memberships).values({ orgId: personal.id, userId: user.id, role: "owner" });
    }
    return user;
  });
}

export async function findUserBySubject(db: DbOrTx, subject: string): Promise<UserRow | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.authSubject, subject), isNull(users.deletedAt)));
  return user;
}

const orgRef = z.union([z.string().uuid().transform((id) => ({ id })), z.string().min(1).transform((slug) => ({ slug }))]);

/**
 * Builds the Actor for a user inside an organization (by id or slug) from the membership table.
 * Non-members and suspended members get "not found", so organization existence is not revealed.
 */
export async function resolveActor(db: DbOrTx, userId: string, orgIdOrSlug: string): Promise<Actor & { orgSlug: string; orgName: string }> {
  const ref = orgRef.parse(orgIdOrSlug);
  const orgFilter = "id" in ref ? eq(organizations.id, ref.id) : eq(organizations.slug, ref.slug);
  const [row] = await db
    .select({ orgId: organizations.id, orgSlug: organizations.slug, orgName: organizations.name, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(
      and(orgFilter, eq(memberships.userId, userId), eq(memberships.status, "active"), isNull(organizations.deletedAt)),
    );
  if (!row) throw notFound("Workspace");
  return { userId, orgId: row.orgId, role: row.role as Role, orgSlug: row.orgSlug, orgName: row.orgName };
}

export async function listMyOrgs(db: DbOrTx, userId: string) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      kind: organizations.kind,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.createdAt));
}

export const createOrgInput = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(["club", "academy"]),
});

export async function createOrg(db: DbOrTx, userId: string, input: z.infer<typeof createOrgInput>) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name, kind: input.kind, slug: slugify(input.name) })
      .returning();
    await tx.insert(memberships).values({ orgId: org.id, userId, role: "owner" });
    return org;
  });
}
