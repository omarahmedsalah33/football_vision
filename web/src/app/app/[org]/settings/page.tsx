import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-ui";
import { Badge, Card } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { auditLog, usageSummary } from "@/server/orgs/settings";
import { listMyOrgs } from "@/server/orgs/service";
import { DeleteWorkspace, RenameWorkspace } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

const ACTION_LABEL: Record<string, string> = {
  "org.created": "Workspace created",
  "org.renamed": "Workspace renamed",
  "org.deleted": "Workspace deleted",
  "member.invited": "Invitation sent",
  "member.invitation_revoked": "Invitation revoked",
  "member.joined": "Member joined",
  "member.role_changed": "Role changed",
  "member.removed": "Member removed",
  "member.left": "Member left",
  "match.deleted": "Match deleted",
  "player.created": "Player profile created",
  "player.updated": "Player profile updated",
  "player.archived": "Player profile archived",
  "plan.created": "Development plan created",
  "plan.closed": "Development plan closed",
  "drill.created": "Drill added to the library",
  "drill.archived": "Drill removed from the library",
  "billing.plan_changed": "Plan changed",
};

function Meter({ label, used, limit, unit, extra }: { label: string; used: number; limit: number; unit?: string; extra?: string }) {
  const pct = Math.min(100, limit > 0 ? (used / limit) * 100 : 0);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted">{label}</p>
        <p className="font-data text-sm">
          {used}
          {unit} <span className="text-muted">/ {limit}{unit}</span>
        </p>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="mt-2 h-2 overflow-hidden rounded-full bg-bg"
      >
        <div className={`h-full ${pct >= 100 ? "bg-gold" : "bg-mindaro"}`} style={{ width: `${pct}%` }} />
      </div>
      {extra && <p className="mt-1 text-xs text-muted">{extra}</p>}
    </div>
  );
}

export default function SettingsPage({ params }: PageProps<"/app/[org]/settings">) {
  return (
    <div className="mx-auto max-w-5xl">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-surface" aria-label="Loading settings" />}>
        <Settings params={params} />
      </Suspense>
    </div>
  );
}

async function Settings({ params }: { params: PageProps<"/app/[org]/settings">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  const db = getDb();
  const kind = (await listMyOrgs(db, actor.userId)).find((o) => o.id === actor.orgId)?.kind;
  const canManage = can(actor.role, "org.manage");
  const [usage, events] = await Promise.all([
    can(actor.role, "billing.manage") ? usageSummary(db, actor) : Promise.resolve(null),
    canManage ? auditLog(db, actor, 30) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Home", href: `/app/${actor.orgSlug}` }, { label: "Settings" }]}
        title="Settings"
        description="Workspace name, plan and usage, activity, and deletion."
      />
      <Card className="p-6">
        <h2 className="text-lg font-semibold">General</h2>
        {canManage ? (
          <RenameWorkspace orgId={actor.orgId} name={actor.orgName} />
        ) : (
          <p className="mt-2 text-sm text-muted">
            {actor.orgName} · your role: <span className="capitalize">{actor.role}</span>. Only owners and admins can change settings.
          </p>
        )}
      </Card>

      {usage && (
        <Card className="p-6" corners="pitchline">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Plan & usage</h2>
            <Badge tone={usage.paidActive ? "gold" : "neutral"}>Plan: {usage.planId.replace("_", " ")}</Badge>
          </div>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            <Meter
              label="Analyses this month"
              used={usage.analyses.used + usage.analyses.inProgress}
              limit={usage.analyses.limit}
              extra={usage.analyses.inProgress ? `${usage.analyses.inProgress} in progress. Failed or cancelled analyses don't count.` : "Failed or cancelled analyses don't count."}
            />
            <Meter label="Members" used={usage.members.count} limit={usage.members.limit} />
            <div>
              <p className="text-sm text-muted">Stored footage</p>
              <p className="font-data mt-1 text-2xl">{(usage.storage.bytes / 1024 ** 3).toFixed(2)} GB</p>
              <p className="text-xs text-muted">
                {usage.storage.videos} video{usage.storage.videos === 1 ? "" : "s"}, each kept {usage.limits.retentionDays} days after upload.
              </p>
            </div>
          </div>
          <p className="mt-6 text-xs text-muted">
            Usage resets on the 1st of each month (UTC). Compare plans on the{" "}
            <Link href="/pricing" className="text-mindaro underline underline-offset-4">
              pricing page
            </Link>
            . Paid plans are not on sale yet.
          </p>
        </Card>
      )}

      {canManage && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold">Activity log</h2>
          {events.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No activity yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    {ACTION_LABEL[e.action] ?? e.action}
                    <span className="text-muted"> · {e.actorName ?? "System"}</span>
                  </span>
                  <time className="font-data text-xs text-muted" dateTime={e.createdAt.toISOString()}>
                    {e.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {kind !== "personal" && (
        <Card className="border-danger/40 p-6">
          <h2 className="text-lg font-semibold text-danger">Danger zone</h2>
          {can(actor.role, "org.delete") ? (
            <DeleteWorkspace orgId={actor.orgId} name={actor.orgName} />
          ) : (
            <p className="mt-2 text-sm text-muted">
              To leave this workspace, use <Link href={`/app/${actor.orgSlug}/members`} className="text-mindaro underline underline-offset-4">Members</Link>. Only owners can delete it.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
