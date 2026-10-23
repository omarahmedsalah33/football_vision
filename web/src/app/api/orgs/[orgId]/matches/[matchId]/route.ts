import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { deleteMatch, getMatch } from "@/server/matches/service";

type P = { orgId: string; matchId: string };

export const GET = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  return getMatch(getDb(), actor, uuidParam(params.matchId, "Match"));
});

export const DELETE = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await deleteMatch(getDb(), actor, uuidParam(params.matchId, "Match"));
});
