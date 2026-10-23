import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { getStorage } from "@/server/storage/s3";
import { abortUpload } from "@/server/uploads/service";

type P = { orgId: string; videoId: string };

export const POST = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await abortUpload(getDb(), getStorage(), actor, uuidParam(params.videoId, "Upload"));
});
