import { drillSchema } from "@/lib/development/drills";
import { getDb } from "@/server/db/client";
import { createDrill } from "@/server/development/service";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string };

export const POST = route<P, typeof drillSchema>({ body: drillSchema, status: 201, maxBodyBytes: 16 * 1024 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "drill.create", perMinute: 20 }, actor.userId);
  return createDrill(getDb(), actor, body);
});
