"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { apiRequest, ApiError } from "@/lib/api-client";

type Ref = { id: string; name: string };
type Plan = { deleteOrgs: Ref[]; leaveOrgs: Ref[]; blockers: Ref[] };

export function DeleteAccount() {
  const { signOut } = useClerk();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest<Plan>("GET", "/api/account")
      .then(setPlan)
      .catch(() => setError("Could not load what deletion would affect."));
  }, []);

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await apiRequest("DELETE", "/api/account", { confirm: "DELETE" });
      await signOut({ redirectUrl: "/" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Deletion failed. Check your connection.");
      setBusy(false);
    }
  }

  if (!plan) return <p className="mt-2 text-sm text-muted">{error ?? "Checking what this would affect…"}</p>;

  return (
    <div className="mt-3 space-y-4 text-sm">
      <p className="text-muted">
        This permanently deletes your sign-in account and erases your name and email. It can&apos;t be undone.
      </p>
      {plan.deleteOrgs.length > 0 && (
        <div>
          <p className="font-medium">These workspaces will be deleted, with their matches and footage purged after 7 days:</p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {plan.deleteOrgs.map((o) => (
              <li key={o.id}>{o.name}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.leaveOrgs.length > 0 && (
        <div>
          <p className="font-medium">You will leave these workspaces (they keep their data and other members):</p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {plan.leaveOrgs.map((o) => (
              <li key={o.id}>{o.name}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.blockers.length > 0 ? (
        <p role="alert" className="rounded-lg border border-gold/50 bg-gold/10 p-3">
          You are the only owner of {plan.blockers.map((b) => b.name).join(", ")}. Make another member an owner (on the
          Members page) before deleting your account, so the club isn&apos;t left without anyone in charge.
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
        >
          <label className="block font-medium">
            Type <span className="font-data">DELETE</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full max-w-xs rounded-lg border border-border-strong bg-bg px-3 py-2 text-fg"
            />
          </label>
          <p className="text-xs text-muted">For your security you need to have signed in within the last 10 minutes.</p>
          <Button type="submit" variant="danger" disabled={busy || typed !== "DELETE"}>
            Delete my account
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
