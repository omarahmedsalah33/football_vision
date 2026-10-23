import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getDb } from "../db/client";
import { AppError, unauthenticated } from "../http/errors";
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

/** Email addresses the identity provider has verified for the signed-in user. */
export async function verifiedEmails(): Promise<string[]> {
  const profile = await currentUser();
  return (profile?.emailAddresses ?? [])
    .filter((e) => e.verification?.status === "verified")
    .map((e) => e.emailAddress.toLowerCase());
}

export const REVERIFY_WITHIN_MINUTES = 10;

/**
 * Step-up check for destructive actions: the user must have proved their identity (password,
 * code or passkey) within the last few minutes, not just hold an old session.
 */
export async function requireRecentVerification(maxAgeMinutes = REVERIFY_WITHIN_MINUTES) {
  const { userId, factorVerificationAge } = await auth();
  if (!userId) throw unauthenticated();
  const firstFactorAge = factorVerificationAge?.[0] ?? -1;
  if (firstFactorAge < 0 || firstFactorAge > maxAgeMinutes) {
    throw new AppError(
      403,
      "reverification_required",
      `For your security, sign out and sign in again, then retry within ${maxAgeMinutes} minutes.`,
    );
  }
  return userId;
}
