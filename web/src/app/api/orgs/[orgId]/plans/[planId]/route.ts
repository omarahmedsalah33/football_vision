import { getDb } from "@/server/db/client";
import { closeInput, closePlan } from "@/server/development/service";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; planId: string };

export const PATCH = route<P, typeof closeInput>({ body: closeInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  return closePlan(getDb(), actor, uuidParam(params.planId, "Plan"), body);
});
