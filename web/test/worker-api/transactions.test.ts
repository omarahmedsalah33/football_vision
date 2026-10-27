/** Opt-in isolated tenant fixtures. Never migrates schemas or claims another tenant's jobs. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "@/server/db/client";
import { analysisJobs, analysisResults, analysisTracks, matches, organizations, usagePeriods, videos } from "@/server/db/schema";
import { claimWorkerJob, updateWorkerJob, WorkerConflict } from "@/server/jobs/worker-service";
import { cleanupWorkerCheckpoints } from "@/server/jobs/worker-maintenance";
import { workerRequest } from "@/server/jobs/worker-contract";
const deleteObject = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/storage/s3", () => ({ getStorage: () => ({ deleteObject }) }));
const url = process.env.WORKER_API_INTEGRATION_TEST_DATABASE_URL;
describe.skipIf(!url)("real PostgreSQL worker protocol (isolated test tenants)", () => {
  const { db, pool } = createDb(url!);
  const owned: string[] = [];
  beforeAll(async () => { await db.execute("select 1"); });
  afterAll(async () => {
    for (const id of owned) await db.delete(organizations).where(eq(organizations.id, id));
    await pool.end();
  });
  async function fixture(kind: "analyze" | "prepare" = "analyze") {
    const [org] = await db.insert(organizations).values({ name: "Worker protocol test", slug: `worker-test-${randomUUID()}`, kind: "club" }).returning();
    owned.push(org.id);
    const [match] = await db.insert(matches).values({ orgId: org.id, title: "Synthetic protocol fixture" }).returning();
    const videoId = randomUUID(), key = `orgs/${org.id}/matches/${match.id}/videos/${videoId}/source`;
    const [video] = await db.insert(videos).values({ id: videoId, orgId: org.id, matchId: match.id,
      storageKey: key, status: kind === "prepare" ? "uploaded" : "validated",
      declaredSizeBytes: 100, sizeBytes: 100, partSizeBytes: 100, partCount: 1, durationSeconds: 12,
    }).returning();
    await db.insert(usagePeriods).values({ orgId: org.id, periodStart: "2026-10-01", analysesReserved: kind === "analyze" ? 1 : 0 });
    const [job] = await db.insert(analysisJobs).values({ orgId: org.id, matchId: match.id, videoId: video.id,
      kind, idempotencyKey: randomUUID(), usagePeriodStart: kind === "analyze" ? "2026-10-01" : null,
      usageSettled: kind === "prepare", config: { engine: "llm", maxDurationSeconds: 60 },
    }).returning();
    const root = `orgs/${org.id}/matches/${match.id}/analysis/${job.id}/`;
    return { org, match, video, job, root, owner: `test-${randomUUID()}` };
  }
  function summary(photo: string) {
    return { pipeline: "llm-video-v1", models: { events: "gemini-3.8-flash", review: "gpt-6-astra" },
      settings: { sampleFps: 10, windowSeconds: 20 }, pitch: { length: 0, width: 0, playersPerSide: 0 },
      provenance: { speed: "not_available" }, teamShape: [], durationSeconds: 12,
      quality: { calibration: {}, detection: { framesAnalysed: 0, meanPeoplePerFrame: 0 },
        tracking: { tracks: 0, medianTrackSeconds: 0, meanCoverage: 0, tracksPerExpectedPerson: 0 },
        teams: { a: 0, b: 0, other: 1 }, teamShape: { windows: 0, windowsWithBothTeams: 0 },
        camera: { mode: "moving" }, processingSeconds: 1 },
      videoEvents: { version: 1, durationSeconds: 12, totalWindows: 1, completedWindows: 1,
        models: { events: "gemini-3.8-flash" }, policy: "synthetic fixture",
        catalog: [{ id: "Unknown1", description: "Synthetic reference", photoKey: photo }],
        players: [{ id: "Unknown1", passes: 0, carries: 0, shots: 0, goals: 0, pending: 0, perMinute: [] }],
        events: [], audit: { reviewed: 0, candidates: 0, limit: 6 } } };
  }
  it("claims once under concurrency, retains a lost-response lease, rejects a different owner", async () => {
    const f = await fixture();
    const claims = await Promise.all([claimWorkerJob(db, f.owner, f.job.id), claimWorkerJob(db, "other", f.job.id)]);
    expect(claims.filter(c => c.job)).toHaveLength(1);
    const owner = claims[0].job ? f.owner : "other";
    const repeated = await claimWorkerJob(db, owner, f.job.id);
    expect(repeated.job?.attempts).toBe(1);
    await expect(updateWorkerJob(db, { op: "heartbeat", workerId: "intruder", jobId: f.job.id })).rejects.toBeInstanceOf(WorkerConflict);
  });
  it("commits report + success + quota once, without creating fake tracking rows", async () => {
    const f = await fixture();
    await claimWorkerJob(db, f.owner, f.job.id);
    await updateWorkerJob(db, { op: "outputs", workerId: f.owner, jobId: f.job.id, count: 1 });
    const request = workerRequest.parse({ op: "complete_analysis", workerId: f.owner, jobId: f.job.id,
      models: { events: "gemini-3.8-flash" }, summary: summary(f.root + "players/1.jpg") });
    if (request.op !== "complete_analysis") throw new Error("Bad test request");
    expect(await updateWorkerJob(db, request)).toEqual({ status: "succeeded" });
    await expect(updateWorkerJob(db, request)).rejects.toBeInstanceOf(WorkerConflict);
    const [usage] = await db.select().from(usagePeriods).where(eq(usagePeriods.orgId, f.org.id));
    expect([usage.analysesReserved, usage.analysesUsed]).toEqual([0, 1]);
    expect(await db.select().from(analysisResults).where(eq(analysisResults.jobId, f.job.id))).toHaveLength(1);
    expect(await db.select().from(analysisTracks).where(eq(analysisTracks.jobId, f.job.id))).toHaveLength(0);
  });
  it("keeps cancellation out of results, refunds once, and preserves retry reservations", async () => {
    const f = await fixture();
    await claimWorkerJob(db, f.owner, f.job.id);
    expect(await updateWorkerJob(db, { op: "fail", workerId: f.owner, jobId: f.job.id, code: "ai_provider_timeout",
      retryable: true, rejectVideo: false })).toEqual({ status: "queued" });
    const [failure] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, f.job.id));
    expect(failure.errorCode).toBe("ai_provider_timeout");
    expect(failure.errorMessage).toContain("timed out");
    const [reserved] = await db.select().from(usagePeriods).where(eq(usagePeriods.orgId, f.org.id));
    expect(reserved.analysesReserved).toBe(1);
    await db.update(analysisJobs).set({ runAfter: new Date(0) }).where(eq(analysisJobs.id, f.job.id));
    await claimWorkerJob(db, f.owner, f.job.id);
    await db.update(analysisJobs).set({ cancelRequested: true }).where(eq(analysisJobs.id, f.job.id));
    expect(await updateWorkerJob(db, { op: "heartbeat", workerId: f.owner, jobId: f.job.id })).toEqual({ cancelRequested: true });
    expect(await updateWorkerJob(db, { op: "cancel", workerId: f.owner, jobId: f.job.id })).toEqual({ status: "cancelled" });
    const [usage] = await db.select().from(usagePeriods).where(eq(usagePeriods.orgId, f.org.id));
    expect([usage.analysesReserved, usage.analysesUsed]).toEqual([0, 0]);
    expect(await db.select().from(analysisResults).where(eq(analysisResults.jobId, f.job.id))).toHaveLength(0);
  });
  it("fences checkpoint paths and cleans only terminal, registered checkpoint objects", async () => {
    const f = await fixture(), hash = "a".repeat(64);
    await claimWorkerJob(db, f.owner, f.job.id);
    const entry = { binding: hash, sha256: hash, size: 10, name: `llm-${hash}.json.gz`,
      key: `${f.root}checkpoints/${hash}/llm-${hash}.json.gz` };
    await expect(updateWorkerJob(db, { op: "checkpoints", jobId: f.job.id, workerId: f.owner,
      entries: [{ ...entry, key: "orgs/another-tenant/private" }] })).rejects.toBeInstanceOf(WorkerConflict);
    await updateWorkerJob(db, { op: "checkpoints", jobId: f.job.id, workerId: f.owner, entries: [entry] });
    expect(await cleanupWorkerCheckpoints(db, f.job.id)).toEqual({ deleted: 0 });
    await updateWorkerJob(db, { op: "cancel", jobId: f.job.id, workerId: f.owner });
    expect(await cleanupWorkerCheckpoints(db, f.job.id)).toEqual({ deleted: 1 });
    expect(deleteObject).toHaveBeenCalledWith(entry.key);
  });
  it("validates prepare metadata without calibration or a worker database connection", async () => {
    const f = await fixture("prepare");
    await claimWorkerJob(db, f.owner, f.job.id);
    const request = workerRequest.parse({ op: "complete_prepare", jobId: f.job.id, workerId: f.owner,
      info: { container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264", duration_seconds: 12, width: 640, height: 360, fps: 30 },
      frames: [{ key: f.video.storageKey.replace("/source", "/frames/frame_0.jpg"), timeSeconds: 1, width: 640, height: 360 }],
      cameraMotion: "moving", models: { pipeline: "v0.2-prepare", stages: ["validate"] } });
    if (request.op !== "complete_prepare") throw new Error("Bad test request");
    expect(await updateWorkerJob(db, request)).toEqual({ status: "succeeded" });
    const [video] = await db.select().from(videos).where(eq(videos.id, f.video.id));
    expect([video.status, video.durationSeconds]).toEqual(["validated", 12]);
  });
  it.skipIf(process.env.WORKER_API_HTTP_SMOKE !== "1")("runs the credential-free Python client against the actual website API", async () => {
    const f = await fixture();
    await claimWorkerJob(db, f.owner, f.job.id);
    const script = `
import json,os,sys
from dataclasses import replace
from unittest.mock import patch
from fa_worker.config import Settings
from fa_worker.website_api import WebsiteAPI
from fa_worker import queue
data=json.load(sys.stdin)
assert "DATABASE_URL" not in os.environ
s=replace(Settings.from_env(),worker_id=data["owner"])
assert s.database_url==""
api=WebsiteAPI(s)
with patch("psycopg.connect",side_effect=AssertionError("Database access forbidden")):
    assert queue.report_progress(api,data["id"],s.worker_id,"llm_events",.5) is False
    assert queue.heartbeat(api,data["id"],s.worker_id,120) is False
    api.request("outputs",jobId=data["id"],count=1)
    result=api.request("complete_analysis",jobId=data["id"],summary=data["summary"],models={"events":"gemini-3.8-flash"})
    assert result["status"]=="succeeded"
print("HTTP worker completed without database credentials")
`;
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH, HOME: process.env.HOME, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      NIX_LD: process.env.NIX_LD, NIX_LD_LIBRARY_PATH: process.env.NIX_LD_LIBRARY_PATH,
      PYTHONPATH: resolve(process.cwd(), "../worker"), STORAGE_PROVIDER: "replit",
      WORKER_API_URL: `https://${process.env.REPLIT_DEV_DOMAIN}/api/internal/worker-jobs`,
      WORKER_STORAGE_URL: `https://${process.env.REPLIT_DEV_DOMAIN}/api/internal/worker-storage`,
      WORKER_STORAGE_TOKEN: process.env.WORKER_STORAGE_TOKEN,
    };
    const result = spawnSync("python", ["-c", script], {
      env, input: JSON.stringify({ id: f.job.id, owner: f.owner, summary: summary(f.root + "players/1.jpg") }),
      encoding: "utf8", timeout: 90000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("without database credentials");
    const [saved] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, f.job.id));
    expect(saved.status).toBe("succeeded");
  });
});
