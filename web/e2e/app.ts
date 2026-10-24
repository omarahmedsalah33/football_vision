import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Opens the app; new accounts see the welcome step once, which these tests skip. */
export async function openApp(page: Page) {
  await page.goto("/app");
  await page.waitForURL(/\/app\/(welcome|[^/]+)$/);
  if (page.url().endsWith("/app/welcome")) {
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.waitForURL(/\/app\/(?!welcome)[^/]+$/);
  }
}

/**
 * The player report UI with a seeded analysis (the E2E fixture video is too simple for the real
 * detector to find people). Numbers are synthetic and only exercise the interface.
 */
export async function seedAnalysis(matchId: string) {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query("select org_id from matches where id = $1", [matchId]);
    const orgId = rows[0].org_id as string;
    const v = await db.query(
      `insert into videos (org_id, match_id, storage_key, declared_size_bytes, size_bytes, part_size_bytes, part_count, status,
                           duration_seconds, width, height, fps, camera_motion)
       values ($1, $2, $3, 1000, 1000, 1000, 1, 'validated', 1800, 1920, 1080, 25, 'fixed') returning id`,
      [orgId, matchId, `e2e/${randomUUID()}`],
    );
    const videoId = v.rows[0].id as string;
    await db.query(
      `insert into calibrations (org_id, match_id, video_id, points, homography, image_width, image_height, rms_error_m, loo_error_m, frame_time_seconds)
       values ($1, $2, $3, '[]', '{"matrix":[0.05,0,0,0,0.05,0,0,0,1],"pitch":{"length":105,"width":68}}', 1920, 1080, 0.3, 0.5, 10)`,
      [orgId, matchId, videoId],
    );
    const j = await db.query(
      `insert into analysis_jobs (org_id, match_id, video_id, kind, idempotency_key, status, progress, usage_period_start, usage_settled, finished_at)
       values ($1, $2, $3, 'analyze', $4, 'succeeded', 1, date_trunc('month', now())::date, true, now()) returning id`,
      [orgId, matchId, videoId, `e2e-${randomUUID()}`],
    );
    const jobId = j.rows[0].id as string;
    const shape = (w: number) => ({ width: w, depth: 32, line_height: 18, area: 900, players: 10 });
    const summary = {
      pipeline: "e2e-seed",
      models: { detector: "seeded", tracker: "seeded", teams: "seeded" },
      settings: { sampleFps: 4, windowSeconds: 10 },
      pitch: { length: 105, width: 68, playersPerSide: 11 },
      provenance: { team_width: "measured", team_depth: "measured", line_height: "measured", team_area: "measured", average_position: "measured", distance_covered: "estimated", heatmap: "estimated", formation: "not_available", passes: "not_available", shots: "not_available", xg: "not_available" },
      quality: {
        calibration: { rmsErrorM: 0.3, looErrorM: 0.5 },
        detection: { framesAnalysed: 7200, meanPeoplePerFrame: 19.5, minPeople: 16, shareFramesUnderMinPeople: 0.1 },
        tracking: { tracks: 13, medianTrackSeconds: 900, meanCoverage: 0.9, tracksPerExpectedPerson: 0.52, fragmentsJoined: 9 },
        teams: { a: 6, b: 6, other: 1, separation: 40 },
        teamShape: { windows: 6, windowsWithBothTeams: 6 },
        camera: { mode: "fixed" },
        processingSeconds: 1200,
      },
      teamShape: Array.from({ length: 6 }, (_, k) => ({ start: k * 10, end: (k + 1) * 10, frames: 40, a: shape(44 + k), b: shape(48 - k) })),
      durationSeconds: 1800,
    };
    await db.query(`insert into analysis_results (job_id, org_id, match_id, summary) values ($1, $2, $3, $4)`, [jobId, orgId, matchId, summary]);
    const players = [
      // [team, avgX, distance/min, hi/min, top m/s, sprints, late/early]
      ["a", 5, 45, 0.5, 5.2, 0, 1.0],
      ["a", 28, 128, 11, 8.6, 14, 0.99],
      ["a", 30, 112, 7, 8.0, 9, 0.9],
      ["a", 45, 118, 8, 7.6, 8, 0.92],
      ["a", 55, 96, 3, 6.4, 2, 0.72],
      ["a", 70, 104, 9, 8.3, 11, 0.85],
      ["b", 100, 47, 0.4, 5.0, 0, 1.0],
      ["b", 75, 109, 6, 7.4, 6, 0.9],
      ["b", 72, 121, 10, 8.4, 12, 0.95],
      ["b", 60, 100, 4, 7.0, 4, 0.88],
      ["b", 50, 93, 2.5, 6.6, 2, 0.78],
      ["b", 38, 115, 8.5, 8.1, 10, 0.93],
      ["other", 52, 90, 1, 6, 0, 0.9],
    ] as const;
    for (const [i, [team, x, dpm, hpm, top, sprints, late]] of players.entries()) {
      const minutes = 28;
      const heat = Array.from({ length: 14 }, (_, iy) => Array.from({ length: 21 }, (_, ix) => (Math.abs(ix * 5 + 2.5 - x) < 12 && Math.abs(iy * 5 + 2.5 - 34) < 15 ? 10 : 0)));
      const metrics = { minutes, distance_m: dpm * minutes, distance_per_min: dpm, hi_distance_m: hpm * minutes, hi_per_min: hpm, sprints, sprints_per_10min: (sprints / minutes) * 10, top_speed_ms: top, late_vs_early: late, fragments: 2 };
      await db.query(
        `insert into analysis_tracks (job_id, org_id, track_no, team, first_seconds, last_seconds, coverage, avg_x, avg_y, distance_m, heatmap, metrics)
         values ($1, $2, $3, $4, 0, 1700, 0.95, $5, 34, $6, $7, $8)`,
        [jobId, orgId, i + 1, team, x, dpm * minutes, JSON.stringify(heat), metrics],
      );
    }
  } finally {
    await db.end();
  }
}

