import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { assertCan, type Actor } from "../authz/permissions";
import { getEntitlements, releaseAnalysis, reserveAnalysis, usagePeriodStart } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { analysisJobs, matches, videos } from "../db/schema";
import { conflict, notFound, quotaExceeded } from "../http/errors";

export type JobRow = typeof analysisJobs.$inferSelect;

// Bumped whenever the worker pipeline's stages change in a way that affects results.
export const PIPELINE_VERSION = "v0.1-validate";

const ACTIVE = ["queued", "running"] as const;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function findActiveJob(db: DbOrTx, orgId: string, videoId: string) {
  const [job] = await db
    .select()
    .from(analysisJobs)
    .where(and(eq(analysisJobs.orgId, orgId), eq(analysisJobs.videoId, videoId), inArray(analysisJobs.status, ACTIVE)));
  return job;
}

/**
 * Queues analysis of the match's uploaded video. Idempotent: if an analysis is already queued or
 * running for that video, it is returned and no quota is reserved. Quota reservation and job
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
        .where(
          and(
            eq(videos.matchId, matchId),
            eq(videos.orgId, actor.orgId),
            inArray(videos.status, ["uploaded", "validated"]),
          ),
        )
        .orderBy(desc(videos.createdAt))
        .limit(1);
      if (!video) throw conflict("Upload a video before starting analysis.");

      const existing = await findActiveJob(tx, actor.orgId, video.id);
      if (existing) return existing;

      const ent = await getEntitlements(tx, actor.orgId, now);
      const period = usagePeriodStart(now);
      if (!(await reserveAnalysis(tx, actor.orgId, period, ent.limits.monthlyAnalyses))) {
        throw quotaExceeded("Your plan's monthly analysis allowance is used up.");
      }

      const priorRuns = await tx
        .select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(and(eq(analysisJobs.orgId, actor.orgId), eq(analysisJobs.videoId, video.id)));

      const [job] = await tx
        .insert(analysisJobs)
        .values({
          orgId: actor.orgId,
          matchId,
          videoId: video.id,
          idempotencyKey: `video:${video.id}:run:${priorRuns.length + 1}`,
          usagePeriodStart: period,
          createdBy: actor.userId,
          // Snapshot of the limits the worker must enforce; the worker never reads billing state.
          config: {
            pipelineVersion: PIPELINE_VERSION,
            maxDurationSeconds: ent.limits.maxVideoDurationSeconds,
            cameraType: "fixed_wide",
          },
        })
        .returning();
      return job;
    });
  } catch (err) {
    // A concurrent request won the race to create the active job; ours rolled back, including
    // its quota reservation. Return the winner.
    if (isUniqueViolation(err)) {
      const [video] = await db
        .select({ id: videos.id })
        .from(videos)
        .where(and(eq(videos.matchId, matchId), eq(videos.orgId, actor.orgId)))
        .orderBy(desc(videos.createdAt))
        .limit(1);
      const existing = video && (await findActiveJob(db, actor.orgId, video.id));
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Cancels an analysis. A queued job is cancelled immediately and its reservation released; a
 * running job is flagged and the worker stops at the next stage boundary.
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
      if (!job.usageSettled) await releaseAnalysis(tx, job.orgId, job.usagePeriodStart);
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
