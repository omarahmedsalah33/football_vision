import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { assertCan, type Actor } from "../authz/permissions";
import { getEntitlements, getUsage, usagePeriodStart } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { matches, videos } from "../db/schema";
import { conflict, invalidInput, notFound, payloadTooLarge, quotaExceeded } from "../http/errors";
import { log } from "../log";
import type { ObjectStorage } from "../storage/s3";
import {
  checkDeclaredFile,
  type completeUploadInput,
  partLength,
  planParts,
  type presignPartsInput,
  sanitizeFilename,
  sniffContainer,
  type startUploadInput,
} from "./validation";

export type VideoRow = typeof videos.$inferSelect;

function storageKey(orgId: string, matchId: string, videoId: string) {
  // Server-generated, tenant-prefixed, contains no user input.
  return `orgs/${orgId}/matches/${matchId}/videos/${videoId}/source`;
}

export async function startUpload(
  db: DbOrTx,
  storage: ObjectStorage,
  actor: Actor,
  matchId: string,
  input: z.infer<typeof startUploadInput>,
) {
  assertCan(actor, "video.upload");

  const [match] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.id, matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)));
  if (!match) throw notFound("Match");

  const fileProblem = checkDeclaredFile(input.filename, input.contentType);
  if (fileProblem) throw invalidInput(fileProblem);

  const ent = await getEntitlements(db, actor.orgId);
  if (input.sizeBytes > ent.limits.maxUploadBytes) {
    const gb = (ent.limits.maxUploadBytes / 1024 ** 3).toFixed(1);
    throw payloadTooLarge(`Your plan allows videos up to ${gb} GB.`);
  }
  // Early, non-authoritative check so users are not asked to upload gigabytes they cannot analyse.
  // The authoritative check is the atomic reservation when the analysis is queued.
  const usage = await getUsage(db, actor.orgId, usagePeriodStart());
  if (usage.used + usage.reserved >= ent.limits.monthlyAnalyses) {
    throw quotaExceeded("Your plan's monthly analysis allowance is used up.");
  }

  const { partSize, partCount } = planParts(input.sizeBytes);
  const videoId = crypto.randomUUID();
  const key = storageKey(actor.orgId, matchId, videoId);
  const uploadId = await storage.createMultipartUpload(key);

  const [video] = await db
    .insert(videos)
    .values({
      id: videoId,
      orgId: actor.orgId,
      matchId,
      storageKey: key,
      multipartUploadId: uploadId,
      originalFilename: sanitizeFilename(input.filename),
      declaredSizeBytes: input.sizeBytes,
      partSizeBytes: partSize,
      partCount,
      createdBy: actor.userId,
    })
    .returning();

  return { videoId: video.id, partSize, partCount };
}

/** Loads a video the actor is allowed to keep uploading: same org, and they started it. */
async function loadOwnUpload(db: DbOrTx, actor: Actor, videoId: string): Promise<VideoRow> {
  assertCan(actor, "video.upload");
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.orgId, actor.orgId)));
  if (!video || video.createdBy !== actor.userId) throw notFound("Upload");
  return video;
}

export async function presignParts(
  db: DbOrTx,
  storage: ObjectStorage,
  actor: Actor,
  videoId: string,
  input: z.infer<typeof presignPartsInput>,
) {
  const video = await loadOwnUpload(db, actor, videoId);
  if (video.status !== "uploading" || !video.multipartUploadId) throw conflict("This upload is no longer active.");

  const unique = [...new Set(input.partNumbers)];
  if (unique.some((n) => n > video.partCount)) throw invalidInput("Part number out of range.");

  const uploadId = video.multipartUploadId;
  return Promise.all(
    unique.map(async (partNumber) => ({
      partNumber,
      url: await storage.presignUploadPart(
        video.storageKey,
        uploadId,
        partNumber,
        partLength(video.declaredSizeBytes, video.partSizeBytes, video.partCount, partNumber),
      ),
    })),
  );
}

async function reject(db: DbOrTx, storage: ObjectStorage, video: VideoRow, reason: string) {
  await storage.deleteObject(video.storageKey).catch((err) => log.warn({ err, videoId: video.id }, "delete failed"));
  await db
    .update(videos)
    .set({ status: "rejected", rejectionReason: reason, multipartUploadId: null })
    .where(eq(videos.id, video.id));
}

/**
 * Finalizes a multipart upload. Safe to retry: if a previous attempt already completed the object
 * (e.g. the browser lost the response), the stored object is verified instead of failing.
 */
export async function completeUpload(
  db: DbOrTx,
  storage: ObjectStorage,
  actor: Actor,
  videoId: string,
  input: z.infer<typeof completeUploadInput>,
): Promise<VideoRow> {
  const video = await loadOwnUpload(db, actor, videoId);
  if (video.status === "uploaded" || video.status === "validated") return video;
  if (video.status !== "uploading" || !video.multipartUploadId) throw conflict("This upload is no longer active.");

  const numbers = input.parts.map((p) => p.partNumber).sort((a, b) => a - b);
  if (numbers.length !== video.partCount || numbers.some((n, i) => n !== i + 1)) {
    throw invalidInput("Every part must be uploaded exactly once before completing.");
  }

  try {
    await storage.completeMultipartUpload(
      video.storageKey,
      video.multipartUploadId,
      [...input.parts].sort((a, b) => a.partNumber - b.partNumber),
    );
  } catch (err) {
    // Either a genuine failure or an earlier completion; the HEAD below decides.
    log.warn({ err, videoId }, "multipart completion failed; verifying stored object");
  }

  const size = await storage.headObjectSize(video.storageKey);
  if (size === null) throw conflict("The upload is incomplete. Retry the missing parts.");
  if (size !== video.declaredSizeBytes) {
    await reject(db, storage, video, "size_mismatch");
    throw invalidInput("The uploaded file size does not match the declared size.");
  }

  const head = await storage.readRange(video.storageKey, 0, 63);
  if (!sniffContainer(head)) {
    await reject(db, storage, video, "unrecognized_container");
    throw invalidInput("The file is not a supported video format.");
  }

  // Retention starts when the footage is stored; the worker's maintenance sweep purges it after.
  const { limits } = await getEntitlements(db, actor.orgId);
  const uploadedAt = new Date();
  const deleteAfter = new Date(uploadedAt.getTime() + limits.retentionDays * 86_400_000);
  const [updated] = await db
    .update(videos)
    .set({ status: "uploaded", sizeBytes: size, uploadedAt, deleteAfter, multipartUploadId: null })
    .where(and(eq(videos.id, video.id), eq(videos.status, "uploading")))
    .returning();
  // A concurrent completion may have won; return the current row either way.
  if (updated) return updated;
  const [current] = await db.select().from(videos).where(eq(videos.id, video.id));
  return current;
}

export async function abortUpload(db: DbOrTx, storage: ObjectStorage, actor: Actor, videoId: string) {
  const video = await loadOwnUpload(db, actor, videoId);
  if (video.status !== "uploading") return;
  if (video.multipartUploadId) {
    await storage
      .abortMultipartUpload(video.storageKey, video.multipartUploadId)
      .catch((err) => log.warn({ err, videoId }, "abort failed"));
  }
  await db
    .update(videos)
    .set({ status: "aborted", multipartUploadId: null })
    .where(and(eq(videos.id, video.id), eq(videos.status, "uploading")));
}
