import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/server/db/client", () => ({ getDb: vi.fn() }));
import { getDb } from "../../src/server/db/client";
import { POST } from "../../src/app/api/internal/worker-analysis/route";

const TOKEN = "test-only-worker-token-0123456789abcdef";
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const fetcher = vi.fn();
const where = vi.fn();
const body = { jobId: id, workerId: "worker-1", provider: "gemini", prompt: "Inspect footage", images: [], video: "dmlkZW8=" };
function request(value = body, token = TOKEN) {
  return new Request("https://website.test/api/internal/worker-analysis", {
    method: "POST", headers: { "content-type": "application/json", "x-worker-storage-token": token },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.stubEnv("WORKER_STORAGE_TOKEN", TOKEN);
  vi.stubEnv("AI_INTEGRATIONS_GEMINI_API_KEY", "test-only-provider-key");
  vi.stubEnv("AI_INTEGRATIONS_GEMINI_BASE_URL", "https://provider.test");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async () => Response.json({ candidates: [], modelVersion: "gemini-3.8-flash" }));
  where.mockReset().mockResolvedValue([{ config: { engine: "llm" } }]);
  vi.mocked(getDb).mockReturnValue({ select: () => ({ from: () => ({ where }) }) } as unknown as ReturnType<typeof getDb>);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("private AI provider broker", () => {
  it("rejects unauthenticated callers before touching the database or provider", async () => {
    expect((await POST(request(body, "wrong"))).status).toBe(401);
    expect(where).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires a running AI job's matching worker lease", async () => {
    where.mockResolvedValueOnce([]);
    expect((await POST(request())).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects legacy non-AI job leases", async () => {
    where.mockResolvedValueOnce([{ config: {} }]);
    expect((await POST(request())).status).toBe(409);
  });
  it("pins the native-video model and ten-fps sampling; shares identical retries", async () => {
    const value = { ...body, prompt: "native-video-contract" };
    const replies = await Promise.all([POST(request(value)), POST(request(value))]);
    expect(replies.map(r => r.status)).toEqual([200, 200]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://provider.test/models/gemini-3.8-flash:generateContent");
    const payload = JSON.parse(String(init.body));
    expect(payload.contents[0].parts.at(-1).videoMetadata.fps).toBe(10);
    expect(payload.generationConfig.maxOutputTokens).toBe(24576);
  });
  it("does not serialize upstream credentials or errors", async () => {
    fetcher.mockRejectedValueOnce(new Error("DO_NOT_LEAK_PROVIDER_CREDENTIAL"));
    const result = await POST(request({ ...body, prompt: "redaction-contract" }));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("DO_NOT_LEAK");
  });
  it("rejects arbitrary providers and caller-supplied model routing", async () => {
    const r = new Request("https://website.test/api/internal/worker-analysis", {
      method: "POST", headers: { "x-worker-storage-token": TOKEN },
      body: JSON.stringify({ ...body, provider: "other", model: "unapproved" }),
    });
    expect((await POST(r)).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [429, 429, "ai_rate_limited", true],
    [504, 504, "ai_provider_timeout", true],
    [503, 503, "ai_provider_unavailable", true],
    [413, 413, "ai_input_limit", false],
    [401, 502, "ai_provider_credentials", false],
    [403, 502, "ai_provider_credentials", false],
    [404, 502, "ai_provider_model", false],
    [400, 422, "ai_request_invalid", false],
  ])("classifies upstream HTTP %s safely", async (upstream, expected, code, retryable) => {
    fetcher.mockResolvedValueOnce(new Response("DO_NOT_LEAK_PROVIDER_CREDENTIAL", { status: upstream }));
    const result = await POST(request({ ...body, prompt: `classification-${upstream}` }));
    expect(result.status).toBe(expected);
    expect(await result.json()).toMatchObject({ code, retryable });
  });
  it("does not retain a failed upstream call in the deduplication cache", async () => {
    fetcher.mockResolvedValueOnce(new Response("", { status: 503 }));
    const value = { ...body, prompt: "transient-cache-recovery" };
    expect((await POST(request(value))).status).toBe(503);
    expect((await POST(request(value))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a full completed-response cache for active request saturation", async () => {
    for (let i = 0; i < 40; i++)
      expect((await POST(request({ ...body, prompt: `sequential-cache-${i}` }))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(40);
  });
  it("distinguishes a fetch timeout without exposing its message", async () => {
    fetcher.mockRejectedValueOnce(new DOMException("DO_NOT_LEAK_PROVIDER_CREDENTIAL", "TimeoutError"));
    const result = await POST(request({ ...body, prompt: "timeout-classification" }));
    expect(result.status).toBe(504);
    expect(await result.json()).toMatchObject({ code: "ai_provider_timeout", retryable: true });
  });
});
