import { contactInput, ipKey, submitContact } from "@/server/contact/service";
import { getDb } from "@/server/db/client";
import { env } from "@/server/env";
import { clientIp, publicRoute } from "@/server/http/route";

export const POST = publicRoute({ body: contactInput, maxBodyBytes: 8 * 1024, status: 202 }, async ({ req, body }) => {
  await submitContact(getDb(), body, ipKey(clientIp(req), env().APP_ORIGIN));
  // Same answer whether or not the message was stored (bots learn nothing from the response).
  return { received: true };
});
