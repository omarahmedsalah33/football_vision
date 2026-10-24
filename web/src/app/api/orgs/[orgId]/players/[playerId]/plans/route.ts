import { getDb } from "@/server/db/client";
import { createPlan, planInput } from "@/server/development/service";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; playerId: string };

export const POST = route<P, typeof planInput>({ body: planInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "plan.create", perMinute: 20 }, actor.userId);
  return createPlan(getDb(), actor, uuidParam(params.playerId, "Player"), body);
});
