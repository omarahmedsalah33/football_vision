import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState, Icon, IN_PROGRESS, MatchThumb, NEEDS_ACTION, NextActionLink, PageHeader, Pipeline } from "@/components/app-ui";
import { MatchStatusBadge } from "@/components/match-status";
import { ButtonLink } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { listMatches, matchThumbnails } from "@/server/matches/service";
import { getStorage } from "@/server/storage/s3";

export const metadata: Metadata = { title: "Matches" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "action", label: "Needs your step" },
  { key: "running", label: "Processing" },
  { key: "analysed", label: "Analysed" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

export default function MatchesPage({ params, searchParams }: PageProps<"/app/[org]/matches">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<ListSkeleton />}>
        <MatchList params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading matches" className="space-y-6">
      <div className="h-12 w-64 animate-pulse rounded bg-surface-2" />
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-72 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
    </div>
  );
}

async function MatchList({ params, searchParams }: { params: PageProps<"/app/[org]/matches">["params"]; searchParams: PageProps<"/app/[org]/matches">["searchParams"] }) {
  const [{ org }, query] = await Promise.all([params, searchParams]);
  const actor = await pageActor(org);
  const db = getDb();
  const all = await listMatches(db, actor);
  const canCreate = can(actor.role, "match.create");
  const canAct = can(actor.role, "analysis.run");
  const base = `/app/${actor.orgSlug}`;

  const show: Filter = FILTERS.some((f) => f.key === query.show) ? (query.show as Filter) : "all";
  const pick: Record<Filter, (s: (typeof all)[number]["status"]) => boolean> = {
    all: () => true,
    action: (s) => NEEDS_ACTION.includes(s),
    running: (s) => IN_PROGRESS.includes(s),
    analysed: (s) => s === "analyzed",
  };
  const matches = all.filter((m) => pick[show](m.status));
  const thumbs = await matchThumbnails(db, getStorage(), actor, matches.map((m) => m.id));

  return (
    <div className="space-y-8">
      <PageHeader
        crumbs={[{ label: "Home", href: base }, { label: "Matches" }]}
        title="Matches"
        description={`${all.length} ${all.length === 1 ? "match" : "matches"} in ${actor.orgName}`}
        actions={
          canCreate && (
            <ButtonLink href={`${base}/matches/new`}>
              <Icon name="plus" className="h-4 w-4" />
              New match
            </ButtonLink>
          )
        }
      />

      {all.length === 0 ? (
        <EmptyState
          title="No matches yet"
          action={
            canCreate ? (
              <ButtonLink href={`${base}/matches/new`} className="px-6">
                Create your first match
              </ButtonLink>
            ) : undefined
          }
        >
          {canCreate
            ? "Create a match and upload footage from a fixed, wide-angle camera that shows most of the pitch."
            : "Matches shared in this workspace will appear here."}
        </EmptyState>
      ) : (
        <>
          <nav aria-label="Filter matches" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => {
              const n = all.filter((m) => pick[f.key](m.status)).length;
              const active = f.key === show;
              return (
                <Link
                  key={f.key}
                  href={f.key === "all" ? `${base}/matches` : `${base}/matches?show=${f.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                    active ? "border-mindaro bg-accent-soft text-mindaro" : "border-border text-muted hover:border-border-strong hover:text-fg"
                  }`}
                >
                  {f.label}
                  <span className="font-data text-xs opacity-80">{n}</span>
                </Link>
              );
            })}
          </nav>

          {matches.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border-strong p-8 text-center text-sm text-muted">Nothing here right now.</p>
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {matches.map((m) => {
                const href = `${base}/matches/${m.id}`;
                return (
                  <li key={m.id} className="group flex flex-col overflow-hidden rounded-xl border border-border bg-surface transition-colors hover:border-mindaro/50">
                    <Link href={href} className="relative block" aria-label={`Open ${m.title}`}>
                      <MatchThumb url={thumbs[m.id]} title={m.title} />
                      <span className="absolute left-3 top-3">
                        <MatchStatusBadge status={m.status} />
                      </span>
                    </Link>
                    <div className="flex flex-1 flex-col gap-4 p-4">
                      <div className="min-w-0">
                        <Link href={href} className="block truncate text-lg font-semibold group-hover:text-mindaro">
                          {m.title}
                        </Link>
                        <p className="truncate text-sm text-muted">
                          {[m.opponentName && `vs ${m.opponentName}`, m.playedOn].filter(Boolean).join(" · ") || `Added ${m.createdAt.toISOString().slice(0, 10)}`}
                        </p>
                      </div>
                      <Pipeline status={m.status} compact />
                      <div className="mt-auto">
                        <NextActionLink status={m.status} matchHref={href} canAct={canAct} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
