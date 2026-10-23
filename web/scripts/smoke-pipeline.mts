/**
 * Development smoke test of the full upload → queue path against local infrastructure, bypassing
 * only the identity provider. Usage:
 *   npx tsx scripts/smoke-pipeline.mts <path-to-video>
 * then run the worker (`python -m fa_worker.main --once` in worker/) and re-run with `--status <matchId>`.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

const { getDb } = await import("../src/server/db/client");
const { ensureUser, resolveActor, listMyOrgs } = await import("../src/server/orgs/service");
const { createMatch, getMatch } = await import("../src/server/matches/service");
const { startUpload, presignParts, completeUpload } = await import("../src/server/uploads/service");
const { enqueueAnalysis } = await import("../src/server/jobs/service");
const { getStorage } = await import("../src/server/storage/s3");

const db = getDb();
const user = await ensureUser(db, { subject: "smoke_test_user", displayName: "Smoke Test" });
const [org] = await listMyOrgs(db, user.id);
const actor = await resolveActor(db, user.id, org.id);

if (process.argv[2] === "--status") {
  console.log(JSON.stringify(await getMatch(db, actor, process.argv[3]), null, 2));
  process.exit(0);
}

const file = await readFile(process.argv[2]);
const match = await createMatch(db, actor, { title: `Smoke ${randomUUID().slice(0, 6)}` });
const up = await startUpload(db, getStorage(), actor, match.id, {
  filename: basename(process.argv[2]),
  sizeBytes: file.length,
  contentType: "video/mp4",
});
const urls = await presignParts(db, getStorage(), actor, up.videoId, {
  partNumbers: Array.from({ length: up.partCount }, (_, i) => i + 1),
});
const parts = [];
for (const { partNumber, url } of urls) {
  const body = file.slice((partNumber - 1) * up.partSize, partNumber * up.partSize);
  const res = await fetch(url, { method: "PUT", body });
  if (!res.ok) throw new Error(`part ${partNumber} failed: ${res.status}`);
  parts.push({ partNumber, etag: res.headers.get("etag")! });
}
await completeUpload(db, getStorage(), actor, up.videoId, { parts });
const job = await enqueueAnalysis(db, actor, match.id);
console.log(JSON.stringify({ matchId: match.id, jobId: job.id, status: job.status }));
process.exit(0);
