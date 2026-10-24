import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState, Icon, IN_PROGRESS, MatchThumb, NEEDS_ACTION, NextActionLink, Pipeline, StatTile } from "@/components/app-ui";
import { MatchStatusBadge } from "@/components/match-status";
import { ButtonLink, CornerMarks } from "@/components/ui";
import { pageActor, pageUser } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { listMatches, matchThumbnails } from "@/server/matches/service";
import { workspaceOverview } from "@/server/orgs/overview";
import { getStorage } from "@/server/storage/s3";

export const metadata: Metadata = { title: "Home" };

export default function OrgHome({ params }: PageProps<"/app/[org]">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<HomeSkeleton />}>
        <Home params={params} />
      </Suspense>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your workspace" className="space-y-6">
      <div className="h-48 animate-pulse rounded-2xl bg-surface" />
      <div className="grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
    </div>
  );
}

function firstName(displayName: string | null, email: string | null) {
  const n = displayName?.trim().split(/\s+/)[0];
  if (n) return n;
  return email?.split("@")[0] ?? null;
}

async function Home({ params }: { params: PageProps<"/app/[org]">["params"] }) {
  const { org } = await params;
  const [actor, user] = await Promise.all([pageActor(org), pageUser()]);
  const db = getDb();
  const [matches, overview] = await Promise.all([listMatches(db, actor), workspaceOverview(db, actor)]);
  const base = `/app/${actor.orgSlug}`;
  const canCreate = can(actor.role, "match.create");
  const canAct = can(actor.role, "analysis.run");

  const analysed = matches.filter((m) => m.status === "analyzed");
  const attention = matches.filter((m) => NEEDS_ACTION.includes(m.status));
  const running = matches.filter((m) => IN_PROGRESS.includes(m.status));
  const recent = analysed.slice(0, 3);
  const thumbs = await matchThumbnails(db, getStorage(), actor, [...attention.slice(0, 5), ...running, ...recent].map((m) => m.id));
  const name = firstName(user.displayName, user.email);
  const a = overview.analyses;

  const steps = [
    { done: matches.length > 0, label: "Create a match", href: `${base}/matches/new` },
    { done: matches.some((m) => !["awaiting_upload", "uploading", "upload_rejected"].includes(m.status)), label: "Upload the footage", href: matches[0] ? `${base}/matches/${matches[0].id}` : undefined },
    { done: matches.some((m) => ["ready", "queued", "processing", "analyzed", "failed", "cancelled"].includes(m.status)), label: "Calibrate the pitch", href: matches[0] ? `${base}/matches/${matches[0].id}/calibrate` : undefined },
    { done: analysed.length > 0, label: "Run your first analysis", href: matches[0] ? `${base}/matches/${matches[0].id}` : undefined },
    ...(overview.kind === "club" ? [{ done: overview.members.count > 1, label: "Invite your staff", href: `${base}/members` }] : []),
  ];
  const showChecklist = canCreate && steps.some((s) => !s.done);
  const nextStep = steps.findIndex((s) => !s.done);

  return (
    <div className="space-y-10">
      {/* Welcome */}
      <section className="fv-stripes relative overflow-hidden rounded-2xl border border-border bg-surface px-6 py-8 sm:px-10 sm:py-10">
        <CornerMarks tone="mindaro" size={22} />
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle, var(--lush), transparent 65%)" }} />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="font-data text-xs uppercase tracking-[0.22em] text-mindaro">Train. Measure. Perform. Discover.</p>
            <h1 className="mt-3 font-display text-5xl font-extrabold uppercase italic leading-[0.9] tracking-tight sm:text-6xl">
              {name ? (
                <>
                  Welcome back, <span className="text-mindaro">{name}</span>
                </>
              ) : (
                "Welcome back"
              )}
            </h1>
            <p className="mt-3 max-w-xl text-muted">
              {attention.length > 0
                ? `${attention.length} ${attention.length === 1 ? "match needs" : "matches need"} your next step.`
                : running.length > 0
                  ? `${running.length} ${running.length === 1 ? "match is" : "matches are"} being processed right now.`
                  : matches.length > 0
                    ? "You're all caught up. Bring your next match."
                    : "Turn your next match into evidence you can check."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canCreate && (
              <ButtonLink href={`${base}/matches/new`} className="px-5">
                <Icon name="plus" className="h-4 w-4" />
                New match
              </ButtonLink>
            )}
            <ButtonLink href={`${base}/matches`} variant="secondary" className="px-5">
              All matches
            </ButtonLink>
          </div>
        </div>
      </section>

      {/* Numbers */}
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Matches" value={matches.length} note={`${analysed.length} analysed`} />
        <StatTile label="Need your step" value={attention.length} tone={attention.length ? "gold" : "fg"} note={attention.length ? "See below" : "Nothing waiting"} />
        <StatTile label="Processing" value={running.length} tone="fg" note={running.length ? "Updates live on the match page" : "Nothing running"} />
        <StatTile
          label="Analyses this month"
          value={
            <>
              {a.used + a.inProgress}
              <span className="text-lg text-muted"> / {a.unlimited ? "∞" : a.limit}</span>
            </>
          }
          tone="fg"
          note={overview.planName}
        />
      </dl>

      {matches.length === 0 ? (
        <EmptyState
          title="Your first match starts here"
          action={
            canCreate ? (
              <ButtonLink href={`${base}/matches/new`} className="px-6">
                Create your first match
              </ButtonLink>
            ) : undefined
          }
        >
          {canCreate
            ? "Film from a fixed, raised camera that sees the whole pitch, upload it, mark the pitch once, and get team shape, positions and heatmaps in metres."
            : "Matches shared in this workspace will appear here."}
        </EmptyState>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-8">
            {/* Needs your attention */}
            {attention.length > 0 && (
              <section aria-labelledby="attention-heading">
                <h2 id="attention-heading" className="flex items-center gap-2 font-display text-2xl font-bold uppercase">
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-gold" />
                  Needs your step
                </h2>
                <ul className="mt-4 space-y-3">
                  {attention.slice(0, 5).map((m) => (
                    <MatchRow key={m.id} match={m} href={`${base}/matches/${m.id}`} thumb={thumbs[m.id]} canAct={canAct} />
                  ))}
                </ul>
                {attention.length > 5 && (
                  <Link href={`${base}/matches?show=action`} className="mt-3 inline-block text-sm text-mindaro underline underline-offset-4">
                    See all {attention.length}
                  </Link>
                )}
              </section>
            )}

            {running.length > 0 && (
              <section aria-labelledby="running-heading">
                <h2 id="running-heading" className="flex items-center gap-2 font-display text-2xl font-bold uppercase">
                  <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-mindaro motion-reduce:animate-none" />
                  Processing now
                </h2>
                <ul className="mt-4 space-y-3">
                  {running.map((m) => (
                    <MatchRow key={m.id} match={m} href={`${base}/matches/${m.id}`} thumb={thumbs[m.id]} canAct={canAct} />
                  ))}
                </ul>
              </section>
            )}

            {recent.length > 0 && (
              <section aria-labelledby="recent-heading">
                <div className="flex items-end justify-between gap-3">
                  <h2 id="recent-heading" className="font-display text-2xl font-bold uppercase">
                    Latest results
                  </h2>
                  <Link href={`${base}/matches?show=analysed`} className="text-sm text-mindaro underline underline-offset-4">
                    All results
                  </Link>
                </div>
                <ul className="mt-4 grid gap-4 sm:grid-cols-3">
                  {recent.map((m) => (
                    <li key={m.id}>
                      <Link href={`${base}/matches/${m.id}`} className="group block overflow-hidden rounded-xl border border-border bg-surface transition-colors hover:border-mindaro/60">
                        <MatchThumb url={thumbs[m.id]} title={m.title} />
                        <div className="p-3">
                          <p className="truncate font-semibold group-hover:text-mindaro">{m.title}</p>
                          <p className="truncate text-xs text-muted">{[m.opponentName && `vs ${m.opponentName}`, m.playedOn].filter(Boolean).join(" · ") || "Analysed"}</p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <aside className="space-y-6">
            {showChecklist && (
              <section aria-labelledby="start-heading" className="relative rounded-2xl border border-border bg-surface p-5">
                <CornerMarks tone="pitchline" size={16} />
                <h2 id="start-heading" className="font-display text-xl font-bold uppercase">
                  Getting started
                </h2>
                <p className="mt-1 text-xs text-muted">
                  {steps.filter((s) => s.done).length} of {steps.length} done
                </p>
                <ol className="mt-4 space-y-2">
                  {steps.map((s, i) => (
                    <li key={s.label} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${i === nextStep ? "bg-accent-soft" : ""}`}>
                      <span
                        aria-hidden="true"
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-bold ${s.done ? "border-mindaro bg-mindaro text-accent-fg" : i === nextStep ? "border-mindaro text-mindaro" : "border-pitchline text-muted"}`}
                      >
                        {s.done ? <Icon name="check" className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      {i === nextStep && s.href ? (
                        <Link href={s.href} className="flex-1 text-sm font-medium text-mindaro underline-offset-4 hover:underline">
                          {s.label}
                        </Link>
                      ) : (
                        <span className={`flex-1 text-sm ${s.done ? "text-muted line-through decoration-pitchline" : ""}`}>{s.label}</span>
                      )}
                      <span className="sr-only">{s.done ? "(done)" : "(to do)"}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section aria-labelledby="tips-heading" className="rounded-2xl border border-border bg-surface p-5">
              <h2 id="tips-heading" className="font-display text-xl font-bold uppercase">
                Better footage, better numbers
              </h2>
              <ul className="mt-3 space-y-2.5 text-sm text-muted">
                {[
                  "Film from high up, near the halfway line.",
                  "Keep the whole pitch in view and the camera still.",
                  "1080p at 25 fps or more; floodlights on for evening games.",
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <Icon name="check" className="mt-0.5 h-4 w-4 text-mindaro" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link href="/docs#filming" className="mt-4 inline-flex items-center gap-1.5 text-sm text-mindaro underline-offset-4 hover:underline">
                Read the filming guide
                <Icon name="arrow" className="h-4 w-4" />
              </Link>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

function MatchRow({
  match,
  href,
  thumb,
  canAct,
}: {
  match: Awaited<ReturnType<typeof listMatches>>[number];
  href: string;
  thumb?: string;
  canAct: boolean;
}) {
  return (
    <li className="flex items-center gap-4 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong">
      <Link href={href} className="w-28 shrink-0 overflow-hidden rounded-lg sm:w-36" tabIndex={-1} aria-hidden="true">
        <MatchThumb url={thumb} title={match.title} />
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href} className="truncate font-semibold hover:text-mindaro">
            {match.title}
          </Link>
          <MatchStatusBadge status={match.status} />
        </div>
        <div className="max-w-xs">
          <Pipeline status={match.status} compact />
        </div>
      </div>
      <div className="hidden shrink-0 sm:block">
        <NextActionLink status={match.status} matchHref={href} canAct={canAct} />
      </div>
    </li>
  );
}
