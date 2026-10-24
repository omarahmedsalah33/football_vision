import { getDb } from "@/server/db/client";
import { deleteLog } from "@/server/development/service";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; planId: string; logId: string };

export const DELETE = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await deleteLog(getDb(), actor, uuidParam(params.planId, "Plan"), uuidParam(params.logId, "Session"));
});
