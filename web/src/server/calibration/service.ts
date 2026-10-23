import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { CalibrationError, fitHomography, leaveOneOutError, residuals, rmsError, type Correspondence } from "@/lib/pitch/homography";
import { LANDMARK_BY_ID } from "@/lib/pitch/landmarks";
import { assertCan, type Actor } from "../authz/permissions";
import type { DbOrTx } from "../db/client";
import { calibrations, matches, videos } from "../db/schema";
import { AppError, conflict, invalidInput, notFound } from "../http/errors";
import type { ObjectStorage } from "../storage/s3";

/** A calibration whose landmarks disagree by more than this is almost certainly a misplaced click. */
export const MAX_CALIBRATION_ERROR_M = 3;

export const calibrationInput = z.object({
  // Laws of the Game ranges for 11-a-side, with a little slack for youth pitches.
  pitchLength: z.number().min(50).max(120),
  pitchWidth: z.number().min(30).max(90),
  points: z
    .array(z.object({ landmark: z.string().max(40), x: z.number().finite(), y: z.number().finite() }))
    .min(4)
    .max(30),
});

export type FrameRef = { key: string; timeSeconds: number; width: number; height: number };

async function loadVideo(db: DbOrTx, actor: Actor, matchId: string) {
  const [row] = await db
    .select({ video: videos })
    .from(videos)
    .innerJoin(matches, eq(matches.id, videos.matchId))
    .where(and(eq(videos.matchId, matchId), eq(videos.orgId, actor.orgId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)))
    .orderBy(desc(videos.createdAt))
    .limit(1);
  if (!row) throw notFound("Match");
  return row.video;
}

/** Everything the calibration page needs: signed frame URLs, video size and the latest calibration. */
export async function calibrationContext(db: DbOrTx, storage: ObjectStorage, actor: Actor, matchId: string) {
  assertCan(actor, "match.read");
  const video = await loadVideo(db, actor, matchId);
  const frames = (video.frames as FrameRef[]) ?? [];
  const [latest] = await db
    .select()
    .from(calibrations)
    .where(and(eq(calibrations.orgId, actor.orgId), eq(calibrations.videoId, video.id)))
    .orderBy(desc(calibrations.createdAt))
    .limit(1);
  return {
    videoStatus: video.status,
    width: video.width,
    height: video.height,
    frames: await Promise.all(
      frames.map(async (f) => ({ timeSeconds: f.timeSeconds, width: f.width, height: f.height, url: await storage.presignGet(f.key, "image/jpeg", 600) })),
    ),
    latest: latest
      ? {
          points: latest.points as { landmark: string; image: [number, number]; pitch: [number, number] }[],
          pitchLength: (latest.homography as { pitch?: { length: number } }).pitch?.length ?? 105,
          pitchWidth: (latest.homography as { pitch?: { width: number } }).pitch?.width ?? 68,
          rmsErrorM: latest.rmsErrorM,
          looErrorM: latest.looErrorM,
          createdAt: latest.createdAt,
        }
      : null,
  };
}

/**
 * Fits and stores a calibration. The server recomputes everything from the clicked points; nothing
 * computed in the browser is trusted.
 */
export async function saveCalibration(db: DbOrTx, actor: Actor, matchId: string, input: z.infer<typeof calibrationInput>) {
  assertCan(actor, "match.update");
  const video = await loadVideo(db, actor, matchId);
  if (video.status !== "validated" || !video.width || !video.height) {
    throw conflict("The video must finish its checks before it can be calibrated.");
  }

  const pitch = { length: input.pitchLength, width: input.pitchWidth };
  const seen = new Set<string>();
  const points: (Correspondence & { landmark: string })[] = input.points.map((p) => {
    const landmark = LANDMARK_BY_ID.get(p.landmark);
    if (!landmark) throw invalidInput(`Unknown landmark "${p.landmark}".`);
    if (seen.has(p.landmark)) throw invalidInput(`"${landmark.label}" was marked twice.`);
    seen.add(p.landmark);
    if (p.x < 0 || p.y < 0 || p.x > video.width! || p.y > video.height!) throw invalidInput(`"${landmark.label}" is outside the frame.`);
    return { landmark: p.landmark, image: [p.x, p.y], pitch: landmark.at(pitch) };
  });

  let H;
  try {
    H = fitHomography(points);
  } catch (err) {
    if (err instanceof CalibrationError) throw invalidInput(err.message);
    throw err;
  }
  const rms = rmsError(H, points);
  const loo = leaveOneOutError(points);
  const quality = loo ?? rms;
  if (!Number.isFinite(quality) || quality > MAX_CALIBRATION_ERROR_M) {
    const res = residuals(H, points);
    const worst = points[res.indexOf(Math.max(...res))];
    throw new AppError(
      422,
      "calibration_inconsistent",
      `The landmarks don't agree with each other (error ${quality.toFixed(1)} m). Check "${LANDMARK_BY_ID.get(worst.landmark)!.label}".`,
      { errorM: quality, worstLandmark: worst.landmark },
    );
  }

  const [row] = await db
    .insert(calibrations)
    .values({
      orgId: actor.orgId,
      matchId,
      videoId: video.id,
      points: points.map((p) => ({ landmark: p.landmark, image: p.image, pitch: p.pitch })),
      homography: { matrix: H, pitch },
      imageWidth: video.width,
      imageHeight: video.height,
      rmsErrorM: rms,
      looErrorM: loo,
      createdBy: actor.userId,
    })
    .returning();
  return { id: row.id, rmsErrorM: rms, looErrorM: loo };
}
