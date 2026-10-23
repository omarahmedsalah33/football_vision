import { getDb } from "@/server/db/client";
import { AppError, uuidParam } from "@/server/http/errors";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { enqueueAnalysis } from "@/server/jobs/service";
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

    // The upload is kept even when analysis cannot be queued yet (for example, allowance used up).
    try {
      const job = await enqueueAnalysis(getDb(), actor, video.matchId);
      return { videoId: video.id, analysis: { jobId: job.id, status: job.status } };
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return { videoId: video.id, analysis: { error: { code: err.code, message: err.message } } };
      }
      throw err;
    }
  },
);
