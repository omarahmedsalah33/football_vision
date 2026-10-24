import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { archivePlayer, playerInput, updatePlayer } from "@/server/players/service";

type P = { orgId: string; playerId: string };

export const PATCH = route<P, typeof playerInput>({ body: playerInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  return updatePlayer(getDb(), actor, uuidParam(params.playerId, "Player"), body);
});

export const DELETE = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await archivePlayer(getDb(), actor, uuidParam(params.playerId, "Player"));
});
