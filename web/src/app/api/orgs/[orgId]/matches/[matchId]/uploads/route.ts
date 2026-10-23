import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { getStorage } from "@/server/storage/s3";
import { startUpload } from "@/server/uploads/service";
import { startUploadInput } from "@/server/uploads/validation";

type P = { orgId: string; matchId: string };

export const POST = route<P, typeof startUploadInput>({ body: startUploadInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), LIMITS.startUpload, actor.userId);
  return startUpload(getDb(), getStorage(), actor, uuidParam(params.matchId, "Match"), body);
});
