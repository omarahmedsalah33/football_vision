import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { getStorage } from "@/server/storage/s3";
import { presignParts } from "@/server/uploads/service";
import { presignPartsInput } from "@/server/uploads/validation";

type P = { orgId: string; videoId: string };

export const POST = route<P, typeof presignPartsInput>({ body: presignPartsInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), LIMITS.presignParts, actor.userId);
  return { parts: await presignParts(getDb(), getStorage(), actor, uuidParam(params.videoId, "Upload"), body) };
});
