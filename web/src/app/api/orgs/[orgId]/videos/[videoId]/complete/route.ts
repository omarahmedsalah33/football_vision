import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { enqueuePrepare } from "@/server/jobs/service";
import { getStorage } from "@/server/storage/s3";
import { completeUpload } from "@/server/uploads/service";
import { completeUploadInput } from "@/server/uploads/validation";

type P = { orgId: string; videoId: string };

// Up to 10,000 parts at roughly 80 bytes each.
const MAX_BODY = 1024 * 1024;

export const POST = route<P, typeof completeUploadInput>(
  { body: completeUploadInput, maxBodyBytes: MAX_BODY },
  async ({ user, params, body }) => {
    const actor = await actorFor(user, params.orgId);
    await enforceRateLimit(getDb(), LIMITS.completeUpload, actor.userId);
    const video = await completeUpload(getDb(), getStorage(), actor, uuidParam(params.videoId, "Upload"), body);

    // Free "prepare" job: validates the file and extracts reference frames for calibration.
    // A retried completion after the checks already ran just reports the current state.
    if (video.status !== "uploaded") return { videoId: video.id, videoStatus: video.status };
    const job = await enqueuePrepare(getDb(), actor, video.id);
    return { videoId: video.id, prepare: { jobId: job.id, status: job.status } };
  },
);
