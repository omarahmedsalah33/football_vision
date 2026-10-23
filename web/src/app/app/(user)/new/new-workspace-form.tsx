"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

const field = "mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-fg";

export function NewWorkspaceForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      const org = await apiPost<{ slug: string }>("/api/orgs", { name: String(f.get("name") ?? "").trim(), kind: f.get("kind") });
      router.push(`/app/${org.slug}/members`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the workspace.");
      setBusy(false);
    }
  }

  return (
    <Card className="mt-8 p-6" corners="pitchline">
      <form onSubmit={onSubmit} className="space-y-5">
        <label className="block text-sm font-medium">
          Club or academy name
          <input name="name" required minLength={2} maxLength={80} className={field} placeholder="Nile Stars Academy" />
        </label>
        <fieldset>
          <legend className="text-sm font-medium">Type</legend>
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" value="club" defaultChecked /> Club
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" value="academy" /> Academy
            </label>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </form>
    </Card>
  );
}
