/** Operate one explicit development test match using the normal upload/job services. */
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../src/server/db/client";
import { analysisJobs, analysisResults, matches, memberships, organizations, subscriptions, videos } from "../src/server/db/schema";
import { getUsage, usagePeriodStart } from "../src/server/billing/entitlements";
import { getStorage } from "../src/server/storage/s3";
import { startUpload, presignParts, completeUpload } from "../src/server/uploads/service";
import { enqueuePrepare, enqueueAnalysis } from "../src/server/jobs/service";

const orgId = "6f57bef3-c6ff-4ee4-b7b8-432d3828c9b4";
const root = resolve(process.cwd(), "../..");
const statePath = resolve(root, "generated-artifacts/three-minute-test-state.json");
const clipPath = resolve(root, "generated-artifacts/football-first-three-minutes.mp4");
type State = { orgId: string; matchId: string; videoId: string; prepareId?: string; analysisId?: string };

async function main() {
  if (process.env.REPLIT_DEPLOYMENT || !process.env.REPLIT_DEV_DOMAIN) throw new Error("Development only.");
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org || org.name !== "AI Tester Smoke Workspace") throw new Error("Test workspace not found.");
    const [member] = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")));
    if (!member) throw new Error("Test owner not found.");
    const actor = { orgId, userId: member.userId, role: "owner" as const };
    if (process.argv[2] === "allow-test") {
      const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
      if (existing && existing.planId !== "free") throw new Error("Do not overwrite a paid subscription.");
      const usage = await getUsage(db, orgId, usagePeriodStart());
      const fixture = { planId: "free", status: "active" as const,
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        limitOverrides: { monthlyAnalyses: usage.used + usage.reserved + 1, maxUploadBytes: 64 * 1024 * 1024,
          maxVideoDurationSeconds: 181 } };
      await db.insert(subscriptions).values({ orgId, ...fixture }).onConflictDoUpdate({
        target: subscriptions.orgId, set: fixture,
      });
      console.log("One development-only test allowance enabled in the synthetic workspace.");
      return;
    }
    let state: State | null = null;
    try { state = JSON.parse(await readFile(statePath, "utf8")) as State; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const save = () => writeFile(statePath, JSON.stringify(state, null, 2));
    if (process.argv[2] === "upload") {
      if (!state) {
        const [match] = await db.insert(matches).values({ orgId, title: "First 3 minutes — Gemini + Astra test",
          cameraType: "fixed_wide", createdBy: actor.userId }).returning();
        const started = await startUpload(db, getStorage(), actor, match.id, {
          filename: "football-first-three-minutes.mp4", contentType: "video/mp4", sizeBytes: (await stat(clipPath)).size,
        });
        state = { orgId, matchId: match.id, videoId: started.videoId };
        await save();
      }
      const [video] = await db.select().from(videos).where(and(eq(videos.id, state.videoId), eq(videos.orgId, orgId)));
      if (video.status === "uploading") {
        const bytes = await readFile(clipPath);
        const parts = [];
        for (let number = 1; number <= video.partCount; number++) {
          const [signed] = await presignParts(db, getStorage(), actor, video.id, { partNumbers: [number] });
          const part = bytes.subarray((number - 1) * video.partSizeBytes, Math.min(number * video.partSizeBytes, bytes.length));
          const response = await fetch(signed.url, { method: "PUT", headers: { "Content-Length": String(part.length) },
            body: new Uint8Array(part).buffer });
          if (!response.ok) throw new Error(`Part ${number} upload failed (${response.status}).`);
          const etag = response.headers.get("etag") ??
            await getStorage().uploadPartReceipt?.(video.storageKey, video.multipartUploadId!, number, part.length);
          if (!etag) throw new Error("No authenticated part receipt.");
          parts.push({ partNumber: number, etag });
          console.log(`Uploaded part ${number}/${video.partCount}`);
        }
        await completeUpload(db, getStorage(), actor, video.id, { parts });
      }
      if (!state.prepareId) {
        state.prepareId = (await enqueuePrepare(db, actor, state.videoId)).id;
        await save();
      }
      console.log(JSON.stringify(state));
    } else {
      if (!state || state.orgId !== orgId) throw new Error("No matching test state.");
      if (process.argv[2] === "analyze") {
        if (!state.analysisId) {
          state.analysisId = (await enqueueAnalysis(db, actor, state.matchId)).id;
          await save();
        }
      } else if (process.argv[2] === "guard") {
        const active = await db.select({ id: analysisJobs.id }).from(analysisJobs).where(inArray(analysisJobs.status, ["queued", "running"]));
        const expected = state.analysisId ?? state.prepareId;
        if (active.length !== 1 || active[0].id !== expected)
          throw new Error("The queue is not isolated to this test; do not invoke a generic worker.");
        console.log("Queue isolated to the requested three-minute test.");
        return;
      } else if (process.argv[2] === "export") {
        const [result] = await db.select().from(analysisResults).where(eq(analysisResults.jobId, state.analysisId!));
        if (!result) throw new Error("The analysis is not finished.");
        await writeFile(resolve(root, "generated-artifacts/three-minute-analysis.json"), JSON.stringify(result.summary, null, 2));
      }
      const [video] = await db.select({ status: videos.status, duration: videos.durationSeconds }).from(videos).where(eq(videos.id, state.videoId));
      const jobs = await db.select({ id: analysisJobs.id, kind: analysisJobs.kind, status: analysisJobs.status,
        stage: analysisJobs.stage, progress: analysisJobs.progress, error: analysisJobs.errorCode })
        .from(analysisJobs).where(eq(analysisJobs.videoId, state.videoId));
      console.log(JSON.stringify({ ...state, video, jobs }));
    }
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Test operation failed."); process.exitCode = 1; });
