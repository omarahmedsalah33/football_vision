"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

/** Re-renders the server page periodically while work is in progress. */
export function LiveRefresh({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}

export function AnalysisActions({
  orgId,
  matchId,
  jobId,
  canCancel,
  canStartAi = false,
  startLabel = "Start AI analysis",
  regenerate = false,
}: {
  orgId: string;
  matchId: string;
  jobId?: string;
  canCancel: boolean;
  canStartAi?: boolean;
  startLabel?: string;
  regenerate?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerTracking, setPlayerTracking] = useState(false);

  async function run(path: string, body?: unknown) {
    setPending(true);
    setError(null);
    try {
      await apiPost(path, body);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  function start() {
    if (regenerate && !window.confirm("Regenerate with the latest algorithm and gold-card report? The current report will become unavailable, even if this run fails. Your video and lineup stay. This uses an analysis allowance and may incur AI processing costs.")) return;
    void run(`/api/orgs/${orgId}/matches/${matchId}/analysis`, { engine: "llm", playerTracking: regenerate ? false : playerTracking });
  }

  if (!canCancel && !canStartAi) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {canStartAi && !regenerate && (
        <label className="flex min-w-0 basis-full flex-wrap items-center gap-2 text-sm">
          Analysis mode
          <select className="min-w-0 max-w-full rounded border border-border bg-surface p-2" disabled={pending}
            value={playerTracking ? "tracking" : "standard"} onChange={(e) => setPlayerTracking(e.target.value === "tracking")}>
            <option value="standard">Gemini + Astra</option>
            <option value="tracking">Gemini + Astra + player tracking (experimental)</option>
          </select>
        </label>
      )}
      {canStartAi && (
        <Button disabled={pending} onClick={start}>
          {pending ? "Starting…" : startLabel}
        </Button>
      )}
      {canCancel && jobId && (
        <Button variant="danger" disabled={pending} onClick={() => run(`/api/orgs/${orgId}/jobs/${jobId}/cancel`)}>
          Cancel
        </Button>
      )}
      {canStartAi && (
        <p className="basis-full text-xs text-muted">
          AI match statistics runs in the background on Modal over the full video, using Gemini with Astra review. If Astra is neutral, Gemini&apos;s decision stands. Results are AI estimates and some actions may be missing or uncertain. Players are told apart by appearance in this video only; no face recognition. No pitch calibration needed.
        </p>
      )}
      {canStartAi && !playerTracking && (
        <p className="basis-full text-xs text-muted">
          Ball actions are detected first, then their actors are checked in short video contexts against one player registry.
          Uncertain actors remain unassigned; duplicate actions are excluded from totals.
        </p>
      )}
      {canStartAi && regenerate && <p className="basis-full text-xs text-muted">
        Regeneration replaces this report using the latest gold-card algorithm and a fresh full-video player-photo selection. No report history is retained. Failed runs can be retried.
      </p>}
      {canStartAi && playerTracking && (
        <p className="basis-full text-xs text-muted">
          Adds a Modal GPU player-tracking step and extra processing cost. Only reference-backed tracks can receive player statistics.
          Lost tracks and camera cuts stay unresolved; this may reduce assignments rather than increase them.
          No ball tracking, face recognition, speed or distance measurement in this mode.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
