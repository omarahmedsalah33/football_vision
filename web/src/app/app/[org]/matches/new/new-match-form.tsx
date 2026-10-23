"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

const input = "mt-1 w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-fg placeholder:text-muted/70";

export function NewMatchForm({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const text = (k: string) => (form.get(k) as string | null)?.trim() || undefined;
    try {
      const { id } = await apiPost<{ id: string }>(`/api/orgs/${orgId}/matches`, {
        title: text("title"),
        opponentName: text("opponentName"),
        playedOn: text("playedOn"),
      });
      router.push(`/app/${orgSlug}/matches/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the match. Check your connection.");
      setPending(false);
    }
  }

  return (
    <Card className="mt-8 p-6">
      <form onSubmit={onSubmit} className="space-y-5" noValidate={false}>
        <label className="block text-sm font-medium">
          Match title
          <input name="title" required minLength={2} maxLength={120} placeholder="U17 League: Matchday 4" className={input} />
        </label>
        <label className="block text-sm font-medium">
          Opponent <span className="font-normal text-muted">(optional)</span>
          <input name="opponentName" maxLength={120} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Date played <span className="font-normal text-muted">(optional)</span>
          <input name="playedOn" type="date" className={input} />
        </label>
        <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">
          Analysis currently supports footage from a <strong className="text-fg">fixed, wide-angle camera</strong>{" "}
          that shows most of the pitch. Broadcast and handheld footage are not supported yet.
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create match"}
        </Button>
      </form>
    </Card>
  );
}
