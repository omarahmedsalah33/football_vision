import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { assertPlausible, CalibrationError, fitHomography, leaveOneOutError, residuals, rmsError, type Correspondence } from "@/lib/pitch/homography";
import { LANDMARK_BY_ID, landmarksFor, PLAYERS_PER_SIDE } from "@/lib/pitch/landmarks";
import { assertCan, type Actor } from "../authz/permissions";
import type { DbOrTx } from "../db/client";
import { calibrations, matches, videos } from "../db/schema";
import { AppError, conflict, invalidInput, notFound } from "../http/errors";
import type { ObjectStorage } from "../storage/s3";

/** A calibration whose landmarks disagree by more than this is almost certainly a misplaced click. */
export const MAX_CALIBRATION_ERROR_M = 3;

/** Fewer points fit "exactly" and can't reveal a misplaced click, so a calibration needs at least 5. */
export const MIN_CALIBRATION_POINTS = 5;

export const calibrationInput = z.object({
  // From small 5-a-side cages up to the largest 11-a-side pitch the Laws allow.
  pitchLength: z.number().min(20).max(120),
  pitchWidth: z.number().min(12).max(90),
  playersPerSide: z.union(PLAYERS_PER_SIDE.map((n) => z.literal(n))).default(11),
  // The reference frame the points were clicked on (seconds into the video).
  frameTimeSeconds: z.number().min(0).max(86_400).optional(),
  points: z
    .array(z.object({ landmark: z.string().max(40), x: z.number().finite(), y: z.number().finite() }))
    .min(MIN_CALIBRATION_POINTS, `Mark at least ${MIN_CALIBRATION_POINTS} points so the calibration can check itself.`)
    .max(30),
});

type StoredHomography = { matrix: number[]; pitch?: { length: number; width: number; playersPerSide?: number } };

function pitchOf(homography: unknown) {
  const p = (homography as StoredHomography).pitch;
  return { length: p?.length ?? 105, width: p?.width ?? 68, playersPerSide: p?.playersPerSide ?? 11 };
}

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
  const moving = video.cameraMotion === "moving";
  return {
    videoStatus: video.status,
    cameraMotion: (video.cameraMotion ?? null) as "fixed" | "moving" | "unknown" | null,
    width: video.width,
    height: video.height,
    frames: await Promise.all(
      frames.map(async (f) => ({ timeSeconds: f.timeSeconds, width: f.width, height: f.height, url: await storage.presignGet(f.key, "image/jpeg", 600) })),
    ),
    latest: latest ? toSaved(latest) : null,
    // A moving camera's view changes from match to match, so earlier clicks don't apply.
    reusable: !moving && video.width && video.height ? await reusableCalibrations(db, actor, matchId, video.width, video.height) : [],
  };
}

function toSaved(row: typeof calibrations.$inferSelect) {
  const pitch = pitchOf(row.homography);
  return {
    points: row.points as { landmark: string; image: [number, number]; pitch: [number, number] }[],
    pitchLength: pitch.length,
    pitchWidth: pitch.width,
    playersPerSide: pitch.playersPerSide,
    frameTimeSeconds: row.frameTimeSeconds,
    rmsErrorM: row.rmsErrorM,
    looErrorM: row.looErrorM,
    createdAt: row.createdAt,
  };
}

/**
 * The latest calibration of other recent matches in this workspace filmed at the same resolution:
 * with the camera in the same spot, the same clicks apply. The user still confirms by eye.
 */
async function reusableCalibrations(db: DbOrTx, actor: Actor, matchId: string, width: number, height: number) {
  const rows = await db
    .select({ calibration: calibrations, title: matches.title, playedOn: matches.playedOn })
    .from(calibrations)
    .innerJoin(matches, eq(matches.id, calibrations.matchId))
    .where(
      and(
        eq(calibrations.orgId, actor.orgId),
        eq(matches.orgId, actor.orgId),
        isNull(matches.deletedAt),
        ne(calibrations.matchId, matchId),
        eq(calibrations.imageWidth, width),
        eq(calibrations.imageHeight, height),
      ),
    )
    .orderBy(desc(calibrations.createdAt))
    .limit(40);
  const seen = new Set<string>();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.calibration.matchId)) continue; // only each match's latest calibration
    seen.add(r.calibration.matchId);
    out.push({ id: r.calibration.id, matchTitle: r.title, playedOn: r.playedOn, ...toSaved(r.calibration) });
    if (out.length === 5) break;
  }
  return out;
}

/**
 * Fits and stores a calibration. The server recomputes everything from the clicked points; nothing
 * computed in the browser is trusted.
 */
export async function saveCalibration(db: DbOrTx, actor: Actor, matchId: string, raw: z.input<typeof calibrationInput>) {
  assertCan(actor, "match.update");
  const parsed = calibrationInput.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error.issues[0]?.message ?? "Invalid calibration.");
  const input = parsed.data;
  const video = await loadVideo(db, actor, matchId);
  if (video.status !== "validated" || !video.width || !video.height) {
    throw conflict("The video must finish its checks before it can be calibrated.");
  }

  const frames = (video.frames as FrameRef[]) ?? [];
  const frame = input.frameTimeSeconds === undefined ? undefined : frames.find((f) => Math.abs(f.timeSeconds - input.frameTimeSeconds!) < 0.05);
  if (input.frameTimeSeconds !== undefined && !frame) throw invalidInput("The points must be marked on one of the frames shown.");
  if (video.cameraMotion === "moving" && !frame) {
    throw invalidInput("This video was filmed with a moving camera: mark all points on one frame.");
  }
  const pitch = { length: input.pitchLength, width: input.pitchWidth };
  if (input.pitchWidth > input.pitchLength) throw invalidInput("The pitch length (goal to goal) must be longer than its width.");
  const allowed = new Set(landmarksFor(pitch, input.playersPerSide).map((l) => l.id));
  const seen = new Set<string>();
  const points: (Correspondence & { landmark: string })[] = input.points.map((p) => {
    const landmark = LANDMARK_BY_ID.get(p.landmark);
    if (!landmark) throw invalidInput(`Unknown landmark "${p.landmark}".`);
    if (!allowed.has(p.landmark)) {
      throw invalidInput(`"${landmark.label}" only exists on full-size 11-a-side pitches (at least 90 × 45 m).`);
    }
    if (seen.has(p.landmark)) throw invalidInput(`"${landmark.label}" was marked twice.`);
    seen.add(p.landmark);
    if (p.x < 0 || p.y < 0 || p.x > video.width! || p.y > video.height!) throw invalidInput(`"${landmark.label}" is outside the frame.`);
    return { landmark: p.landmark, image: [p.x, p.y], pitch: landmark.at(pitch) };
  });

  let H;
  try {
    H = fitHomography(points);
    assertPlausible(H, points.map((p) => p.image));
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
      homography: { matrix: H, pitch: { ...pitch, playersPerSide: input.playersPerSide } },
      imageWidth: video.width,
      imageHeight: video.height,
      rmsErrorM: rms,
      looErrorM: loo,
      frameTimeSeconds: frame?.timeSeconds ?? null,
      createdBy: actor.userId,
    })
    .returning();
  return { id: row.id, rmsErrorM: rms, looErrorM: loo };
}
