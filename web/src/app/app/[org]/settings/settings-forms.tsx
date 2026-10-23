"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { apiRequest, ApiError } from "@/lib/api-client";

const field = "mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-fg";

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed. Check your connection.");
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}

export function RenameWorkspace({ orgId, name }: { orgId: string; name: string }) {
  const router = useRouter();
  const { error, busy, run } = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get("name") ?? "").trim();
        void run(async () => {
          await apiRequest("PATCH", `/api/orgs/${orgId}`, { name: value });
          setSaved(true);
          router.refresh();
        });
      }}
    >
      <label className="min-w-64 flex-1 text-sm font-medium">
        Workspace name
        <input name="name" defaultValue={name} required minLength={2} maxLength={80} className={field} onChange={() => setSaved(false)} />
      </label>
      <Button type="submit" disabled={busy}>
        Save
      </Button>
      {saved && (
        <p role="status" className="w-full text-sm text-mindaro">
          Saved.
        </p>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

export function DeleteWorkspace({ orgId, name }: { orgId: string; name: string }) {
  const router = useRouter();
  const { error, busy, run } = useAction();
  const [typed, setTyped] = useState("");
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await apiRequest("DELETE", `/api/orgs/${orgId}`, { confirmName: typed });
          router.push("/app");
        });
      }}
    >
      <p className="text-sm text-muted">
        Deleting the workspace removes access for every member immediately. Its matches and footage are permanently
        purged after 7 days. For your security you need to have signed in within the last 10 minutes.
      </p>
      <label className="block text-sm font-medium">
        Type <span className="font-data text-fg">{name}</span> to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} className={field} autoComplete="off" />
      </label>
      <Button type="submit" variant="danger" disabled={busy || typed !== name}>
        Delete workspace
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
