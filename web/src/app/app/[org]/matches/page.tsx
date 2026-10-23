import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MatchStatusBadge } from "@/components/match-status";
import { ButtonLink, Card } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { listMatches } from "@/server/matches/service";

export const metadata: Metadata = { title: "Matches" };

export default function MatchesPage({ params }: PageProps<"/app/[org]/matches">) {
  return (
    <div className="mx-auto max-w-5xl">
      <Suspense fallback={<ListSkeleton />}>
        <MatchList params={params} />
      </Suspense>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading matches" className="space-y-3">
      <div className="h-9 w-48 animate-pulse rounded bg-surface-2" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-surface" />
      ))}
    </div>
  );
}

async function MatchList({ params }: { params: PageProps<"/app/[org]/matches">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  const matches = await listMatches(getDb(), actor);
  const canCreate = can(actor.role, "match.create");

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold uppercase tracking-tight">Matches</h1>
          <p className="mt-1 text-sm text-muted">{actor.orgName}</p>
        </div>
        {canCreate && <ButtonLink href={`/app/${actor.orgSlug}/matches/new`}>New match</ButtonLink>}
      </div>

      {matches.length === 0 ? (
        <Card className="mt-8 p-10 text-center">
          <h2 className="text-lg font-semibold">No matches yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            {canCreate
              ? "Create a match and upload footage from a fixed, wide-angle camera that shows most of the pitch."
              : "Matches shared in this workspace will appear here."}
          </p>
          {canCreate && (
            <ButtonLink href={`/app/${actor.orgSlug}/matches/new`} className="mt-6">
              Create your first match
            </ButtonLink>
          )}
        </Card>
      ) : (
        <ul className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {matches.map((m) => (
            <li key={m.id}>
              <Link
                href={`/app/${actor.orgSlug}/matches/${m.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-surface-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{m.title}</p>
                  <p className="text-sm text-muted">
                    {[m.opponentName && `vs ${m.opponentName}`, m.playedOn].filter(Boolean).join(" · ") || "No details"}
                  </p>
                </div>
                <MatchStatusBadge status={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
