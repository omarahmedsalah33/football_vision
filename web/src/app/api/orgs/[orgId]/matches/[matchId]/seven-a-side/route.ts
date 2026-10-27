import { sevenAsideUpdateSchema } from "@/lib/seven-a-side";
import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { getSevenAside, updateSevenAside } from "@/server/matches/seven-a-side";

type P = { orgId: string; matchId: string };
export const GET = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  return { experience: await getSevenAside(getDb(), actor, uuidParam(params.matchId, "Match")) };
});
export const PATCH = route<P, typeof sevenAsideUpdateSchema>({ body: sevenAsideUpdateSchema }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  return { experience: await updateSevenAside(getDb(), actor, uuidParam(params.matchId, "Match"), body) };
});
