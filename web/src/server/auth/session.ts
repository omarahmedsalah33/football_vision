import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getDb } from "../db/client";
import { unauthenticated } from "../http/errors";
import { ensureUser, findUserBySubject, resolveActor, type UserRow } from "../orgs/service";

/**
 * The only bridge between the identity provider and our authorization data. Clerk proves who the
 * user is; everything they may access is decided from our own membership tables.
 */
export async function requireUser(): Promise<UserRow> {
  const { userId } = await auth();
  if (!userId) throw unauthenticated();
  const db = getDb();
  const existing = await findUserBySubject(db, userId);
  if (existing) return existing;

  const profile = await currentUser();
  return ensureUser(db, {
    subject: userId,
    email: profile?.primaryEmailAddress?.emailAddress ?? null,
    displayName: profile?.fullName || profile?.username || null,
  });
}

export async function requireActor(orgIdOrSlug: string) {
  const user = await requireUser();
  return resolveActor(getDb(), user.id, orgIdOrSlug);
}
