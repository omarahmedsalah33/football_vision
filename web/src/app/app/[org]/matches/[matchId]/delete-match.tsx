"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { apiRequest, ApiError } from "@/lib/api-client";

/** Shown only to roles with "match.delete" (owners and admins); the server checks again. */
export function DeleteMatch({ orgId, orgSlug, matchId, title }: { orgId: string; orgSlug: string; matchId: string; title: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("DELETE", `/api/orgs/${orgId}/matches/${matchId}`);
      router.push(`/app/${orgSlug}/matches`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Deletion failed. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <Card className="border-danger/40 p-6">
      <h2 className="text-lg font-semibold">Delete this match</h2>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Removes the match, its video, calibration and results for everyone in this workspace. Any analysis still
        running is stopped. Footage is permanently erased within 7 days, and this can&apos;t be undone.
      </p>
      {!confirming ? (
        <Button variant="danger" className="mt-4" onClick={() => setConfirming(true)}>
          Delete match
        </Button>
      ) : (
        <div role="alertdialog" aria-labelledby="delete-match-confirm" className="mt-4 rounded-lg border border-danger/50 bg-bg p-4">
          <p id="delete-match-confirm" className="text-sm font-medium">
            Delete “{title}”? This can&apos;t be undone.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Yes, delete match"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)} autoFocus>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
