/** Existing 24-hour abandoned-upload / 7-day deletion-grace policy, now website-owned. */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { analysisJobs, analysisResults, analysisTracks, matches, organizations, videos } from "../db/schema";
import { getStorage } from "../storage/s3";
import { checkpointEntry } from "./worker-contract";

function scoped(key: unknown, prefix: string): key is string {
  return typeof key === "string" && key.startsWith(prefix) && !key.split("/").some(p => p === ".." || p === ".");
}
async function remove(keys: string[]) {
  const store = getStorage();
  // Bound storage concurrency and preserve metadata on any failed deletion.
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 8)
    await Promise.all(unique.slice(i, i + 8).map(key => store.deleteObject(key)));
}

export async function cleanupWorkerCheckpoints(db: DbOrTx, jobId: string) {
  return db.transaction(async tx => {
    const [job] = await tx.select().from(analysisJobs).where(and(
      eq(analysisJobs.id, jobId), sql`${analysisJobs.status} not in ('queued','running')`,
    )).for("update");
    if (!job) return { deleted: 0 };
    const config = job.config as Record<string, unknown>;
    if (!Array.isArray(config._workerCheckpoints)) return { deleted: 0 };
    const entries = config._workerCheckpoints.slice(0, 50).map(value => checkpointEntry.parse(value));
    const prefix = `orgs/${job.orgId}/matches/${job.matchId}/analysis/${job.id}/checkpoints/`;
    if (entries.some(e => e.key !== `${prefix}${e.binding}/${e.name}` || !e.name.includes(e.sha256)))
      throw new Error("Invalid private checkpoint metadata.");
    await remove(entries.map(e => e.key));
    const next = { ...config };
    const remaining = config._workerCheckpoints.slice(entries.length);
    if (remaining.length) next._workerCheckpoints = remaining;
    else delete next._workerCheckpoints;
    await tx.update(analysisJobs).set({ config: next }).where(eq(analysisJobs.id, job.id));
    return { deleted: entries.length };
  });
}

async function purgeMedia(tx: DbOrTx, scope: { orgId: string; matchId?: string; videoId?: string }, all: boolean) {
  const prefix = `orgs/${scope.orgId}/` + (scope.matchId ? `matches/${scope.matchId}/` : "");
  const condition = (table: typeof analysisJobs | typeof videos | typeof analysisResults) =>
    and(eq(table.orgId, scope.orgId), ...(scope.matchId ? [eq(table.matchId, scope.matchId)] : []));
  const jobs = await tx.select().from(analysisJobs).where(and(condition(analysisJobs),
    ...(scope.videoId ? [eq(analysisJobs.videoId, scope.videoId)] : [])));
  if (jobs.some(j => j.status === "queued" || j.status === "running")) return false;
  const media = await tx.select().from(videos).where(and(condition(videos),
    ...(scope.videoId ? [eq(videos.id, scope.videoId)] : [])));
  const keys: unknown[] = [];
  for (const v of media) {
    if (v.multipartUploadId) await getStorage().abortMultipartUpload(v.storageKey, v.multipartUploadId);
    keys.push(v.storageKey, ...(Array.isArray(v.frames) ? v.frames.map(f => (f as { key?: string }).key) : []));
  }
  for (const job of jobs) {
    const config = job.config as { _videoOutputs?: { photos?: string[]; ledger?: string };
      _workerCheckpoints?: { key: string }[] };
    keys.push(...(config._videoOutputs?.photos ?? []), ...(config._workerCheckpoints ?? []).map(e => e.key));
    if (all && config._videoOutputs?.ledger) keys.push(config._videoOutputs.ledger);
  }
  const ids = jobs.map(j => j.id);
  if (ids.length) {
    const tracks = await tx.select({ key: analysisTracks.cropKey }).from(analysisTracks).where(inArray(analysisTracks.jobId, ids));
    keys.push(...tracks.map(t => t.key).filter(Boolean));
    if (all) {
      const results = await tx.select({ key: analysisResults.tracksKey }).from(analysisResults).where(inArray(analysisResults.jobId, ids));
      keys.push(...results.map(r => r.key).filter(Boolean));
    }
  }
  if (keys.some(k => !scoped(k, prefix))) throw new Error("Invalid private media metadata.");
  await remove(keys as string[]);
  if (!all && scope.videoId) {
    await tx.update(videos).set({ status: "purged" }).where(eq(videos.id, scope.videoId));
    if (ids.length) {
      await tx.update(analysisTracks).set({ cropKey: null }).where(inArray(analysisTracks.jobId, ids));
      const results = await tx.select().from(analysisResults).where(inArray(analysisResults.jobId, ids));
      for (const result of results) {
        const summary = result.summary as { videoEvents?: { catalog?: { photoKey: string | null }[] } };
        if (summary.videoEvents?.catalog) {
          summary.videoEvents.catalog.forEach(p => { p.photoKey = null; });
          await tx.update(analysisResults).set({ summary }).where(eq(analysisResults.jobId, result.jobId));
        }
      }
      for (const job of jobs) {
        const config = { ...(job.config as Record<string, unknown>) };
        delete config._workerCheckpoints;
        const outputs = config._videoOutputs as { ledger?: string } | undefined;
        if (outputs) config._videoOutputs = { photos: [], ledger: outputs.ledger };
        await tx.update(analysisJobs).set({ config }).where(eq(analysisJobs.id, job.id));
      }
    }
  }
  return true;
}

export async function maintainWorkerMedia(db: DbOrTx) {
  // A transaction-scoped advisory lock cannot leak across pooled website connections.
  return db.transaction(async tx => {
    const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(7310442) as ok`);
    if (!lock.rows[0]?.ok) return { busy: true };
    let changed = 0;
    const abandoned = await tx.select().from(videos).where(and(eq(videos.status, "uploading"),
      sql`${videos.createdAt} < now() - interval '24 hours'`)).limit(5).for("update", { skipLocked: true });
    for (const v of abandoned) {
      if (v.multipartUploadId) await getStorage().abortMultipartUpload(v.storageKey, v.multipartUploadId);
      await tx.update(videos).set({ status: "aborted", multipartUploadId: null }).where(eq(videos.id, v.id));
      changed++;
    }
    const expired = await tx.select().from(videos).where(and(inArray(videos.status, ["uploaded", "validated"]),
      sql`${videos.deleteAfter} < now()`,
      sql`not exists(select 1 from analysis_jobs j where j.video_id=${videos.id} and j.status in ('queued','running'))`,
    )).limit(5).for("update", { skipLocked: true });
    for (const v of expired)
      if (await purgeMedia(tx, { orgId: v.orgId, matchId: v.matchId, videoId: v.id }, false)) changed++;
    const deletedMatches = await tx.select().from(matches).where(
      sql`${matches.deletedAt} < now() - interval '7 days'`).limit(2).for("update", { skipLocked: true });
    for (const m of deletedMatches) if (await purgeMedia(tx, { orgId: m.orgId, matchId: m.id }, true)) {
      await tx.delete(matches).where(eq(matches.id, m.id)); changed++;
    }
    const deletedOrgs = await tx.select().from(organizations).where(
      sql`${organizations.deletedAt} < now() - interval '7 days'`).limit(1).for("update", { skipLocked: true });
    for (const o of deletedOrgs) if (await purgeMedia(tx, { orgId: o.id }, true)) {
      await tx.delete(organizations).where(eq(organizations.id, o.id)); changed++;
    }
    return { changed };
  });
}
