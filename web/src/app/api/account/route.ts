import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { deleteAccount, planAccountDeletion } from "@/server/account/service";
import { requireRecentVerification } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { log } from "@/server/log";
import { route } from "@/server/http/route";

/** What deleting the account would do (shown before the user confirms). */
export const GET = route({}, async ({ user }) => planAccountDeletion(getDb(), user.id));

const deleteInput = z.object({ confirm: z.literal("DELETE") });

export const DELETE = route({ body: deleteInput }, async ({ user, requestId }) => {
  const subject = await requireRecentVerification();
  const plan = await deleteAccount(getDb(), user.id);
  // Local data is gone first; then the sign-in account. If the provider call fails, the local
  // account is already unusable (deleted accounts are refused at sign-in).
  try {
    const clerk = await clerkClient();
    await clerk.users.deleteUser(subject);
  } catch (err) {
    log.error({ err, requestId }, "identity provider deletion failed; local account already deleted");
  }
  return { deleted: true, deletedWorkspaces: plan.deleteOrgs.length, leftWorkspaces: plan.leaveOrgs.length };
});
