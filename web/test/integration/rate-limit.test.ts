import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { enforceRateLimit } from "../../src/server/http/rate-limit";
import { testDb } from "../helpers";

const db = testDb();

describe("database-backed rate limiting", () => {
  it("allows the budget, then answers 429, counting concurrent requests correctly", async () => {
    const limit = { name: `test.${randomUUID()}`, perMinute: 5 };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => enforceRateLimit(db, limit, "user-a")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    for (const r of results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]) {
      expect(r.reason).toMatchObject({ status: 429, code: "rate_limited" });
    }
  });

  it("keeps separate budgets per subject", async () => {
    const limit = { name: `test.${randomUUID()}`, perMinute: 1 };
    await enforceRateLimit(db, limit, "user-a");
    await expect(enforceRateLimit(db, limit, "user-b")).resolves.toBeUndefined();
    await expect(enforceRateLimit(db, limit, "user-a")).rejects.toMatchObject({ status: 429 });
  });
});
