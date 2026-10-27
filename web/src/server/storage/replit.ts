import { randomUUID } from "node:crypto";
import { Storage, type File } from "@google-cloud/storage";
import type { ObjectStorage } from "./s3";

const SIDECAR = "http://127.0.0.1:1106";
const TTL = 15 * 60;
const UPLOAD_ID = /^\d{13}-[0-9a-f-]{36}$/;

export function assertObjectKey(key: string) {
  if (!key || key.length > 1024 || key.startsWith("/") || key.includes("\\") ||
      key.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      /[\x00-\x1f\x7f]/.test(key)) {
    throw new Error("Invalid private object key");
  }
}

export const replitStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

/** Keeps the existing chunk/retry UI. Chunks go directly to private GCS objects;
 * completion verifies them and uses server-side composition, never proxying video bytes. */
export class ReplitStorage implements ObjectStorage {
  readonly bucket;
  readonly prefix: string;

  constructor(privateDir = process.env.PRIVATE_OBJECT_DIR, client = replitStorageClient) {
    if (!privateDir) throw new Error("Missing required environment variable: PRIVATE_OBJECT_DIR");
    const [bucketName, ...parts] = privateDir.replace(/^\/+|\/+$/g, "").split("/");
    if (!bucketName || !parts.length) throw new Error("Invalid PRIVATE_OBJECT_DIR configuration");
    this.bucket = client.bucket(bucketName);
    // Published and preview apps never share object keys, even in the same provisioned bucket.
    this.prefix = `${parts.join("/")}/football-vision/${process.env.NODE_ENV === "production" ? "production" : "development"}`;
  }

  file(key: string): File {
    assertObjectKey(key);
    return this.bucket.file(`${this.prefix}/${key}`);
  }

  private staging(uploadId: string, suffix: string) {
    if (!UPLOAD_ID.test(uploadId)) throw new Error("Invalid multipart upload ID");
    return this.file(`_multipart/${uploadId}/${suffix}`);
  }

  private async assertUpload(key: string, uploadId: string) {
    assertObjectKey(key);
    const [data] = await this.staging(uploadId, "manifest.json").download();
    const manifest = JSON.parse(data.toString("utf8")) as { key?: string };
    if (manifest.key !== key) throw new Error("Multipart upload does not belong to this object");
  }

  private async sign(file: File, method: "GET" | "PUT", ttl = TTL) {
    const response = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: this.bucket.name, object_name: file.name, method,
        expires_at: new Date(Date.now() + Math.min(Math.max(ttl, 30), 3600) * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Private storage URL signing failed");
    const body = await response.json() as { signed_url?: string };
    if (!body.signed_url) throw new Error("Private storage URL signing returned no URL");
    return body.signed_url;
  }

  async createMultipartUpload(key: string) {
    assertObjectKey(key);
    const id = `${Date.now()}-${randomUUID()}`;
    await this.staging(id, "manifest.json").save(JSON.stringify({ key }), {
      resumable: false,
      metadata: { contentType: "application/json" },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return id;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number) {
    await this.assertUpload(key, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 ||
        !Number.isSafeInteger(contentLength) || contentLength < 1) throw new Error("Invalid upload part");
    return this.sign(this.staging(uploadId, `parts/${partNumber}`), "PUT");
  }

  /** Replit's CORS configuration need not expose ETag to JavaScript.
   * An authenticated app route reads a verified receipt without exposing bucket credentials. */
  async uploadPartReceipt(key: string, uploadId: string, partNumber: number, contentLength: number) {
    await this.assertUpload(key, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new Error("Invalid upload part");
    const [metadata] = await this.staging(uploadId, `parts/${partNumber}`).getMetadata();
    if (Number(metadata.size) !== contentLength || !metadata.etag) {
      throw new Error("Uploaded part has an incorrect size");
    }
    return metadata.etag;
  }

  async completeMultipartUpload(
    key: string, uploadId: string,
    parts: { partNumber: number; etag: string; sizeBytes?: number }[],
  ) {
    await this.assertUpload(key, uploadId);
    if (!parts.length || parts.length > 10_000 ||
        parts.some((part, index) => part.partNumber !== index + 1)) {
      throw new Error("Upload parts must be complete and ordered");
    }
    let sources: File[] = [];
    // Bounded concurrency; verify sizes and ETags before making a source visible.
    for (let index = 0; index < parts.length; index += 16) {
      sources.push(...await Promise.all(parts.slice(index, index + 16).map(async (part) => {
        const file = this.staging(uploadId, `parts/${part.partNumber}`);
        const [metadata] = await file.getMetadata();
        const etag = part.etag.replace(/^"|"$/g, "");
        const md5 = metadata.md5Hash ? Buffer.from(metadata.md5Hash, "base64").toString("hex") : undefined;
        if (!Number.isSafeInteger(part.sizeBytes) || Number(metadata.size) !== part.sizeBytes ||
            ![metadata.etag?.replace(/^"|"$/g, ""), md5].includes(etag)) {
          throw new Error("An uploaded part has changed or has an incorrect size");
        }
        // Pin the generation so a still-valid part URL cannot replace data after verification.
        return this.bucket.file(file.name, { generation: metadata.generation });
      })));
    }
    const attempt = randomUUID();
    let level = 0;
    while (sources.length > 32) {
      const next: File[] = [];
      for (let index = 0; index < sources.length; index += 32) {
        const dest = this.staging(uploadId, `composed/${attempt}/${level}/${index}`);
        const [combined] = await this.bucket.combine(sources.slice(index, index + 32), dest, {
          ifGenerationMatch: 0,
        });
        next.push(combined);
      }
      sources = next;
      level++;
    }
    await this.bucket.combine(sources, this.file(key), { ifGenerationMatch: 0 });
    // A cleanup failure must not turn a successfully committed upload into a failed one.
    await this.abortMultipartUpload(key, uploadId).catch(() => {});
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    try { await this.assertUpload(key, uploadId); }
    catch (error) {
      if ((error as { code?: number }).code === 404) return;
      throw error;
    }
    await this.bucket.deleteFiles({ prefix: `${this.staging(uploadId, "manifest.json").name.slice(0, -"manifest.json".length)}`, force: true });
  }

  async headObjectSize(key: string): Promise<number | null> {
    try {
      const [metadata] = await this.file(key).getMetadata();
      return Number(metadata.size);
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  }

  async readRange(key: string, start: number, end: number) {
    const [data] = await this.file(key).download({ start, end, validation: false });
    return new Uint8Array(data);
  }

  async deleteObject(key: string) {
    await this.file(key).delete({ ignoreNotFound: true });
  }

  async presignGet(key: string, contentType: string, ttl = TTL) {
    const file = this.file(key);
    await file.setMetadata({ contentType, contentDisposition: "inline", cacheControl: "private, max-age=0" });
    return this.sign(file, "GET", ttl);
  }

  presignWorkerUpload(key: string) {
    return this.sign(this.file(key), "PUT");
  }

  presignWorkerDownload(key: string) {
    return this.sign(this.file(key), "GET");
  }

  /** Late PUTs can arrive after cancellation. Remove only staging objects older than 24h. */
  async cleanupStaleUploads() {
    const prefix = `${this.prefix}/_multipart/`;
    let pageToken: string | undefined;
    let deleted = 0;
    do {
      const [files, next] = await this.bucket.getFiles({ prefix, autoPaginate: false, maxResults: 500, pageToken });
      for (const file of files) {
        const created = Date.parse(file.metadata.timeCreated ?? "");
        if (Number.isFinite(created) && created < Date.now() - 24 * 60 * 60 * 1000) {
          await file.delete({ ignoreNotFound: true });
          deleted++;
        }
      }
      pageToken = next?.pageToken;
    } while (pageToken);
    return deleted;
  }
}
