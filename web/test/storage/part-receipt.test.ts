import { describe, expect, it, vi } from "vitest";
import { uploadPartReceipt } from "../../src/server/uploads/service";
import type { ObjectStorage } from "../../src/server/storage/s3";
import type { DbOrTx } from "../../src/server/db/client";
import type { Actor } from "../../src/server/authz/permissions";

// The permission matrix itself is unchanged; verify the service invokes it,
// then focus these isolated tests on upload ownership, state, and exact sizes.
vi.mock("../../src/server/authz/permissions", () => ({ assertCan: vi.fn() }));
import { assertCan } from "../../src/server/authz/permissions";

const actor = { userId: "owner", orgId: "org" } as Actor;
const video = {
  id: "video", createdBy: "owner", status: "uploading", multipartUploadId: "upload",
  storageKey: "source", declaredSizeBytes: 25 * 1024 * 1024,
  partSizeBytes: 16 * 1024 * 1024, partCount: 2,
};
function database(row: object | null) {
  return {
    select: () => ({ from: () => ({ where: async () => row ? [row] : [] }) }),
  } as unknown as DbOrTx;
}
function storage() {
  return { uploadPartReceipt: vi.fn().mockResolvedValue("verified-etag") } as unknown as ObjectStorage;
}

describe("authenticated part receipts", () => {
  it("checks permission and asks storage to verify the exact first-part size", async () => {
    const objectStorage = storage();
    expect(await uploadPartReceipt(database(video), objectStorage, actor, "video", 1)).toEqual({ etag: "verified-etag" });
    expect(assertCan).toHaveBeenCalledWith(actor, "video.upload");
    expect(objectStorage.uploadPartReceipt).toHaveBeenCalledWith("source", "upload", 1, 16 * 1024 * 1024);
  });
  it("verifies the shorter final part", async () => {
    const objectStorage = storage();
    await uploadPartReceipt(database(video), objectStorage, actor, "video", 2);
    expect(objectStorage.uploadPartReceipt).toHaveBeenCalledWith("source", "upload", 2, 9 * 1024 * 1024);
  });
  it("rejects another user's upload", async () => {
    const objectStorage = storage();
    await expect(uploadPartReceipt(database({ ...video, createdBy: "other" }), objectStorage, actor, "video", 1))
      .rejects.toMatchObject({ status: 404 });
    expect(objectStorage.uploadPartReceipt).not.toHaveBeenCalled();
  });
  it("rejects missing uploads and completed uploads", async () => {
    await expect(uploadPartReceipt(database(null), storage(), actor, "video", 1)).rejects.toMatchObject({ status: 404 });
    await expect(uploadPartReceipt(database({ ...video, status: "uploaded" }), storage(), actor, "video", 1))
      .rejects.toMatchObject({ status: 409 });
  });
  it("rejects invalid part numbers before accessing storage", async () => {
    const objectStorage = storage();
    for (const part of [0, -1, 3, NaN, 1.5]) {
      await expect(uploadPartReceipt(database(video), objectStorage, actor, "video", part))
        .rejects.toMatchObject({ status: 422 });
    }
    expect(objectStorage.uploadPartReceipt).not.toHaveBeenCalled();
  });
  it("does not manufacture receipts when a provider cannot supply one", async () => {
    await expect(uploadPartReceipt(database(video), {} as ObjectStorage, actor, "video", 1))
      .rejects.toMatchObject({ status: 409 });
  });
});
