import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ReplitStorage, assertObjectKey } from "@/server/storage/replit";
import { getStorage } from "@/server/storage/s3";

export const runtime = "nodejs";

const input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("download"), key: z.string().max(1024) }),
  z.object({ operation: z.literal("upload"), key: z.string().max(1024), contentType: z.enum(["image/jpeg", "application/gzip"]) }),
  z.object({ operation: z.literal("delete"), key: z.string().max(1024) }),
  z.object({ operation: z.literal("abort"), key: z.string().max(1024), uploadId: z.string().max(100) }),
  z.object({ operation: z.literal("sweep") }),
]);
const UUID = "[0-9a-fA-F-]{36}";
const MATCH_KEY = new RegExp(`^orgs/${UUID}/matches/${UUID}/`);
const reply = (body: object, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Service-to-service only. Clerk sessions never authorize this endpoint. */
export async function POST(req: Request) {
  const expected = process.env.WORKER_STORAGE_TOKEN;
  if (!expected || expected.length < 32) return reply({ error: "Worker storage access is not configured." }, 503);
  const authorization = req.headers.get("x-worker-storage-token") ?? "";
  if (!authorization || authorization.length > 512 ||
      !timingSafeEqual(digest(authorization), digest(expected))) {
    return reply({ error: "Unauthorized." }, 401);
  }
  if (Number(req.headers.get("content-length") ?? 0) > 4096) return reply({ error: "Request too large." }, 413);
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 4096) return reply({ error: "Request too large." }, 413);
    const parsed = input.safeParse(JSON.parse(text));
    if (!parsed.success) return reply({ error: "Invalid worker storage request." }, 422);
    const body = parsed.data;
    const storage = getStorage();
    if (!(storage instanceof ReplitStorage)) return reply({ error: "Replit storage is not selected." }, 503);
    if (body.operation === "sweep") return reply({ deleted: await storage.cleanupStaleUploads() });
    assertObjectKey(body.key);
    if (!MATCH_KEY.test(body.key)) return reply({ error: "Object is outside the worker namespace." }, 403);
    const relative = body.key.replace(MATCH_KEY, "");
    const isSource = new RegExp(`^videos/${UUID}/source$`).test(relative);
    const isFrame = new RegExp(`^videos/${UUID}/frames/[^/]+\\.jpg$`).test(relative);
    const isCrop = new RegExp(`^analysis/${UUID}/players/[^/]+\\.jpg$`).test(relative);
    const isTracks = new RegExp(`^analysis/${UUID}/tracks\\.jsonl\\.gz$`).test(relative);
    const isCheckpoint = new RegExp(`^analysis/${UUID}/checkpoints/[0-9a-f]{64}/(?:(?:detections|llm)-[0-9a-f]{64}\\.json\\.gz|result-[0-9a-f]{64}\\.tar\\.gz)$`).test(relative);
    if (!isSource && !isFrame && !isCrop && !isTracks && !isCheckpoint) return reply({ error: "Object key is not allowed." }, 403);
    if (body.operation === "download") {
      if (!isSource && !isCheckpoint) return reply({ error: "Only source videos and checkpoints may be downloaded." }, 403);
      if (await storage.headObjectSize(body.key) === null) return reply({ error: "Video not found." }, 404);
      return reply({ url: await storage.presignWorkerDownload(body.key) });
    }
    if (body.operation === "upload") {
      if ((!isFrame && !isCrop && !isTracks && !isCheckpoint) ||
          body.contentType !== (isTracks || isCheckpoint ? "application/gzip" : "image/jpeg")) {
        return reply({ error: "Worker output key or type is not allowed." }, 403);
      }
      return reply({ url: await storage.presignWorkerUpload(body.key) });
    }
    if (body.operation === "abort") {
      if (!isSource) return reply({ error: "Invalid upload key." }, 403);
      await storage.abortMultipartUpload(body.key, body.uploadId);
    } else {
      await storage.deleteObject(body.key);
    }
    return reply({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Invalid"))) {
      return reply({ error: "Invalid worker storage request." }, 422);
    }
    // Never serialize upstream errors: they may carry signed URLs or authorization details.
    return reply({ error: "Private storage is temporarily unavailable." }, 503);
  }
}
