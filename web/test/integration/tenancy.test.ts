import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { memberships, organizations, teams, videos } from "../../src/server/db/schema";
import { cancelAnalysis, enqueueAnalysis } from "../../src/server/jobs/service";
import { createMatch, deleteMatch, getMatch, listMatches } from "../../src/server/matches/service";
import { ensureUser, listMyOrgs, resolveActor } from "../../src/server/orgs/service";
import type { ObjectStorage } from "../../src/server/storage/s3";
import { abortUpload, completeUpload, presignParts, startUpload } from "../../src/server/uploads/service";
import { makeActor, makeUser, testDb } from "../helpers";

const db = testDb();

// Storage double: tenancy tests are about the database boundary, not S3.
const storage: ObjectStorage = {
  createMultipartUpload: async () => `upload-${randomUUID()}`,
  presignUploadPart: async (key, _id, n) => `https://storage.test/${key}?part=${n}`,
  completeMultipartUpload: async () => {},
  abortMultipartUpload: async () => {},
  headObjectSize: async () => null,
  readRange: async () => new Uint8Array(),
  deleteObject: async () => {},
};

const NOT_FOUND = expect.objectContaining({ status: 404 });
const FORBIDDEN = expect.objectContaining({ status: 403 });

async function matchWithUploadedVideo(actor: Awaited<ReturnType<typeof makeActor>>) {
  const match = await createMatch(db, actor, { title: "Home vs Away" });
  const up = await startUpload(db, storage, actor, match.id, {
    filename: "m.mp4",
    sizeBytes: 1000,
    contentType: "video/mp4",
  });
  await db.update(videos).set({ status: "uploaded", sizeBytes: 1000 }).where(eq(videos.id, up.videoId));
  return { match, videoId: up.videoId };
}

describe("cross-tenant isolation", () => {
  it("a member of club B cannot see or touch club A's matches, uploads or jobs", async () => {
    const a = await makeActor(db, "owner");
    const b = await makeActor(db, "owner");
    const { match, videoId } = await matchWithUploadedVideo(a);
    const job = await enqueueAnalysis(db, a, match.id);

    expect((await listMatches(db, b)).map((m) => m.id)).not.toContain(match.id);
    await expect(getMatch(db, b, match.id)).rejects.toThrowError(NOT_FOUND);
    await expect(deleteMatch(db, b, match.id)).rejects.toThrowError(NOT_FOUND);
    await expect(
      startUpload(db, storage, b, match.id, { filename: "x.mp4", sizeBytes: 10, contentType: "video/mp4" }),
    ).rejects.toThrowError(NOT_FOUND);
    await expect(presignParts(db, storage, b, videoId, { partNumbers: [1] })).rejects.toThrowError(NOT_FOUND);
    await expect(
      completeUpload(db, storage, b, videoId, { parts: [{ partNumber: 1, etag: "x" }] }),
    ).rejects.toThrowError(NOT_FOUND);
    await expect(abortUpload(db, storage, b, videoId)).rejects.toThrowError(NOT_FOUND);
    await expect(enqueueAnalysis(db, b, match.id)).rejects.toThrowError(NOT_FOUND);
    await expect(cancelAnalysis(db, b, job.id)).rejects.toThrowError(NOT_FOUND);

    // A still sees everything intact.
    expect((await getMatch(db, a, match.id)).job?.status).toBe("queued");
  });

  it("forging the orgId in an Actor does not help without a membership", async () => {
    const a = await makeActor(db, "owner");
    const outsider = await makeUser(db);
    await expect(resolveActor(db, outsider.id, a.orgId)).rejects.toThrowError(NOT_FOUND);
  });

  it("suspended members and deleted organizations resolve to not found", async () => {
    const a = await makeActor(db, "coach");
    await db
      .update(memberships)
      .set({ status: "suspended" })
      .where(and(eq(memberships.orgId, a.orgId), eq(memberships.userId, a.userId)));
    await expect(resolveActor(db, a.userId, a.orgId)).rejects.toThrowError(NOT_FOUND);

    const b = await makeActor(db, "owner");
    await db.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, b.orgId));
    await expect(resolveActor(db, b.userId, b.orgId)).rejects.toThrowError(NOT_FOUND);
  });

  it("cannot attach another organization's team to a match", async () => {
    const a = await makeActor(db, "owner");
    const b = await makeActor(db, "owner");
    const [teamB] = await db.insert(teams).values({ orgId: b.orgId, name: "U17" }).returning();
    await expect(createMatch(db, a, { title: "Friendly", teamId: teamB.id })).rejects.toThrowError(
      expect.objectContaining({ status: 422 }),
    );
  });

  it("a colleague in the same org cannot hijack someone else's in-progress upload", async () => {
    const a = await makeActor(db, "analyst");
    const colleague = await makeActor(db, "coach", a.orgId);
    const match = await createMatch(db, a, { title: "Derby" });
    const up = await startUpload(db, storage, a, match.id, { filename: "d.mp4", sizeBytes: 50, contentType: "video/mp4" });
    await expect(presignParts(db, storage, colleague, up.videoId, { partNumbers: [1] })).rejects.toThrowError(NOT_FOUND);
  });

  it("match detail never exposes storage keys or upload ids", async () => {
    const a = await makeActor(db, "owner");
    const { match } = await matchWithUploadedVideo(a);
    const json = JSON.stringify(await getMatch(db, a, match.id));
    expect(json).not.toMatch(/orgs\/|storageKey|multipartUploadId|upload-/);
  });
});

describe("role enforcement on the server", () => {
  it("scouts and players can read but not create, upload, run or delete", async () => {
    const owner = await makeActor(db, "owner");
    const { match } = await matchWithUploadedVideo(owner);
    for (const role of ["scout", "player"] as const) {
      const actor = await makeActor(db, role, owner.orgId);
      expect((await getMatch(db, actor, match.id)).id).toBe(match.id);
      await expect(createMatch(db, actor, { title: "Nope" })).rejects.toThrowError(FORBIDDEN);
      await expect(
        startUpload(db, storage, actor, match.id, { filename: "x.mp4", sizeBytes: 10, contentType: "video/mp4" }),
      ).rejects.toThrowError(FORBIDDEN);
      await expect(enqueueAnalysis(db, actor, match.id)).rejects.toThrowError(FORBIDDEN);
      await expect(deleteMatch(db, actor, match.id)).rejects.toThrowError(FORBIDDEN);
    }
  });

  it("analysts cannot delete matches; coaches can", async () => {
    const owner = await makeActor(db, "owner");
    const analyst = await makeActor(db, "analyst", owner.orgId);
    const coach = await makeActor(db, "coach", owner.orgId);
    const match = await createMatch(db, analyst, { title: "League" });
    await expect(deleteMatch(db, analyst, match.id)).rejects.toThrowError(FORBIDDEN);
    await deleteMatch(db, coach, match.id);
    await expect(getMatch(db, owner, match.id)).rejects.toThrowError(NOT_FOUND);
  });
});

describe("first sign-in", () => {
  it("creates exactly one user and one personal workspace under concurrent requests", async () => {
    const subject = `clerk_${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureUser(db, { subject, email: "p@example.com", displayName: "Pat" })),
    );
    expect(new Set(results.map((u) => u.id)).size).toBe(1);
    const orgs = await listMyOrgs(db, results[0].id);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ kind: "personal", role: "owner" });
  });
});
