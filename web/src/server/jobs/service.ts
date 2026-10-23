import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { assertCan, type Actor } from "../authz/permissions";
import { getEntitlements, releaseAnalysis, reserveAnalysis, usagePeriodStart } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { analysisJobs, calibrations, matches, videos } from "../db/schema";
import { conflict, notFound, quotaExceeded } from "../http/errors";

export type JobRow = typeof analysisJobs.$inferSelect;
export type JobKind = JobRow["kind"];

// Bumped whenever a worker pipeline changes in a way that affects results.
export const PIPELINE_VERSION = { prepare: "v0.2-prepare", analyze: "v0.1-analyze" } as const;

const ACTIVE = ["queued", "running"] as const;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function findActiveJob(db: DbOrTx, orgId: string, videoId: string, kind: JobKind) {
  const [job] = await db
    .select()
    .from(analysisJobs)
    .where(
      and(
        eq(analysisJobs.orgId, orgId),
        eq(analysisJobs.videoId, videoId),
        eq(analysisJobs.kind, kind),
        inArray(analysisJobs.status, ACTIVE),
      ),
    );
  return job;
}

async function runCount(db: DbOrTx, videoId: string, kind: JobKind) {
  const rows = await db
    .select({ id: analysisJobs.id })
    .from(analysisJobs)
    .where(and(eq(analysisJobs.videoId, videoId), eq(analysisJobs.kind, kind)));
  return rows.length;
}

/**
 * Queues the free "prepare" job for a freshly uploaded video: validation and reference-frame
 * extraction. Idempotent: an already active prepare job is returned.
 */
export async function enqueuePrepare(db: DbOrTx, actor: Actor, videoId: string): Promise<JobRow> {
  assertCan(actor, "video.upload");
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.orgId, actor.orgId)));
  if (!video) throw notFound("Video");
  if (video.status !== "uploaded") throw conflict("This video is not waiting to be checked.");

  const existing = await findActiveJob(db, actor.orgId, video.id, "prepare");
  if (existing) return existing;
  const ent = await getEntitlements(db, actor.orgId);
  try {
    const [job] = await db
      .insert(analysisJobs)
      .values({
        orgId: actor.orgId,
        matchId: video.matchId,
        videoId: video.id,
        kind: "prepare",
        idempotencyKey: `video:${video.id}:prepare:${(await runCount(db, video.id, "prepare")) + 1}`,
        usageSettled: true, // nothing to settle: prepare jobs are free
        createdBy: actor.userId,
        config: { pipelineVersion: PIPELINE_VERSION.prepare, maxDurationSeconds: ent.limits.maxVideoDurationSeconds },
      })
      .returning();
    return job;
  } catch (err) {
    const winner = isUniqueViolation(err) && (await findActiveJob(db, actor.orgId, video.id, "prepare"));
    if (winner) return winner;
    throw err;
  }
}

/**
 * Queues computer-vision analysis of the match's checked and calibrated video. Idempotent: if an
 * analysis is already active it is returned and no quota is reserved. Quota reservation and job
 * creation commit together or not at all.
 */
export async function enqueueAnalysis(db: DbOrTx, actor: Actor, matchId: string, now = new Date()): Promise<JobRow> {
  assertCan(actor, "analysis.run");
  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.id, matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)));
      if (!match) throw notFound("Match");

      const [video] = await tx
        .select()
        .from(videos)
        .where(and(eq(videos.matchId, matchId), eq(videos.orgId, actor.orgId)))
        .orderBy(desc(videos.createdAt))
        .limit(1);
      if (!video || video.status !== "validated") throw conflict("The video must be uploaded and checked before analysis.");

      const [calibration] = await tx
        .select()
        .from(calibrations)
        .where(and(eq(calibrations.orgId, actor.orgId), eq(calibrations.videoId, video.id)))
        .orderBy(desc(calibrations.createdAt))
        .limit(1);
      if (!calibration) throw conflict("Calibrate the pitch before starting analysis.");

      const existing = await findActiveJob(tx, actor.orgId, video.id, "analyze");
      if (existing) return existing;

      const ent = await getEntitlements(tx, actor.orgId, now);
      const period = usagePeriodStart(now);
      if (!(await reserveAnalysis(tx, actor.orgId, period, ent.limits.monthlyAnalyses))) {
        throw quotaExceeded("Your plan's monthly analysis allowance is used up.");
      }

      const [job] = await tx
        .insert(analysisJobs)
        .values({
          orgId: actor.orgId,
          matchId,
          videoId: video.id,
          kind: "analyze",
          idempotencyKey: `video:${video.id}:analyze:${(await runCount(tx, video.id, "analyze")) + 1}`,
          usagePeriodStart: period,
          createdBy: actor.userId,
          // Snapshot of everything the worker needs; it never reads billing or calibration state itself.
          config: {
            pipelineVersion: PIPELINE_VERSION.analyze,
            maxDurationSeconds: ent.limits.maxVideoDurationSeconds,
            cameraType: "fixed_wide",
            calibration: {
              id: calibration.id,
              homography: calibration.homography,
              imageWidth: calibration.imageWidth,
              imageHeight: calibration.imageHeight,
              rmsErrorM: calibration.rmsErrorM,
              looErrorM: calibration.looErrorM,
            },
          },
        })
        .returning();
      return job;
    });
  } catch (err) {
    // A concurrent request won the race; ours rolled back, including its quota reservation.
    if (isUniqueViolation(err)) {
      const [video] = await db
        .select({ id: videos.id })
        .from(videos)
        .where(and(eq(videos.matchId, matchId), eq(videos.orgId, actor.orgId)))
        .orderBy(desc(videos.createdAt))
        .limit(1);
      const existing = video && (await findActiveJob(db, actor.orgId, video.id, "analyze"));
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Cancels a job. A queued job is cancelled immediately and any reservation released; a running
 * job is flagged and the worker stops at the next stage boundary.
 */
export async function cancelAnalysis(db: DbOrTx, actor: Actor, jobId: string): Promise<JobRow> {
  assertCan(actor, "analysis.run");
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(analysisJobs)
      .where(and(eq(analysisJobs.id, jobId), eq(analysisJobs.orgId, actor.orgId)))
      .for("update");
    if (!job) throw notFound("Analysis");

    if (job.status === "queued") {
      const [updated] = await tx
        .update(analysisJobs)
        .set({ status: "cancelled", finishedAt: new Date(), usageSettled: true })
        .where(eq(analysisJobs.id, job.id))
        .returning();
      if (!job.usageSettled && job.usagePeriodStart) await releaseAnalysis(tx, job.orgId, job.usagePeriodStart);
      return updated;
    }
    if (job.status === "running") {
      const [updated] = await tx
        .update(analysisJobs)
        .set({ cancelRequested: true })
        .where(eq(analysisJobs.id, job.id))
        .returning();
      return updated;
    }
    return job; // already finished
  });
}
