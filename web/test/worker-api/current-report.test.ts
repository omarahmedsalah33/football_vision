import { describe, expect, it, vi } from "vitest";
import { getAnalysisResults, optionalMediaUrl } from "@/server/analysis/results";
import type { DbOrTx } from "@/server/db/client";
import type { Actor } from "@/server/authz/permissions";
const sign = vi.hoisted(() => vi.fn());
vi.mock("@/server/storage/s3", () => ({ getStorage: () => ({ presignGet:sign }) }));

describe("one current report per match", () => {
  it("keeps the report controls usable when optional media is missing or concurrently updated", async () => {
    for (const code of [404,409,410]) {
      sign.mockRejectedValueOnce({code});
      expect(await optionalMediaUrl("private/key","video/mp4")).toBeNull();
    }
    const outage=new Error("Storage outage");
    sign.mockRejectedValueOnce(outage);
    await expect(optionalMediaUrl("private/key","video/mp4")).rejects.toBe(outage);
  });
  it("refuses a superseded report before fetching its summary", async () => {
    const chain = { from:vi.fn(),where:vi.fn(),orderBy:vi.fn(),limit:vi.fn().mockResolvedValue([{id:"new-job"}]) };
    chain.from.mockReturnValue(chain);chain.where.mockReturnValue(chain);chain.orderBy.mockReturnValue(chain);
    const db={select:vi.fn().mockReturnValue(chain)};
    const actor={orgId:"test-org",userId:"owner",role:"owner"} as Actor;
    await expect(getAnalysisResults(db as unknown as DbOrTx,actor,"match","old-job")).rejects.toMatchObject({status:404});
    expect(db.select).toHaveBeenCalledOnce();
  });
});
