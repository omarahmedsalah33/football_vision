import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

export const PRESIGN_TTL_SECONDS = 15 * 60;

export interface ObjectStorage {
  createMultipartUpload(key: string): Promise<string>;
  /** URL for one part; the exact byte length is part of the signature. */
  presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  headObjectSize(key: string): Promise<number | null>;
  readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
}

type S3Config = {
  endpoint?: string;
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  // Presigned URLs must use the host the browser can reach, which can differ from the internal one.
  private readonly presignClient: S3Client;

  constructor(private readonly cfg: S3Config) {
    const base = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Avoid SDK-added checksum headers the browser would then have to send.
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.presignClient = new S3Client({ ...base, endpoint: cfg.publicEndpoint ?? cfg.endpoint });
  }

  async createMultipartUpload(key: string): Promise<string> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        // Never trust the client's MIME type; playback URLs set a validated type later.
        ContentType: "application/octet-stream",
      }),
    );
    if (!out.UploadId) throw new Error("Storage did not return an upload id");
    return out.UploadId;
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new UploadPartCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn: PRESIGN_TTL_SECONDS, signableHeaders: new Set(["content-length"]) },
    );
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.cfg.bucket, Key: key, UploadId: uploadId }));
  }

  async headObjectSize(key: string): Promise<number | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return out.ContentLength ?? null;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }),
    );
    if (!out.Body) return new Uint8Array();
    return out.Body.transformToByteArray();
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

let storage: ObjectStorage | undefined;

export function getStorage(): ObjectStorage {
  if (!storage) {
    const e = env();
    storage = new S3Storage({
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    });
  }
  return storage;
}
