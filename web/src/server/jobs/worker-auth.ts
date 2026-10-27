import { createHash, timingSafeEqual } from "node:crypto";

export function workerReply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function authorizeWorker(req: Request) {
  const token = process.env.WORKER_STORAGE_TOKEN;
  const supplied = req.headers.get("x-worker-storage-token") ?? "";
  if (!token || token.length < 32) return workerReply({ error: "Worker access is not configured." }, 503);
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (supplied.length > 512 || !timingSafeEqual(digest(supplied), digest(token)))
    return workerReply({ error: "Unauthorized." }, 401);
  return null;
}
