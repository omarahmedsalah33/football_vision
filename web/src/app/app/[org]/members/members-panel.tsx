"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { apiRequest, ApiError } from "@/lib/api-client";

const ROLES = ["owner", "admin", "coach", "analyst", "scout", "player"] as const;
type Role = (typeof ROLES)[number];

type Member = { userId: string; displayName: string | null; email: string | null; role: Role; status: string; joinedAt: string };
type Invitation = { id: string; email: string; role: Role; expiresAt: string };

/** Mirrors the server rule (canAssign) so the UI only offers what will succeed. */
function assignable(myRole: Role, current: Role | null): Role[] {
  if (myRole === "owner") return [...ROLES];
  if (myRole === "admin" && current !== "owner") return ROLES.filter((r) => r !== "owner");
  return [];
}

const field = "rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-fg";

export function MembersPanel({
  orgId,
  me,
  canManage,
  members,
  invitations,
}: {
  orgId: string;
  me: { userId: string; role: Role };
  canManage: boolean;
  members: Member[];
  invitations: Invitation[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    await act(async () => {
      const res = await apiRequest<{ link: string }>("POST", `/api/orgs/${orgId}/members`, {
        email: String(data.get("email") ?? "").trim(),
        role: data.get("role"),
      });
      setLink(res.link);
      setCopied(false);
      form.reset();
    });
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {canManage && (
        <Card className="p-6" corners="pitchline">
          <h2 className="text-lg font-semibold">Invite someone</h2>
          <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex-1 text-sm font-medium">
              Email
              <input name="email" type="email" required maxLength={200} className={`mt-1 w-full ${field}`} />
            </label>
            <label className="text-sm font-medium">
              Role
              <select name="role" defaultValue="coach" className={`mt-1 block ${field}`}>
                {assignable(me.role, null).map((r) => (
                  <option key={r} value={r} className="capitalize">
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={busy}>
              Create invitation
            </Button>
          </form>
          {link && (
            <div role="status" className="mt-4 rounded-lg border border-mindaro/40 bg-accent-soft p-4 text-sm">
              <p className="font-semibold text-mindaro">Invitation created. Send this link to them:</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="font-data break-all rounded bg-bg px-2 py-1 text-xs">{link}</code>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <p className="mt-2 text-muted">
                It works once, for that email address only, for 7 days. We can&apos;t show it again. Email delivery is not
                connected yet, so share it yourself.
              </p>
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <caption className="sr-only">Workspace members</caption>
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th scope="col" className="px-5 py-3 font-medium">Member</th>
              <th scope="col" className="px-5 py-3 font-medium">Role</th>
              <th scope="col" className="px-5 py-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => {
              const options = assignable(me.role, m.role);
              const self = m.userId === me.userId;
              return (
                <tr key={m.userId}>
                  <td className="px-5 py-3">
                    <p className="font-medium">
                      {m.displayName ?? "Unnamed member"} {self && <Badge tone="accent">You</Badge>}
                    </p>
                    <p className="text-muted">{m.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    {canManage && options.length > 0 ? (
                      <select
                        aria-label={`Role for ${m.displayName ?? m.email ?? "member"}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          act(() => apiRequest("PATCH", `/api/orgs/${orgId}/members/${m.userId}`, { role: e.target.value }))
                        }
                        className={field}
                      >
                        {options.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="capitalize">{m.role}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {self ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          confirm("Leave this workspace? You will lose access to its matches.") &&
                          act(async () => {
                            await apiRequest("DELETE", `/api/orgs/${orgId}/members/${m.userId}`);
                            router.push("/app");
                          })
                        }
                      >
                        Leave
                      </Button>
                    ) : (
                      canManage &&
                      options.length > 0 && (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            confirm(`Remove ${m.displayName ?? m.email} from the workspace?`) &&
                            act(() => apiRequest("DELETE", `/api/orgs/${orgId}/members/${m.userId}`))
                          }
                        >
                          Remove
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {canManage && invitations.length > 0 && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold">Pending invitations</h2>
          <ul className="mt-3 divide-y divide-border text-sm">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  {i.email} <span className="capitalize text-muted">· {i.role}</span>
                  <span className="font-data ml-2 text-xs text-muted">expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                </span>
                <Button variant="ghost" disabled={busy} onClick={() => act(() => apiRequest("DELETE", `/api/orgs/${orgId}/invitations/${i.id}`))}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-muted">
        What each role can do is listed in the{" "}
        <Link href="/docs#roles" className="text-mindaro underline underline-offset-4">
          roles table
        </Link>
        .
      </p>
    </div>
  );
}
