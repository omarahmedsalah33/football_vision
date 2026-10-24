import { getDb } from "@/server/db/client";
import { archiveDrill } from "@/server/development/service";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; drillId: string };

export const DELETE = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await archiveDrill(getDb(), actor, uuidParam(params.drillId, "Drill"));
});
