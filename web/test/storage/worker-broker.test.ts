import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplitStorage, assertObjectKey } from "../../src/server/storage/replit";
import { POST } from "../../src/app/api/internal/worker-storage/route";

vi.mock("../../src/server/storage/s3", () => ({ getStorage: vi.fn() }));
import { getStorage } from "../../src/server/storage/s3";

const TOKEN = "test-only-not-a-real-secret-0123456789";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const base = `orgs/${id}/matches/${id}`;
let storage: ReplitStorage;

function request(body: object, token: string | null = TOKEN) {
  return new Request("https://example.test/api/internal/worker-storage", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-worker-storage-token": token } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("WORKER_STORAGE_TOKEN", TOKEN);
  // No real GCS requests in these tests.
  storage = Object.create(ReplitStorage.prototype) as ReplitStorage;
  storage.headObjectSize = vi.fn().mockResolvedValue(42);
  storage.presignWorkerDownload = vi.fn().mockResolvedValue("https://storage.googleapis.com/test");
  storage.presignWorkerUpload = vi.fn().mockResolvedValue("https://storage.googleapis.com/test");
  storage.deleteObject = vi.fn().mockResolvedValue(undefined);
  storage.abortMultipartUpload = vi.fn().mockResolvedValue(undefined);
  storage.cleanupStaleUploads = vi.fn().mockResolvedValue(0);
  vi.mocked(getStorage).mockReturnValue(storage);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("worker-only storage broker", () => {
  it("fails closed without a configured key", async () => {
    vi.stubEnv("WORKER_STORAGE_TOKEN", "");
    expect((await POST(request({ operation: "sweep" }))).status).toBe(503);
    expect(getStorage).not.toHaveBeenCalled();
  });
  it("rejects missing and incorrect keys", async () => {
    for (const token of [null, "wrong-key"]) {
      expect((await POST(request({ operation: "sweep" }, token))).status).toBe(401);
    }
    expect(getStorage).not.toHaveBeenCalled();
  });
  it("does not accept browser sessions as worker authorization", async () => {
    const req = request({ operation: "sweep" }, null);
    req.headers.set("cookie", "__session=not-worker-access");
    expect((await POST(req)).status).toBe(401);
  });
  it("downloads only source footage", async () => {
    const key = `${base}/videos/${id}/source`;
    expect((await POST(request({ operation: "download", key }))).status).toBe(200);
    expect(storage.presignWorkerDownload).toHaveBeenCalledWith(key);
    expect((await POST(request({ operation: "download", key: `${base}/analysis/${id}/tracks.jsonl.gz` }))).status).toBe(403);
  });
  it("reports missing footage", async () => {
    vi.mocked(storage.headObjectSize).mockResolvedValue(null);
    expect((await POST(request({ operation: "download", key: `${base}/videos/${id}/source` }))).status).toBe(404);
  });
  it("accepts the exact frame, tracks and player paths produced by the existing pipeline", async () => {
    for (const [suffix, contentType] of [
      [`videos/${id}/frames/frame-001.jpg`, "image/jpeg"],
      [`analysis/${id}/tracks.jsonl.gz`, "application/gzip"],
      [`analysis/${id}/players/track-001.jpg`, "image/jpeg"],
    ]) {
      expect((await POST(request({ operation: "upload", key: `${base}/${suffix}`, contentType }))).status).toBe(200);
    }
  });
  it("cannot overwrite original footage or upload a mismatched artifact type", async () => {
    expect((await POST(request({ operation: "upload", key: `${base}/videos/${id}/source`, contentType: "image/jpeg" }))).status).toBe(403);
    expect((await POST(request({ operation: "upload", key: `${base}/analysis/${id}/tracks.jsonl.gz`, contentType: "image/jpeg" }))).status).toBe(403);
    expect(storage.presignWorkerUpload).not.toHaveBeenCalled();
  });
  it("allows private checkpoint upload, restore and deletion only with exact paths and MIME", async () => {
    for (const name of [`detections-${"b".repeat(64)}.json.gz`, `llm-${"b".repeat(64)}.json.gz`, `result-${"b".repeat(64)}.tar.gz`]) {
      const key = `${base}/analysis/${id}/checkpoints/${"a".repeat(64)}/${name}`;
      expect((await POST(request({ operation: "upload", key, contentType: "application/gzip" }))).status).toBe(200);
      expect((await POST(request({ operation: "download", key }))).status).toBe(200);
      expect((await POST(request({ operation: "delete", key }))).status).toBe(200);
      expect((await POST(request({ operation: "download", key }, null))).status).toBe(401);
      expect((await POST(request({ operation: "upload", key, contentType: "image/jpeg" }))).status).toBe(403);
      expect((await POST(request({ operation: "abort", key, uploadId: "invalid" }))).status).toBe(403);
    }
  });
  it("rejects arbitrary checkpoint files, paths, and missing objects", async () => {
    const prefix = `${base}/analysis/${id}/checkpoints/${"a".repeat(64)}`;
    for (const name of ["config.json", "result.tar.gz", `../result-${"b".repeat(64)}.tar.gz`]) {
      expect([403, 422]).toContain((await POST(request({ operation: "download", key: `${prefix}/${name}` }))).status);
    }
    vi.mocked(storage.headObjectSize).mockResolvedValue(null);
    expect((await POST(request({ operation: "download", key: `${prefix}/result-${"b".repeat(64)}.tar.gz` }))).status).toBe(404);
  });
  it("rejects traversal and objects outside the private worker namespace", async () => {
    for (const key of ["../source", "_multipart/random/manifest.json", "/absolute/source", `${base}/videos/${id}/../../source`]) {
      const result = await POST(request({ operation: "delete", key }));
      expect([403, 422]).toContain(result.status);
    }
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
  it("does not expose upstream errors, signed URLs, or keys", async () => {
    vi.mocked(storage.presignWorkerDownload).mockRejectedValue(new Error(`https://example.test/?secret=${TOKEN}`));
    const result = await POST(request({ operation: "download", key: `${base}/videos/${id}/source` }));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain(TOKEN);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
});

describe("private object keys", () => {
  it("rejects path escapes and ambiguous keys", () => {
    for (const key of ["", "/foo", "a//b", "a/./b", "a/../b", "a\\b", "a/\x00b"]) {
      expect(() => assertObjectKey(key)).toThrow();
    }
    expect(() => assertObjectKey(`${base}/videos/${id}/source`)).not.toThrow();
  });
});
