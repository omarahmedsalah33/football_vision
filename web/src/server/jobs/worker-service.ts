/** Website-owned queue operations. No SQL, credentials or arbitrary storage paths cross this API. */
import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { analysisJobs, analysisResults, matches, organizations, usagePeriods, videos } from "../db/schema";
import type { WorkerRequest } from "./worker-contract";

export const LEASE_SECONDS = 120;
type Job = typeof analysisJobs.$inferSelect;
const runnable = or(
  and(eq(analysisJobs.status, "queued"), sql`${analysisJobs.runAfter} <= now()`),
  and(eq(analysisJobs.status, "running"), sql`${analysisJobs.leaseExpiresAt} < now()`,
    sql`${analysisJobs.attempts} < ${analysisJobs.maxAttempts}`, eq(analysisJobs.cancelRequested, false)),
);
export class WorkerConflict extends Error {
  constructor(message: string, public readonly code = "worker_lease_lost",
    public readonly reason = "lease") { super(message); }
}

async function settle(tx: DbOrTx, job: Job, consume: boolean) {
  if (job.usageSettled || !job.usagePeriodStart) return;
  await tx.update(usagePeriods).set({
    analysesReserved: sql`greatest(${usagePeriods.analysesReserved} - 1, 0)`,
    ...(consume ? { analysesUsed: sql`${usagePeriods.analysesUsed} + 1` } : {}),
  }).where(and(eq(usagePeriods.orgId, job.orgId), eq(usagePeriods.periodStart, job.usagePeriodStart)));
}

export async function reapWorkerJobs(db: DbOrTx) {
  await db.transaction(async tx => {
    const expired = await tx.select().from(analysisJobs).where(and(
      eq(analysisJobs.status, "running"), lt(analysisJobs.leaseExpiresAt, new Date()),
      or(eq(analysisJobs.cancelRequested, true), sql`${analysisJobs.attempts} >= ${analysisJobs.maxAttempts}`),
    )).limit(50).for("update", { skipLocked: true });
    for (const job of expired) {
      await settle(tx, job, false);
      await tx.update(analysisJobs).set({
        status: job.cancelRequested ? "cancelled" : "failed", usageSettled: true,
        leaseOwner: null, leaseExpiresAt: null, finishedAt: new Date(),
        errorCode: job.cancelRequested ? null : "worker_lost",
        errorMessage: job.cancelRequested ? null : "Processing stopped unexpectedly and could not be completed.",
      }).where(eq(analysisJobs.id, job.id));
    }
  });
}

export async function workerPending(db: DbOrTx) {
  const rows = await db.select({ id: analysisJobs.id }).from(analysisJobs).where(runnable).limit(1);
  return rows.length > 0;
}

/** onlyJobId is for isolated service tests; the public worker route never accepts it. */
export async function claimWorkerJob(db: DbOrTx, workerId: string, onlyJobId?: string) {
  return db.transaction(async tx => {
    // Serialize duplicate claim requests from the same invocation, even with two queued videos.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workerId}, 0))`);
    // Retrying a lost claim response must return the SAME lease, not claim another video.
    let [job] = await tx.select().from(analysisJobs).where(and(
      eq(analysisJobs.status, "running"), eq(analysisJobs.leaseOwner, workerId),
      gt(analysisJobs.leaseExpiresAt, new Date()),
      ...(onlyJobId ? [eq(analysisJobs.id, onlyJobId)] : []),
    )).limit(1).for("update");
    if (!job) {
      [job] = await tx.select().from(analysisJobs).where(and(runnable,
        ...(onlyJobId ? [eq(analysisJobs.id, onlyJobId)] : []),
      )).orderBy(asc(analysisJobs.createdAt)).limit(1).for("update", { skipLocked: true });
      if (!job) return { job: null };
      [job] = await tx.update(analysisJobs).set({
        status: "running", leaseOwner: workerId, leaseExpiresAt: sql`now() + interval '120 seconds'`,
        heartbeatAt: new Date(), attempts: job.attempts + 1, startedAt: job.startedAt ?? new Date(),
        stage: null, progress: 0, errorCode: null, errorMessage: null,
      }).where(eq(analysisJobs.id, job.id)).returning();
    }
    const [video] = await tx.select({ storage_key: videos.storageKey, size_bytes: videos.sizeBytes,
      status: videos.status, duration_seconds: videos.durationSeconds,
      match_deleted_at: matches.deletedAt, org_deleted_at: organizations.deletedAt,
    }).from(videos).innerJoin(matches, eq(matches.id, videos.matchId))
      .innerJoin(organizations, eq(organizations.id, videos.orgId))
      .where(and(eq(videos.id, job.videoId), eq(videos.orgId, job.orgId), eq(videos.matchId, job.matchId)));
    return { job: { id: job.id, kind: job.kind, org_id: job.orgId, match_id: job.matchId,
      video_id: job.videoId, attempts: job.attempts, max_attempts: job.maxAttempts, config: job.config },
      video, leaseSeconds: LEASE_SECONDS };
  });
}

function root(job: Job) {
  return `orgs/${job.orgId}/matches/${job.matchId}/analysis/${job.id}/`;
}
function invalid(condition: boolean, reason = "result_contract") {
  if (condition) throw new WorkerConflict("Invalid result for this job.", "worker_result_invalid", reason);
}

/** Registered slots include players without usable photos; actual photo keys may be null. */
export function validatePlayerPhotos(catalog: { id: string; photoKey: string | null }[],
  jobRoot: string, registeredPhotos: string[] | undefined) {
  invalid(!registeredPhotos || registeredPhotos.length !== catalog.length, "photo_manifest");
  catalog.forEach((player, index) => {
    const expected = `${jobRoot}players/${index + 1}.jpg`;
    invalid(player.id !== `Unknown${index + 1}`, "player_id");
    invalid(player.photoKey !== null && player.photoKey !== expected, "player_photo");
    invalid(registeredPhotos?.[index] !== expected, "photo_manifest");
  });
}
const errors: Record<string, string> = {
  worker_result_invalid: "The website rejected the analysis report during validation. This is a report-format error, not a video-quality problem.",
  worker_api_rejected: "The website rejected a worker operation. Check the worker connection and report format before retrying.",
  worker_api_limit: "The analysis report exceeded the website's safe request size.",
  tracking_unavailable: "The Modal GPU tracking step could not complete. Retry or select Gemini + Astra mode.",
  tracking_no_players: "The tracker could not establish player tracks. Try Gemini + Astra mode.",
  tracking_decode_failed: "The tracking video could not be decoded or encoded.",
  tracking_limit: "Player tracking exceeded its safe result size.",
  tracking_invalid: "The player tracking result was invalid.",
  ai_rate_limited: "The AI provider rate-limited this analysis after retries. Please try again shortly.",
  ai_broker_busy: "All AI request slots were busy after retries. Please try the analysis again shortly.",
  ai_provider_timeout: "The AI provider timed out after retries. Your uploaded video is unchanged; retry the analysis.",
  ai_provider_unavailable: "The AI provider was temporarily unavailable after retries. Please retry the analysis.",
  ai_broker_unavailable: "The website's AI broker was temporarily unavailable after retries. Please retry the analysis.",
  ai_provider_credentials: "The AI provider rejected the website's credentials or permissions. Check the provider configuration.",
  ai_provider_model: "The configured AI model was not available. Check the website's provider/model configuration.",
  ai_request_invalid: "The AI service rejected the request format. Check the analysis integration before retrying.",
  ai_not_configured: "The AI provider is not configured on the website. Configure it before retrying.",
  ai_provider_error: "The AI provider rejected this request. Check the provider configuration before retrying.",
  ai_input_limit: "The AI input remained too large even after reducing the video section. No complete results were produced.",
  ai_output_limit: "The AI output was truncated even after reducing the video section. No complete results were produced.",
  ai_invalid_response: "The AI provider returned an incomplete or invalid response. No complete results were produced.",
  ai_response_blocked: "The AI provider declined a video section. No complete results were produced.",
  ai_authorization: "The worker no longer had permission to analyze this job. Check the worker connection before retrying.",
  invalid_duration: "The video duration exceeds this job's allowance.",
  analysis_replaced: "Start a new Gemini/Astra analysis.",
  video_missing: "The uploaded video could not be found.",
  undecodable: "The video could not be decoded.", no_frames: "No usable video frames were found.",
  ai_request_limit: "An AI request reached its limit. Completed sections are saved.",
  ai_unavailable: "The AI service is unavailable. Saved progress is retained.",
};

export async function updateWorkerJob(db: DbOrTx, body: Exclude<WorkerRequest,
  { op: "claim" | "maintenance" | "cleanup" }>) {
  return db.transaction(async tx => {
    const [job] = await tx.select().from(analysisJobs).where(and(
      eq(analysisJobs.id, body.jobId), eq(analysisJobs.status, "running"),
      eq(analysisJobs.leaseOwner, body.workerId), sql`${analysisJobs.leaseExpiresAt} > now()`,
    )).for("update");
    if (!job) throw new WorkerConflict("No active worker lease.");
    if (body.op === "heartbeat" || body.op === "progress") {
      await tx.update(analysisJobs).set(body.op === "heartbeat" ? {
        heartbeatAt: new Date(), leaseExpiresAt: sql`now() + interval '120 seconds'`,
      } : { stage: body.stage, progress: body.progress, heartbeatAt: new Date(),
        leaseExpiresAt: sql`now() + interval '120 seconds'` }).where(eq(analysisJobs.id, job.id));
      return { cancelRequested: job.cancelRequested };
    }
    if (job.cancelRequested && body.op !== "cancel" && body.op !== "fail")
      throw new WorkerConflict("Cancellation requested.", "worker_cancelled", "cancellation");
    if (body.op === "checkpoints") {
      for (const entry of body.entries) invalid(
        entry.key !== `${root(job)}checkpoints/${entry.binding}/${entry.name}` || !entry.name.includes(entry.sha256));
      invalid(new Set(body.entries.map(e => e.key)).size !== body.entries.length);
      await tx.update(analysisJobs).set({ config: { ...(job.config as object),
        _workerCheckpoints: body.entries } }).where(eq(analysisJobs.id, job.id));
      return { saved: true };
    }
    if (body.op === "outputs") {
      invalid(job.kind !== "analyze");
      await tx.update(analysisJobs).set({ config: { ...(job.config as object), _videoOutputs: {
        photos: Array.from({ length: body.count }, (_, i) => `${root(job)}players/${i + 1}.jpg`),
        ledger: `${root(job)}tracks.jsonl.gz`,
      } } }).where(eq(analysisJobs.id, job.id));
      return { saved: true };
    }
    let status: "succeeded" | "failed" | "queued" | "cancelled" = "succeeded";
    let models: Record<string, unknown> | undefined;
    if (body.op === "fail" || body.op === "cancel") {
      status = job.cancelRequested || body.op === "cancel" ? "cancelled" :
        body.retryable && job.attempts < job.maxAttempts ? "queued" : "failed";
      if (body.op === "fail" && status === "failed" && body.rejectVideo && job.kind === "prepare")
        await tx.update(videos).set({ status: "rejected", rejectionReason: body.code }).where(eq(videos.id, job.videoId));
    } else if (body.op === "complete_prepare") {
      invalid(job.kind !== "prepare" ||
        body.info.duration_seconds > Number((job.config as { maxDurationSeconds?: number }).maxDurationSeconds ?? 0));
      const frameRoot = `orgs/${job.orgId}/matches/${job.matchId}/videos/${job.videoId}/frames/`;
      for (const frame of body.frames) invalid(
        !frame.key.startsWith(frameRoot) || !/^frame_\d+\.jpg$/.test(frame.key.slice(frameRoot.length)) ||
        frame.timeSeconds > body.info.duration_seconds);
      await tx.update(videos).set({ status: "validated", container: body.info.container,
        videoCodec: body.info.video_codec, durationSeconds: body.info.duration_seconds,
        width: body.info.width, height: body.info.height, fps: body.info.fps,
        frames: body.frames, cameraMotion: body.cameraMotion,
      }).where(and(eq(videos.id, job.videoId), eq(videos.orgId, job.orgId)));
      models = body.models;
    } else if (body.op === "complete_analysis") {
      invalid(job.kind !== "analyze" || (job.config as { engine?: string }).engine !== "llm");
      const events = body.summary.videoEvents;
      const trackingRequested = (job.config as { playerTracking?: boolean }).playerTracking === true;
      invalid(trackingRequested !== (events.tracking?.enabled === true));
      if (trackingRequested) {
        events.events.forEach((event) => {
          invalid(!event.tracking);
          invalid(event.included && event.tracking?.status !== "supported");
          invalid(event.actorId !== null && event.tracking?.status !== "supported");
          invalid(event.actorId !== null && event.actorId !== event.tracking?.suggestedActorId);
        });
      }
      const [video] = await tx.select().from(videos).where(eq(videos.id, job.videoId));
      invalid(!video || video.status !== "validated" || Math.abs((video.durationSeconds ?? 0) - events.durationSeconds) > 0.1 ||
        events.completedWindows !== events.totalWindows || events.catalog.length > 24);
      const manifest = (job.config as { _videoOutputs?: { photos?: string[] } })._videoOutputs;
      validatePlayerPhotos(events.catalog, root(job), manifest?.photos);
      await tx.insert(analysisResults).values({ jobId: job.id, orgId: job.orgId, matchId: job.matchId,
        calibrationId: null, summary: body.summary, tracksKey: `${root(job)}tracks.jsonl.gz`,
      }).onConflictDoUpdate({ target: analysisResults.jobId, set: { summary: body.summary, tracksKey: `${root(job)}tracks.jsonl.gz` } });
      models = body.models;
    }
    const retry = status === "queued";
    if (!retry) await settle(tx, job, status === "succeeded");
    await tx.update(analysisJobs).set({
      status, leaseOwner: null, leaseExpiresAt: null,
      ...(!retry ? { finishedAt: new Date(), usageSettled: true } :
        { runAfter: new Date(Date.now() + 30000 * 2 ** (job.attempts - 1)), stage: null, progress: 0 }),
      ...(status === "succeeded" ? { progress: 1, modelVersions: models ?? {} } : {}),
      errorCode: body.op === "fail" && status !== "cancelled" ? body.code : null,
      errorMessage: body.op === "fail" && status !== "cancelled" ?
        errors[body.code] ?? "Processing could not complete. Retry or review the saved progress." : null,
    }).where(eq(analysisJobs.id, job.id));
    return { status };
  });
}
