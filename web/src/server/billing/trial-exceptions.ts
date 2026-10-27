import { clerkClient } from "@clerk/nextjs/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { auditEvents, organizations, users } from "../db/schema";

// Server-owned policy. Never accept eligibility or an email address from a request.
const ELIGIBLE_EMAILS = new Set([
  "mohamedmostafa1505@gmail.com",
  "omarahmedsalah33@gmail.com",
]);

export function isUnlimitedTrialEmail(email: string | null | undefined): boolean {
  return !!email && ELIGIBLE_EMAILS.has(email.trim().toLowerCase());
}

/** Personal owner or original club creator, not a subsequently invited member/owner. */
export async function hasUnlimitedTrial(db: DbOrTx, orgId: string): Promise<boolean> {
  const [creator] = await db
    .select({ subject: users.authSubject, email: users.email })
    .from(organizations)
    .innerJoin(users, eq(users.id, sql`coalesce(
      ${organizations.personalOwnerId},
      (select ${auditEvents.actorUserId} from ${auditEvents}
       where ${auditEvents.orgId} = ${organizations.id} and ${auditEvents.action} = 'org.created'
       order by ${auditEvents.createdAt} asc, ${auditEvents.id} asc limit 1)
    )`))
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt), isNull(users.deletedAt)));
  if (!creator || !isUnlimitedTrialEmail(creator.email)) return false;

  // The local email alone is not proof of ownership. Verify with the identity provider.
  // Fail explicitly if Clerk is unavailable, rather than misreporting an exhausted quota.
  const profile = await (await clerkClient()).users.getUser(creator.subject);
  return profile.emailAddresses.some(
    (email) => email.verification?.status === "verified"
      && email.emailAddress.toLowerCase() === creator.email?.trim().toLowerCase()
      && isUnlimitedTrialEmail(email.emailAddress),
  );
}
