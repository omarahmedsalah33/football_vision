"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;
const ACCEPT = ".mp4,.m4v,.mov,.mkv,.webm";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; sent: number; total: number }
  | { kind: "finalizing" }
  | { kind: "error"; message: string };

type StartResponse = { videoId: string; partSize: number; partCount: number };
type CompleteResponse = { videoId: string; analysis: { jobId?: string; error?: { message: string } } };

class Cancelled extends Error {}

function formatBytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
}

/** Uploads one part with progress; resolves with the ETag storage returned. */
function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, xhrs: Set<XMLHttpRequest>) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrs.add(xhr);
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      xhrs.delete(xhr);
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status === 200 && etag) resolve(etag);
      else reject(new Error(`part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => {
      xhrs.delete(xhr);
      reject(new Error("network error"));
    };
    xhr.onabort = () => {
      xhrs.delete(xhr);
      reject(new Cancelled());
    };
    xhr.send(blob);
  });
}

export function Uploader({ orgId, matchId }: { orgId: string; matchId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const xhrs = useRef(new Set<XMLHttpRequest>());
  const cancelled = useRef(false);
  const videoId = useRef<string | null>(null);

  const busy = phase.kind === "uploading" || phase.kind === "finalizing";
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  async function upload(file: File) {
    cancelled.current = false;
    setNotice(null);
    try {
      const start = await apiPost<StartResponse>(`/api/orgs/${orgId}/matches/${matchId}/uploads`, {
        filename: file.name,
        sizeBytes: file.size,
        contentType: file.type,
      });
      videoId.current = start.videoId;
      const loaded = new Map<number, number>();
      const etags: { partNumber: number; etag: string }[] = [];
      const queue = Array.from({ length: start.partCount }, (_, i) => i + 1);
      const report = () =>
        setPhase({ kind: "uploading", sent: [...loaded.values()].reduce((a, b) => a + b, 0), total: file.size });
      report();

      const worker = async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
          const blob = file.slice((n - 1) * start.partSize, n * start.partSize);
          for (let attempt = 1; ; attempt++) {
            if (cancelled.current) throw new Cancelled();
            try {
              // URLs are requested just in time because they expire after a few minutes.
              const { parts } = await apiPost<{ parts: { url: string }[] }>(
                `/api/orgs/${orgId}/videos/${start.videoId}/parts`,
                { partNumbers: [n] },
              );
              const etag = await putPart(parts[0].url, blob, (l) => {
                loaded.set(n, l);
                report();
              }, xhrs.current);
              etags.push({ partNumber: n, etag });
              break;
            } catch (err) {
              if (err instanceof Cancelled || cancelled.current) throw new Cancelled();
              if (err instanceof ApiError && err.status < 500 && err.status !== 429) throw err;
              if (attempt >= MAX_ATTEMPTS) throw new Error("The connection kept failing. Please try again.");
              loaded.set(n, 0);
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, start.partCount) }, worker));

      setPhase({ kind: "finalizing" });
      const done = await apiPost<CompleteResponse>(`/api/orgs/${orgId}/videos/${start.videoId}/complete`, { parts: etags });
      if (done.analysis.error) setNotice(`Video saved. ${done.analysis.error.message}`);
      setPhase({ kind: "idle" });
      router.refresh();
    } catch (err) {
      if (err instanceof Cancelled) {
        setPhase({ kind: "idle" });
        setNotice("Upload cancelled.");
        return;
      }
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Upload failed." });
      router.refresh();
    }
  }

  async function cancel() {
    cancelled.current = true;
    for (const xhr of xhrs.current) xhr.abort();
    if (videoId.current) {
      await apiPost(`/api/orgs/${orgId}/videos/${videoId.current}/abort`).catch(() => undefined);
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {phase.kind === "uploading" || phase.kind === "finalizing" ? (
        <div className="space-y-3">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.kind === "uploading" ? Math.floor((phase.sent / phase.total) * 100) : 100}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: phase.kind === "uploading" ? `${(phase.sent / phase.total) * 100}%` : "100%" }}
            />
          </div>
          <p className="text-sm text-muted" aria-live="polite">
            {phase.kind === "uploading"
              ? `${formatBytes(phase.sent)} of ${formatBytes(phase.total)} uploaded. Keep this tab open.`
              : "Verifying the upload…"}
          </p>
          {phase.kind === "uploading" && (
            <Button variant="danger" onClick={cancel}>
              Cancel upload
            </Button>
          )}
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong p-8 text-center hover:border-accent/60 focus-within:border-accent">
          <span className="font-medium">Choose match video</span>
          <span className="text-sm text-muted">MP4, MOV, M4V, MKV or WebM from a fixed wide-angle camera</span>
          <input
            type="file"
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="text-sm text-danger">
          {phase.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
    </div>
  );
}
