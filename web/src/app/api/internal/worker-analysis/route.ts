import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { analysisJobs } from "@/server/db/schema";
import { ProviderFailure, responseFailure, networkFailure } from "@/server/analysis/provider-errors";

export const runtime = "nodejs";
export const maxDuration = 300;
const input = z.object({
  jobId: z.uuid(), workerId: z.string().min(1).max(200),
  provider: z.enum(["gemini", "astra"]), prompt: z.string().min(1).max(60000),
  images: z.array(z.string().max(3000000).regex(/^[A-Za-z0-9+/=\r\n]+$/)).max(36),
  video: z.string().max(7500000).regex(/^[A-Za-z0-9+/=\r\n]+$/).optional(),
}).strict();
// Same-input retries share in-flight requests, rather than multiplying paid provider calls.
const calls = new Map<string, { promise: Promise<unknown>; expires: number; pending: boolean }>();
const digest = (s: string) => createHash("sha256").update(s).digest();
const reply = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

function authorize(req: Request) {
  const token = process.env.WORKER_STORAGE_TOKEN;
  const supplied = req.headers.get("x-worker-storage-token") ?? "";
  if (!token || token.length < 32) return reply({ error: "Worker access is not configured." }, 503);
  if (supplied.length > 512 || !timingSafeEqual(digest(supplied), digest(token)))
    return reply({ error: "Unauthorized." }, 401);
  return null;
}

export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const ready = ["AI_INTEGRATIONS_GEMINI_API_KEY", "AI_INTEGRATIONS_GEMINI_BASE_URL",
    "AI_INTEGRATIONS_OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_BASE_URL"].every(k => !!process.env[k]);
  return reply({ ready, engine: "llm-video-v1" }, ready ? 200 : 503);
}

export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  if (Number(req.headers.get("content-length") ?? 0) > 10000000)
    return reply({ error: "Request too large.", code: "ai_input_limit" }, 413);
  let context: { jobId?: string; provider?: string } = {};
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 10000000) return reply({ error: "Request too large.", code: "ai_input_limit" }, 413);
    const parsed = input.safeParse(JSON.parse(text));
    if (!parsed.success) return reply({ error: "Invalid analysis request." }, 422);
    const body = parsed.data;
    context = { jobId: body.jobId, provider: body.provider };
    if (body.provider === "astra" && body.video) return reply({ error: "Astra accepts images here." }, 422);
    const db = getDb();
    const [job] = await db.select({ config: analysisJobs.config }).from(analysisJobs).where(and(
      eq(analysisJobs.id, body.jobId), eq(analysisJobs.leaseOwner, body.workerId),
      eq(analysisJobs.status, "running"), eq(analysisJobs.cancelRequested, false),
      gt(analysisJobs.leaseExpiresAt, new Date()),
    ));
    if (!job || (job.config as { engine?: string }).engine !== "llm")
      return reply({ error: "No active AI-analysis lease." }, 409);
    const keyName = body.provider === "gemini" ? "AI_INTEGRATIONS_GEMINI_API_KEY" : "AI_INTEGRATIONS_OPENAI_API_KEY";
    const baseName = body.provider === "gemini" ? "AI_INTEGRATIONS_GEMINI_BASE_URL" : "AI_INTEGRATIONS_OPENAI_BASE_URL";
    const key = process.env[keyName], base = process.env[baseName]?.replace(/\/$/, "");
    if (!key || !base) return reply({ error: "AI provider is not configured on the website.", code: "ai_not_configured" }, 503);
    for (const [id, call] of calls) if (!call.pending && call.expires < Date.now()) calls.delete(id);
    const fingerprint = createHash("sha256").update(text).digest("hex");
    let call = calls.get(fingerprint);
    if (!call) {
      // Completed response caching must not exhaust the in-flight concurrency allowance.
      if (calls.size >= 32) {
        const completed = [...calls].find(([, entry]) => !entry.pending);
        if (completed) calls.delete(completed[0]);
        else return reply({ error: "Analysis broker is busy.", code: "ai_broker_busy", retryable: true }, 429);
      }
      const url = body.provider === "gemini"
        ? `${base}/models/gemini-3.8-flash:generateContent` : `${base}/chat/completions`;
      const payload = body.provider === "gemini" ? {
        contents: [{ role: "user", parts: [{ text: body.prompt },
          ...body.images.map(data => ({ inlineData: { mimeType: "image/jpeg", data } })),
          ...(body.video ? [{ inlineData: { mimeType: "video/mp4", data: body.video }, videoMetadata: { fps: 10 } }] : []),
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 24576, responseMimeType: "application/json" },
      } : {
        model: "gpt-6-astra", max_completion_tokens: 10000, response_format: { type: "json_object" },
        messages: [{ role: "user", content: [{ type: "text", text: body.prompt },
          ...body.images.map(data => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}`, detail: "high" } })),
        ] }],
      };
      const promise = (async () => {
        let response: Response;
        try { response = await fetch(url, {
          method: "POST", signal: AbortSignal.timeout(250000),
          headers: { "Content-Type": "application/json",
            ...(body.provider === "gemini" ? { "x-goog-api-key": key } : { Authorization: `Bearer ${key}` }) },
          body: JSON.stringify(payload),
        }); } catch (error) { throw networkFailure(error); }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw responseFailure(response);
        }
        try { return await response.json() as unknown; }
        catch { throw new ProviderFailure("ai_invalid_response", 502, true); }
      })();
      call = { promise, expires: Date.now() + 10 * 60000, pending: true };
      calls.set(fingerprint, call);
      const entry = call;
      void promise.then(() => { entry.pending = false; }, () => { calls.delete(fingerprint); });
    }
    return reply(await call.promise);
  } catch (error) {
    // Never return upstream errors, request headers or credentials.
    const failure = error instanceof ProviderFailure ? error : new ProviderFailure("ai_broker_unavailable", 503, true);
    console.warn("AI broker failure", { ...context, code: failure.code, upstreamStatus: failure.upstreamStatus });
    return Response.json({ error: "AI request did not complete.", code: failure.code, retryable: failure.retryable }, {
      status: failure.status, headers: { "Cache-Control": "no-store",
        ...(failure.retryAfter ? { "Retry-After": String(failure.retryAfter) } : {}) },
    });
  }
}
