import { getDb } from "@/server/db/client";
import { addComment, commentInput } from "@/server/development/service";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; planId: string };

export const POST = route<P, typeof commentInput>({ body: commentInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "plan.comment", perMinute: 30 }, actor.userId);
  return addComment(getDb(), actor, uuidParam(params.planId, "Plan"), body);
});
