import { getDb } from "@/server/db/client";
import { authorizeWorker, workerReply as reply } from "@/server/jobs/worker-auth";
import { workerRequest } from "@/server/jobs/worker-contract";
import { claimWorkerJob, reapWorkerJobs, updateWorkerJob, WorkerConflict, workerPending } from "@/server/jobs/worker-service";
import { cleanupWorkerCheckpoints, maintainWorkerMedia } from "@/server/jobs/worker-maintenance";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(req: Request) {
  const denied = authorizeWorker(req);
  if (denied) return denied;
  try {
    await reapWorkerJobs(getDb());
    return reply({ ready: true, protocol: "worker-api-v1", pending: await workerPending(getDb()) });
  } catch { return reply({ error: "Job service unavailable." }, 503); }
}
export async function POST(req: Request) {
  const denied = authorizeWorker(req);
  if (denied) return denied;
  if (Number(req.headers.get("content-length") ?? 0) > 12000000) return reply({ error: "Request too large." }, 413);
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 12000000) return reply({ error: "Request too large." }, 413);
    const parsed = workerRequest.safeParse(JSON.parse(text));
    if (!parsed.success) return reply({ error: "Invalid worker request." }, 422);
    const body = parsed.data, db = getDb();
    if (body.op === "claim") return reply(await claimWorkerJob(db, body.workerId));
    if (body.op === "maintenance") {
      await reapWorkerJobs(db);
      const result = await maintainWorkerMedia(db);
      // Bounded batches preserve private recovery metadata until every object was removed.
      const { analysisJobs } = await import("@/server/db/schema");
      const { sql } = await import("drizzle-orm");
      const terminal = await db.select({ id: analysisJobs.id }).from(analysisJobs).where(
        sql`${analysisJobs.status} not in ('queued','running') and ${analysisJobs.config} ? '_workerCheckpoints'`,
      ).limit(5);
      for (const job of terminal) await cleanupWorkerCheckpoints(db, job.id);
      return reply(result);
    }
    if (body.op === "cleanup") return reply(await cleanupWorkerCheckpoints(db, body.jobId));
    return reply(await updateWorkerJob(db, body));
  } catch (error) {
    if (error instanceof WorkerConflict) {
      // Only server-owned codes/reasons; never log the report, headers or provider responses.
      console.warn("worker_job_rejected", { code: error.code, reason: error.reason });
      return reply({ error: error.message, code: error.code, reason: error.reason }, 409);
    }
    if (error instanceof SyntaxError) return reply({ error: "Invalid JSON." }, 422);
    // Provider responses, SQL errors, connection strings and headers never leave the website.
    return reply({ error: "Job operation did not complete. Saved progress is retained." }, 503);
  }
}
