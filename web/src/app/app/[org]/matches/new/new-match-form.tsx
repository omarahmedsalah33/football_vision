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
        format: form.get("format") === "standard" ? "standard" : "seven_a_side",
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
        <fieldset>
          <legend className="text-sm font-medium">Match format</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {([["seven_a_side", "7-a-side", "Name up to seven players per team and get player stat cards."], ["standard", "Standard", "Full-size match without a named line-up."]] as const).map(([v, l, d]) => (
              <label key={v} className="flex cursor-pointer gap-3 rounded-lg border border-border bg-surface-2 p-3 text-sm has-[:checked]:border-mindaro">
                <input type="radio" name="format" value={v} defaultChecked={v === "seven_a_side"} className="mt-1" />
                <span><span className="block font-medium">{l}</span><span className="text-muted">{d}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">
          Fixed, elevated, wide recordings that show most of the pitch give the best results. Other footage may work less well, and we cannot promise every recording will be analysed accurately.
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
