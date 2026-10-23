import { z } from "zod";
import { verifiedEmails } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { route } from "@/server/http/route";
import { acceptInvitation } from "@/server/members/service";

const input = z.object({ token: z.string().min(20).max(200) });

export const POST = route({ body: input }, async ({ user, body }) => {
  // Limits token guessing; tokens are 256-bit random values anyway.
  await enforceRateLimit(getDb(), { name: "invitation.accept", perMinute: 10 }, user.id);
  return acceptInvitation(getDb(), user.id, await verifiedEmails(), body.token);
});
