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
  canStart,
  canCancel,
}: {
  orgId: string;
  matchId: string;
  jobId?: string;
  canStart: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string) {
    setPending(true);
    setError(null);
    try {
      await apiPost(path);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  if (!canStart && !canCancel) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {canStart && (
        <Button disabled={pending} onClick={() => run(`/api/orgs/${orgId}/matches/${matchId}/analysis`)}>
          Start analysis
        </Button>
      )}
      {canCancel && jobId && (
        <Button variant="danger" disabled={pending} onClick={() => run(`/api/orgs/${orgId}/jobs/${jobId}/cancel`)}>
          Cancel analysis
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
