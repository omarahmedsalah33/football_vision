import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "../authz/permissions";
import { recordAudit } from "../audit";
import type { DbOrTx } from "../db/client";
import { analysisJobs, calibrations, matches, teams, videos } from "../db/schema";
import { invalidInput, notFound } from "../http/errors";

export const createMatchInput = z.object({
  title: z.string().trim().min(2).max(120),
  opponentName: z.string().trim().max(120).optional(),
  playedOn: z.iso.date().optional(),
  teamId: z.string().uuid().optional(),
});

export type MatchStatus =
  | "awaiting_upload"
  | "uploading"
  | "upload_rejected"
  | "checking"
  | "needs_calibration"
  | "ready"
  | "queued"
  | "processing"
  | "analyzed"
  | "failed"
  | "cancelled";

type VideoLike = { status: (typeof videos.$inferSelect)["status"] } | undefined;
type JobLike = { status: (typeof analysisJobs.$inferSelect)["status"] } | undefined;

/**
 * Single place that turns the latest video, its prepare and analyze jobs and calibration into
 * what the user sees, following the lifecycle upload → check → calibrate → analyse.
 */
export function deriveMatchStatus(video: VideoLike, prepare: JobLike, analyze: JobLike, calibrated: boolean): MatchStatus {
  if (analyze) {
    switch (analyze.status) {
      case "queued":
        return "queued";
      case "running":
        return "processing";
      case "succeeded":
        return "analyzed";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
    }
  }
  if (!video || video.status === "aborted" || video.status === "purged") return "awaiting_upload";
  if (video.status === "uploading") return "uploading";
  if (video.status === "rejected") return "upload_rejected";
  if (video.status === "uploaded") {
    if (prepare?.status === "failed") return "failed";
    return "checking";
  }
  return calibrated ? "ready" : "needs_calibration";
}

export async function createMatch(db: DbOrTx, actor: Actor, input: z.infer<typeof createMatchInput>) {
  assertCan(actor, "match.create");
  if (input.teamId) {
    // A team id from another organization must not be attachable.
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, input.teamId), eq(teams.orgId, actor.orgId)));
    if (!team) throw invalidInput("Unknown team.");
  }
  const [match] = await db
    .insert(matches)
    .values({
      orgId: actor.orgId,
      title: input.title,
      opponentName: input.opponentName || null,
      playedOn: input.playedOn ?? null,
      teamId: input.teamId ?? null,
      createdBy: actor.userId,
    })
    .returning();
  return match;
}

export async function listMatches(db: DbOrTx, actor: Actor) {
  assertCan(actor, "match.read");
  const rows = await db
    .select()
    .from(matches)
    .where(and(eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)))
    .orderBy(desc(matches.createdAt))
    .limit(200);
  if (rows.length === 0) return [];

  const ids = rows.map((m) => m.id);
  const [vids, jobs, cals] = await Promise.all([
    db
      .select({ matchId: videos.matchId, status: videos.status, createdAt: videos.createdAt })
      .from(videos)
      .where(and(eq(videos.orgId, actor.orgId), inArray(videos.matchId, ids)))
      .orderBy(desc(videos.createdAt)),
    db
      .select({ matchId: analysisJobs.matchId, kind: analysisJobs.kind, status: analysisJobs.status, createdAt: analysisJobs.createdAt })
      .from(analysisJobs)
      .where(and(eq(analysisJobs.orgId, actor.orgId), inArray(analysisJobs.matchId, ids)))
      .orderBy(desc(analysisJobs.createdAt)),
    db
      .select({ matchId: calibrations.matchId })
      .from(calibrations)
      .where(and(eq(calibrations.orgId, actor.orgId), inArray(calibrations.matchId, ids))),
  ]);
  const latest = <T extends { matchId: string }>(list: T[], id: string, pred: (x: T) => boolean = () => true) =>
    list.find((x) => x.matchId === id && pred(x));

  return rows.map((m) => ({
    id: m.id,
    title: m.title,
    opponentName: m.opponentName,
    playedOn: m.playedOn,
    createdAt: m.createdAt,
    status: deriveMatchStatus(
      latest(vids, m.id),
      latest(jobs, m.id, (j) => j.kind === "prepare"),
      latest(jobs, m.id, (j) => j.kind === "analyze"),
      cals.some((c) => c.matchId === m.id),
    ),
  }));
}

export async function getMatch(db: DbOrTx, actor: Actor, matchId: string) {
  assertCan(actor, "match.read");
  const [match] = await db
    .select()
    .from(matches)
    .where(and(eq(matches.id, matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)));
  if (!match) throw notFound("Match");

  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.matchId, match.id), eq(videos.orgId, actor.orgId)))
    .orderBy(desc(videos.createdAt))
    .limit(1);
  const latestJob = async (kind: "prepare" | "analyze") => {
    const [job] = video
      ? await db
          .select()
          .from(analysisJobs)
          .where(and(eq(analysisJobs.videoId, video.id), eq(analysisJobs.orgId, actor.orgId), eq(analysisJobs.kind, kind)))
          .orderBy(desc(analysisJobs.createdAt))
          .limit(1)
      : [];
    return job;
  };
  const [prepare, analyze] = await Promise.all([latestJob("prepare"), latestJob("analyze")]);
  const [calibration] = video
    ? await db
        .select()
        .from(calibrations)
        .where(and(eq(calibrations.videoId, video.id), eq(calibrations.orgId, actor.orgId)))
        .orderBy(desc(calibrations.createdAt))
        .limit(1)
    : [];

  const publicJob = (job: typeof prepare) =>
    job
      ? {
          id: job.id,
          kind: job.kind,
          status: job.status,
          stage: job.stage,
          progress: job.progress,
          errorCode: job.errorCode,
          errorMessage: job.errorMessage,
          cancelRequested: job.cancelRequested,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
        }
      : null;

  return {
    id: match.id,
    title: match.title,
    opponentName: match.opponentName,
    playedOn: match.playedOn,
    cameraType: match.cameraType,
    createdAt: match.createdAt,
    status: deriveMatchStatus(video, prepare, analyze, !!calibration),
    // Explicit allow-list of fields: storage keys and upload ids never leave the server.
    video: video
      ? {
          id: video.id,
          status: video.status,
          originalFilename: video.originalFilename,
          sizeBytes: video.sizeBytes ?? video.declaredSizeBytes,
          durationSeconds: video.durationSeconds,
          width: video.width,
          height: video.height,
          fps: video.fps,
          rejectionReason: video.rejectionReason,
          frameCount: Array.isArray(video.frames) ? video.frames.length : 0,
          deleteAfter: video.deleteAfter,
        }
      : null,
    prepareJob: publicJob(prepare),
    analysisJob: publicJob(analyze),
    calibration: calibration
      ? {
          id: calibration.id,
          points: (calibration.points as unknown[]).length,
          rmsErrorM: calibration.rmsErrorM,
          looErrorM: calibration.looErrorM,
          createdAt: calibration.createdAt,
        }
      : null,
  };
}

export type MatchDetail = Awaited<ReturnType<typeof getMatch>>;

/**
 * Soft delete: the match disappears for users immediately. The worker's maintenance sweep purges
 * its footage and rows after a grace period (see worker/fa_worker/maintenance.py).
 */
export async function deleteMatch(db: DbOrTx, actor: Actor, matchId: string) {
  assertCan(actor, "match.delete");
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(matches)
      .set({ deletedAt: new Date() })
      .where(and(eq(matches.id, matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)))
      .returning({ id: matches.id, title: matches.title });
    if (updated.length === 0) throw notFound("Match");
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "match.deleted", targetType: "match", targetId: matchId });
  });
}
