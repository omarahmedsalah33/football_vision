import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Paths are relative to this file, rather than the repository root.
vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/jobs/worker-service", () => ({
  claimWorkerJob: vi.fn().mockResolvedValue({ job: null }), reapWorkerJobs: vi.fn(),
  workerPending: vi.fn().mockResolvedValue(false), updateWorkerJob: vi.fn(),
  WorkerConflict: class extends Error {
    constructor(message: string, public code = "worker_lease_lost", public reason = "lease") { super(message); }
  },
}));
import { POST, GET } from "@/app/api/internal/worker-jobs/route";
import { claimWorkerJob, updateWorkerJob, WorkerConflict } from "@/server/jobs/worker-service";
const token = "test-only-worker-token-0123456789abcdef";
function req(body: unknown, key = token) {
  return new Request("https://website.test/api/internal/worker-jobs", {
    method: "POST", headers: { "x-worker-storage-token": key }, body: JSON.stringify(body),
  });
}
beforeEach(() => { vi.stubEnv("WORKER_STORAGE_TOKEN", token); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
it("rejects unauthenticated queue reads/writes", async () => {
  expect((await GET(new Request("https://website.test/api/internal/worker-jobs"))).status).toBe(401);
  expect((await POST(req({ op: "claim", workerId: "test" }, "bad"))).status).toBe(401);
  expect(claimWorkerJob).not.toHaveBeenCalled();
});
it("has a fixed operation contract, not a remote SQL interface", async () => {
  for (const body of [{ op: "sql", query: "select 1" }, { op: "claim", workerId: "test", databaseUrl: "forbidden" }])
    expect((await POST(req(body))).status).toBe(422);
  expect(claimWorkerJob).not.toHaveBeenCalled();
});
it("claims through the website and never returns credentials", async () => {
  const response = await POST(req({ op: "claim", workerId: "worker.modal.internal:1234" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ job: null });
});
it("rejects incomplete completion payloads before touching jobs", async () => {
  expect((await POST(req({ op: "complete_analysis", workerId: "test",
    jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", summary: {} }))).status).toBe(422);
  expect(updateWorkerJob).not.toHaveBeenCalled();
});

it.each(["worker_result_invalid", "worker_lease_lost", "worker_cancelled"])(
  "returns the explicit conflict code %s", async code => {
    vi.mocked(updateWorkerJob).mockRejectedValueOnce(new WorkerConflict("Safe message.", code, "test"));
    const response = await POST(req({ op: "heartbeat", workerId: "test",
      jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Safe message.", code, reason: "test" });
  });
