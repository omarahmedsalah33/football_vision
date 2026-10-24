import { getDb } from "@/server/db/client";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { createPlayer, playerInput } from "@/server/players/service";

type P = { orgId: string };

export const POST = route<P, typeof playerInput>({ body: playerInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "player.create", perMinute: 30 }, actor.userId);
  return createPlayer(getDb(), actor, body);
});
