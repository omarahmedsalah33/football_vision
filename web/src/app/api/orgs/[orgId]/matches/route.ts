import { getDb } from "@/server/db/client";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { createMatch, createMatchInput, listMatches } from "@/server/matches/service";

type P = { orgId: string };

export const GET = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  return { matches: await listMatches(getDb(), actor) };
});

export const POST = route<P, typeof createMatchInput>({ body: createMatchInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), LIMITS.createMatch, actor.userId);
  const match = await createMatch(getDb(), actor, body);
  return { id: match.id };
});
