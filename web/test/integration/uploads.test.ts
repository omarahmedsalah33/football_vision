import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/server/authz/permissions";
import { videos } from "../../src/server/db/schema";
import { createMatch } from "../../src/server/matches/service";
import { getStorage } from "../../src/server/storage/s3";
import { completeUpload, presignParts, startUpload } from "../../src/server/uploads/service";
import { makeActor, testDb } from "../helpers";

// Runs against the real S3-compatible store from docker-compose (test bucket).
const db = testDb();
const storage = getStorage();
const MiB = 1024 * 1024;

/** A buffer that starts like an MP4 file ("ftyp" box) — enough for the server-side sniff. */
function fakeMp4(size: number) {
  const buf = new Uint8Array(size);
  buf.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return buf;
}

async function begin(actor: Actor, size: number, filename = "match.mp4") {
  const match = await createMatch(db, actor, { title: "Upload test" });
  const up = await startUpload(db, storage, actor, match.id, { filename, sizeBytes: size, contentType: "video/mp4" });
  return { match, ...up };
}

async function uploadParts(actor: Actor, videoId: string, file: Uint8Array, partSize: number, partNumbers: number[]) {
  const urls = await presignParts(db, storage, actor, videoId, { partNumbers });
  return Promise.all(
    urls.map(async ({ partNumber, url }) => {
      const body = file.slice((partNumber - 1) * partSize, partNumber * partSize);
      const res = await fetch(url, { method: "PUT", body });
      expect(res.status, `part ${partNumber}`).toBe(200);
      return { partNumber, etag: res.headers.get("etag")! };
    }),
  );
}

async function videoRow(id: string) {
  const [v] = await db.select().from(videos).where(eq(videos.id, id));
  return v;
}

describe("multipart upload against real object storage", () => {
  it("uploads, verifies size and container, and tolerates a retried completion", async () => {
    const actor = await makeActor(db, "analyst");
    const size = 20 * MiB;
    const file = fakeMp4(size);
    const { videoId, partSize, partCount } = await begin(actor, size);
    expect(partCount).toBe(2);

    const parts = await uploadParts(actor, videoId, file, partSize, [1, 2]);
    const done = await completeUpload(db, storage, actor, videoId, { parts });
    expect(done).toMatchObject({ status: "uploaded", sizeBytes: size });

    // Browser lost the response and retries: same result, no error.
    const again = await completeUpload(db, storage, actor, videoId, { parts });
    expect(again).toMatchObject({ id: videoId, status: "uploaded" });
    await storage.deleteObject(done.storageKey);
  });

  it("storage rejects a part larger than the size the server signed", async () => {
    const actor = await makeActor(db, "analyst");
    const { videoId } = await begin(actor, 20 * MiB);
    const [{ url }] = await presignParts(db, storage, actor, videoId, { partNumbers: [2] });
    const res = await fetch(url, { method: "PUT", body: new Uint8Array(64 * MiB) });
    expect(res.status).toBe(403);
  });

  it("rejects and deletes a file that is not a video, even with a .mp4 name", async () => {
    const actor = await makeActor(db, "analyst");
    const html = new TextEncoder().encode("<html><script>alert(document.cookie)</script></html>");
    const { videoId, partSize } = await begin(actor, html.length);
    const parts = await uploadParts(actor, videoId, html, partSize, [1]);

    await expect(completeUpload(db, storage, actor, videoId, { parts })).rejects.toMatchObject({ status: 422 });
    const row = await videoRow(videoId);
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "unrecognized_container" });
    expect(await storage.headObjectSize(row.storageKey)).toBeNull();
  });

  it("refuses to complete while parts are missing, and keeps the upload resumable", async () => {
    const actor = await makeActor(db, "analyst");
    const size = 20 * MiB;
    const { videoId, partSize } = await begin(actor, size);
    const [first] = await uploadParts(actor, videoId, fakeMp4(size), partSize, [1]);

    await expect(
      completeUpload(db, storage, actor, videoId, { parts: [first, { partNumber: 2, etag: '"bogus"' }] }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await videoRow(videoId)).status).toBe("uploading");
  });

  it("validates part lists and ranges", async () => {
    const actor = await makeActor(db, "analyst");
    const { videoId } = await begin(actor, 20 * MiB);
    await expect(presignParts(db, storage, actor, videoId, { partNumbers: [3] })).rejects.toMatchObject({ status: 422 });
    await expect(
      completeUpload(db, storage, actor, videoId, {
        parts: [
          { partNumber: 1, etag: "a" },
          { partNumber: 1, etag: "b" },
        ],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("enforces plan size limits and file types before any storage is allocated", async () => {
    const actor = await makeActor(db, "analyst");
    const match = await createMatch(db, actor, { title: "Limits" });
    await expect(
      startUpload(db, storage, actor, match.id, { filename: "big.mp4", sizeBytes: 50 * 1024 ** 3, contentType: "video/mp4" }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      startUpload(db, storage, actor, match.id, { filename: "x.exe", sizeBytes: 10, contentType: "video/mp4" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(videos).where(eq(videos.matchId, match.id))).toHaveLength(0);
  });
});
