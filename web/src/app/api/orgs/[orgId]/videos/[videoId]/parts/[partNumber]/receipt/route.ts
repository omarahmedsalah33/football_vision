import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { getStorage } from "@/server/storage/s3";
import { uploadPartReceipt } from "@/server/uploads/service";

type P = { orgId: string; videoId: string; partNumber: string };

export const GET = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "upload.receipt", perMinute: 480 }, actor.userId);
  return uploadPartReceipt(
    getDb(), getStorage(), actor, uuidParam(params.videoId, "Upload"), Number(params.partNumber),
  );
});
