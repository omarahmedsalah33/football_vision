import { getDb } from "@/server/db/client";
import { logInput, logSession } from "@/server/development/service";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; planId: string };

export const POST = route<P, typeof logInput>({ body: logInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "training.log", perMinute: 60 }, actor.userId);
  return logSession(getDb(), actor, uuidParam(params.planId, "Plan"), body);
});
