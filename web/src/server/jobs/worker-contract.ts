import { z } from "zod";
import { videoEventsSchema } from "@/lib/analysis/video-events";
import { summarySchema } from "../analysis/results";

const workerId = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._-]+$/);
const lease = { workerId, jobId: z.uuid() };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const checkpointEntry = z.object({
  binding: digest, sha256: digest,
  name: z.string().regex(/^(?:(?:detections|llm)-[a-f0-9]{64}\.json\.gz|result-[a-f0-9]{64}\.tar\.gz)$/),
  key: z.string().max(1000), size: z.number().int().min(1).max(256 * 1024 * 1024),
}).strict();
export const workerRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("claim"), workerId }).strict(),
  z.object({ op: z.literal("heartbeat"), ...lease }).strict(),
  z.object({ op: z.literal("progress"), ...lease, stage: z.string().min(1).max(80),
    progress: z.number().min(0).max(1) }).strict(),
  z.object({ op: z.literal("checkpoints"), ...lease, entries: z.array(checkpointEntry).max(2048) }).strict(),
  z.object({ op: z.literal("outputs"), ...lease, count: z.number().int().min(0).max(24) }).strict(),
  z.object({ op: z.literal("complete_prepare"), ...lease,
    info: z.object({ container: z.string().min(1).max(80), video_codec: z.string().min(1).max(80),
      duration_seconds: z.number().min(10), width: z.number().int().positive().max(20000),
      height: z.number().int().positive().max(20000), fps: z.number().positive().max(300) }).strict(),
    frames: z.array(z.object({ key: z.string().max(1000), timeSeconds: z.number().nonnegative(),
      width: z.number().int().positive(), height: z.number().int().positive() }).strict()).min(1).max(30),
    cameraMotion: z.enum(["fixed", "moving", "unknown"]), models: z.record(z.string(), z.string().or(z.array(z.string()))),
  }).strict(),
  z.object({ op: z.literal("complete_analysis"), ...lease,
    // Preserve the legacy-compatible shell; the detailed AI payload is validated explicitly.
    summary: summarySchema.extend({ videoEvents: videoEventsSchema }),
    models: z.record(z.string(), z.string()),
  }).strict(),
  z.object({ op: z.literal("fail"), ...lease, code: z.string().regex(/^[a-z0-9_]{1,80}$/),
    retryable: z.boolean(), rejectVideo: z.boolean() }).strict(),
  z.object({ op: z.literal("cancel"), ...lease }).strict(),
  z.object({ op: z.literal("maintenance") }).strict(),
  z.object({ op: z.literal("cleanup"), jobId: z.uuid() }).strict(),
]);
export type WorkerRequest = z.infer<typeof workerRequest>;
