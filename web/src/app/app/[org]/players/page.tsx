import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState, PageHeader } from "@/components/app-ui";
import { Chip, FormLine, PlayerAvatar, POSITION_LABEL, ScoreDial } from "@/components/player-ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { workspaceOverview } from "@/server/orgs/overview";
import { squad } from "@/server/players/service";
import { getStorage } from "@/server/storage/s3";
import { AddPlayerButton } from "./player-dialogs";

export const metadata: Metadata = { title: "Players" };

export default function PlayersPage({ params }: PageProps<"/app/[org]/players">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<div className="h-72 animate-pulse rounded-2xl bg-surface" aria-label="Loading players" />}>
        <Squad params={params} />
      </Suspense>
    </div>
  );
}

async function Squad({ params }: { params: PageProps<"/app/[org]/players">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  const db = getDb();
  const [rows, overview] = await Promise.all([squad(db, getStorage(), actor), workspaceOverview(db, actor)]);
  const base = `/app/${actor.orgSlug}`;
  const canManage = can(actor.role, "player.manage");
  const personal = overview.kind === "personal";
  const sorted = [...rows].sort(
    (a, b) => Number(b.player.userId === actor.userId) - Number(a.player.userId === actor.userId) || (b.totals.averageScore ?? -1) - (a.totals.averageScore ?? -1),
  );

  return (
    <div className="space-y-8">
      <PageHeader
        crumbs={[{ label: "Home", href: base }, { label: personal ? "Players" : "Squad" }]}
        title={personal ? "Players" : "Squad"}
        description={personal ? "Your profile, and any players you follow (for example your child)." : "Every player's profile, built from the matches they're linked to."}
        actions={canManage && <AddPlayerButton orgId={actor.orgId} orgSlug={actor.orgSlug} />}
      />
      {rows.length === 0 ? (
        <EmptyState title="No players yet" action={canManage ? <AddPlayerButton orgId={actor.orgId} orgSlug={actor.orgSlug} /> : undefined}>
          Add your players, then link each one to their tracked player in a match. Their profile builds up match after match.
        </EmptyState>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map(({ player, totals, form, photoUrl }) => (
            <li key={player.id}>
              <Link href={`${base}/players/${player.id}`} className="group block h-full rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-mindaro/60">
                <div className="flex items-start gap-4">
                  <PlayerAvatar name={player.name} photoUrl={photoUrl} className="h-20 w-16" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-lg font-semibold group-hover:text-mindaro">
                      {player.shirtNumber != null && <span className="font-data rounded bg-surface-2 px-1.5 text-sm">#{player.shirtNumber}</span>}
                      <span className="truncate">{player.name}</span>
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {player.userId === actor.userId && <Chip>You</Chip>}
                      {player.position && <Chip>{POSITION_LABEL[player.position]}</Chip>}
                    </div>
                  </div>
                  <ScoreDial score={totals.averageScore} size={60} />
                </div>
                <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Matches</dt>
                    <dd className="font-data">{totals.matches}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Top speed</dt>
                    <dd className="font-data">{totals.matches ? `${totals.topSpeedKmh} km/h` : "–"}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Form</dt>
                    <dd className="flex justify-center">
                      <FormLine scores={form} width={72} height={24} />
                    </dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
