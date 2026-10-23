"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <Button
        className="w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await apiPost<{ orgSlug: string }>("/api/invitations/accept", { token });
            router.push(`/app/${res.orgSlug}/matches`);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Could not accept the invitation.");
            setBusy(false);
          }
        }}
      >
        Accept invitation
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
