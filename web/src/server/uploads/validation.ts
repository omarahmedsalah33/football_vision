import { z } from "zod";

const MiB = 1024 * 1024;
export const MIN_PART_BYTES = 16 * MiB; // S3 requires >= 5 MiB for every part except the last
export const MAX_PARTS = 10_000;
export const MAX_PRESIGN_BATCH = 100;

// Extension → MIME types a browser may report for it. The declared type is only a sanity check;
// real validation is the magic-byte sniff on completion and the worker's container probe.
const ALLOWED: Record<string, string[]> = {
  mp4: ["video/mp4"],
  m4v: ["video/mp4", "video/x-m4v"],
  mov: ["video/quicktime"],
  mkv: ["video/x-matroska", "video/matroska", ""],
  webm: ["video/webm"],
};

export const startUploadInput = z.object({
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().max(100),
});

export const presignPartsInput = z.object({
  partNumbers: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(MAX_PRESIGN_BATCH),
});

export const completeUploadInput = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(MAX_PARTS), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(MAX_PARTS),
});

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Returns an error message, or null when the declared file is acceptable. */
export function checkDeclaredFile(filename: string, contentType: string): string | null {
  const ext = extensionOf(filename);
  const types = ALLOWED[ext];
  if (!types) return "Unsupported file type. Upload MP4, MOV, M4V, MKV or WebM video.";
  if (!types.includes(contentType.toLowerCase())) return "The file type does not match its extension.";
  return null;
}

/** Display-only name: no path, no control characters, bounded length. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "video";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  return (clean || "video").slice(0, 120);
}

export function planParts(sizeBytes: number): { partSize: number; partCount: number } {
  const needed = Math.ceil(sizeBytes / MAX_PARTS / MiB) * MiB;
  const partSize = Math.max(MIN_PART_BYTES, needed);
  return { partSize, partCount: Math.ceil(sizeBytes / partSize) };
}

export function partLength(sizeBytes: number, partSize: number, partCount: number, partNumber: number): number {
  return partNumber < partCount ? partSize : sizeBytes - partSize * (partCount - 1);
}

/** Identifies the container from its first bytes. Only formats the worker can decode pass. */
export function sniffContainer(head: Uint8Array): "isobmff" | "matroska" | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "matroska"; // MKV and WebM (EBML header)
  }
  if (head.length >= 8) {
    const box = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(box)) return "isobmff"; // MP4 / MOV
  }
  return null;
}
