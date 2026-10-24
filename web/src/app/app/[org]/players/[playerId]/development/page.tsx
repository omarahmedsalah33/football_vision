import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Icon, PageHeader } from "@/components/app-ui";
import { DrillCard } from "@/components/drill-ui";
import { ProfileTabs } from "@/components/player-ui";
import { Badge, Card, CornerMarks } from "@/components/ui";
import { CATEGORY_LABEL, DIMENSIONS, RATING_LABEL, type Category } from "@/lib/development/framework";
import type { ProgressStatus } from "@/lib/development/progress";
import { CONFIDENCE_TEXT, latestRatings, type Confidence } from "@/lib/development/recommend";
import { pageActor } from "@/server/auth/page";
import { getDb } from "@/server/db/client";
import { developmentView, library, todayUtc, type PlanView } from "@/server/development/service";
import { AppError, uuidParam } from "@/server/http/errors";
import { workspaceOverview } from "@/server/orgs/overview";
import { ClosePlanButton, CommentForm, DeleteLogButton, LogSessionButton, PlanBuilder, RateButton } from "./development-ui";

export const metadata: Metadata = { title: "Development" };

export default function DevelopmentPage({ params }: PageProps<"/app/[org]/players/[playerId]/development">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface" aria-label="Loading development" />}>
        <Development params={params} />
      </Suspense>
    </div>
  );
}

const STATUS: Record<ProgressStatus, { label: string; tone: "accent" | "lush" | "neutral" | "warning" | "info" }> = {
  reached: { label: "Target reached", tone: "accent" },
  improving: { label: "Improving", tone: "lush" },
  no_change: { label: "No clear change", tone: "neutral" },
  declined: { label: "Below baseline", tone: "warning" },
  early: { label: "Too early to judge", tone: "info" },
  waiting: { label: "Waiting for evidence", tone: "info" },
};
const CONFIDENCE_TONE: Record<Confidence, "accent" | "info" | "neutral"> = { strong: "accent", moderate: "info", limited: "neutral" };

function Meter({ label, value, max, tone = "mindaro" }: { label: string; value: number; max: number; tone?: "mindaro" | "gold" }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2.5 overflow-hidden rounded-full bg-bg">
      <div className={`h-full rounded-full ${tone === "gold" ? "bg-gold" : "bg-mindaro"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function SourceBadge({ kind }: { kind: "measured" | "observed" }) {
  return kind === "measured" ? <Badge tone="info">Measured from video</Badge> : <Badge tone="gold">Coach / self rating</Badge>;
}

async function Development({ params }: { params: PageProps<"/app/[org]/players/[playerId]/development">["params"] }) {
  const { org, playerId } = await params;
  const actor = await pageActor(org);
  const db = getDb();
  let view;
  try {
    view = await developmentView(db, actor, uuidParam(playerId, "Player"));
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const [lib, overview] = await Promise.all([library(db, actor), workspaceOverview(db, actor)]);
  const today = todayUtc();
  const base = `/app/${actor.orgSlug}`;
  const { player, access, activePlan } = view;
  const isMe = access.self;
  const you = isMe ? "you" : player.name.split(" ")[0];
  const atLimit = view.limits.activePlans >= view.limits.maxActivePlans;

  return (
    <div className="space-y-8">
      <PageHeader
        crumbs={[{ label: "Home", href: base }, { label: overview.kind === "personal" ? "Players" : "Squad", href: `${base}/players` }, { label: player.name, href: `${base}/players/${player.id}` }, { label: "Development" }]}
        title={isMe ? "My development" : `${player.name}`}
        description="What to work on, the evidence for it, the training to do, and whether it's working."
      />
      <ProfileTabs base={base} playerId={player.id} active="development" showDevelopment />

      {activePlan ? (
        <ActivePlan plan={activePlan} orgId={actor.orgId} today={today} canManage={access.canManage} canLog={access.canLog} self={isMe} />
      ) : (
        <section aria-labelledby="prio-h" className="space-y-5">
          <div className="fv-stripes relative overflow-hidden rounded-2xl border border-border bg-surface p-6 sm:p-8">
            <CornerMarks tone="mindaro" size={22} />
            <div className="relative flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-2xl">
                <p className="font-data text-xs uppercase tracking-[0.22em] text-mindaro">No active plan</p>
                <h2 id="prio-h" className="mt-2 font-display text-4xl font-extrabold uppercase italic leading-none">
                  Development priorities
                </h2>
                <p className="mt-3 text-sm text-muted">
                  Built from {view.matchesAnalysed} analysed {view.matchesAnalysed === 1 ? "match" : "matches"} and the ratings below. Each priority shows what we see, the evidence, possible reasons, drills that target it and how progress will be measured.
                </p>
              </div>
              {access.canManage &&
                (atLimit ? (
                  <p className="max-w-xs text-sm text-gold">
                    {view.limits.activePlans} of {view.limits.maxActivePlans} active {view.limits.maxActivePlans === 1 ? "plan" : "plans"} on {overview.planName}. Complete one or{" "}
                    <Link href="/pricing" className="underline underline-offset-4">
                      see plans
                    </Link>
                    .
                  </p>
                ) : (
                  (view.priorities.length > 0 || view.matchesAnalysed > 0 || view.observations.length > 0) && (
                    <PlanBuilder
                      orgId={actor.orgId}
                      playerId={player.id}
                      playerName={isMe ? "you" : player.name}
                      today={today}
                      library={lib}
                      measuredAvailable={view.matchesAnalysed > 0}
                      priorities={view.priorities.map((p) => ({ dimension: p.dimension, label: p.label, finding: p.finding, confidence: p.confidence, goal: p.goal }))}
                    />
                  )
                ))}
            </div>
          </div>

          {view.priorities.length === 0 ? (
            <Card className="p-6">
              <h3 className="font-semibold">Nothing stands out yet</h3>
              <p className="mt-1 text-sm text-muted">
                {view.matchesAnalysed === 0
                  ? `Link ${isMe ? "yourself" : "this player"} to a tracked player in an analysed match, or add a rating below, to find what to work on.`
                  : "No running number is low across matches and no area is rated low. You can still build a plan around something you choose."}
              </p>
              {view.matchesAnalysed === 0 && (
                <Link href={`${base}/matches`} className="mt-3 inline-flex items-center gap-1 text-sm text-mindaro underline-offset-4 hover:underline">
                  Go to matches <Icon name="arrow" className="h-4 w-4" />
                </Link>
              )}
            </Card>
          ) : (
            <ol className="grid gap-5 lg:grid-cols-2">
              {view.priorities.map((p, i) => (
                <li key={p.dimension}>
                  <Card className="h-full space-y-4 p-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-data text-xs text-muted">#{i + 1}</span>
                      <h3 className="text-lg font-semibold">{p.label}</h3>
                      <SourceBadge kind={p.source} />
                    </div>
                    <p className="text-sm">{p.finding}</p>
                    <p>
                      <Badge tone={CONFIDENCE_TONE[p.confidence]}>{CONFIDENCE_TEXT[p.confidence]}</Badge>
                    </p>
                    <details className="text-sm">
                      <summary className="cursor-pointer text-mindaro">Evidence ({p.evidence.length})</summary>
                      <ul className="mt-2 space-y-1 font-data text-xs text-fg/90">
                        {p.evidence.map((e) => (
                          <li key={e}>· {e}</li>
                        ))}
                      </ul>
                    </details>
                    <div className="text-sm">
                      <p className="font-medium">Possible reasons to check</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                        {p.causes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="text-sm">
                      <p className="font-medium">Drills that target it</p>
                      <p className="mt-1 text-muted">{p.drills.map((d) => d.title).join(" · ") || "No drill in the library yet."}</p>
                    </div>
                    <p className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm">
                      <span className="font-medium">How we&apos;ll measure it: </span>
                      {p.goal.text} Review after {p.reviewWeeks} weeks.
                    </p>
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <Ratings view={view} orgId={actor.orgId} today={today} />

      {view.pastPlans.length > 0 && (
        <section aria-labelledby="past-h" className="space-y-3">
          <h2 id="past-h" className="text-lg font-semibold">
            Earlier plans
          </h2>
          <ul className="space-y-3">
            {view.pastPlans.map((p) => (
              <li key={p.id}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{p.title}</p>
                    <span className="font-data text-xs text-muted">
                      {p.startsOn} → {p.reviewOn}
                    </span>
                  </div>
                  <ul className="mt-3 space-y-1 text-sm">
                    {p.objectives.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center gap-2">
                        <Badge tone={STATUS[o.progress.status].tone}>{STATUS[o.progress.status].label}</Badge>
                        <span>{o.label}:</span>
                        <span className="text-muted">{o.progress.text}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted">
                    Training: {p.training.done} of {p.training.planned} planned sessions, {p.training.minutes} min.
                  </p>
                  {p.closingNote && <p className="mt-2 text-sm">“{p.closingNote}”</p>}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="rounded-2xl border border-dashed border-border-strong p-5 text-sm">
        <summary className="cursor-pointer font-medium">How each area is judged, and what it can&apos;t tell {you}</summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {DIMENSIONS.map((d) => (
            <div key={d.key}>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {d.label} <SourceBadge kind={d.source} />
              </p>
              <p className="mt-1 text-muted">{d.meaning}</p>
              <p className="mt-1 text-xs">
                <span className="text-fg/80">How: </span>
                <span className="text-muted">{d.method}</span>
              </p>
              <p className="mt-0.5 text-xs">
                <span className="text-fg/80">Limits: </span>
                <span className="text-muted">{d.limitations}</span>
              </p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ActivePlan({ plan, orgId, today, canManage, canLog, self }: { plan: PlanView; orgId: string; today: string; canManage: boolean; canLog: boolean; self: boolean }) {
  const t = plan.training;
  const judged = plan.objectives.filter((o) => o.progress.status === "reached" || o.progress.status === "improving").length;
  const objectiveLabel = new Map(plan.objectives.map((o) => [o.id, o.label]));
  const drillTitle = new Map(plan.exercises.map((e) => [e.id, e.drill.title]));
  return (
    <section aria-labelledby="plan-h" className="space-y-6">
      <div className="fv-stripes relative overflow-hidden rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <CornerMarks tone="mindaro" size={22} />
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle, var(--lush), transparent 65%)" }} />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-data text-xs uppercase tracking-[0.22em] text-mindaro">Active plan</p>
            <h2 id="plan-h" className="mt-2 font-display text-4xl font-extrabold uppercase italic leading-none sm:text-5xl">
              {plan.title}
            </h2>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              <span className="font-data">
                Started {plan.startsOn} · review {plan.reviewOn}
              </span>
              {plan.reviewDue && <Badge tone="gold">Review due</Badge>}
            </p>
          </div>
          {canManage && <ClosePlanButton orgId={orgId} planId={plan.id} />}
        </div>
        <div className="relative mt-8 grid gap-6 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Training done</p>
            <p className="mt-1 font-display text-4xl font-bold">
              {t.done}
              <span className="text-xl text-muted"> / {t.planned} sessions</span>
            </p>
            <div className="mt-2">
              <Meter label="Sessions done against planned" value={t.done} max={t.planned} />
            </div>
            <p className="mt-2 text-xs text-muted">
              This week {t.thisWeekDone} of {t.thisWeekPlanned} · {t.minutes} min in total
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Measured change</p>
            <p className="mt-1 font-display text-4xl font-bold">
              {judged}
              <span className="text-xl text-muted">
                {" "}
                / {plan.objectives.length} {plan.objectives.length === 1 ? "objective" : "objectives"} improving
              </span>
            </p>
            <div className="mt-2">
              <Meter label="Objectives improving or reached" value={judged} max={plan.objectives.length} tone="gold" />
            </div>
            <p className="mt-2 text-xs text-muted">Checked against matches and ratings after the start, not against the training done.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {plan.objectives.map((o) => (
          <Card key={o.id} className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name="target" className="h-5 w-5 text-mindaro" />
              <h3 className="font-semibold">{o.label}</h3>
            </div>
            <SourceBadge kind={o.kind} />
            <p className="font-data text-lg">
              {o.baselineText} <span className="text-muted">→</span> <span className="text-mindaro">{o.targetText}</span>
            </p>
            <div>
              <Badge tone={STATUS[o.progress.status].tone}>{STATUS[o.progress.status].label}</Badge>
              <p className="mt-2 text-sm">{o.progress.text}</p>
              {o.progress.caveat && <p className="mt-1 text-xs text-gold">{o.progress.caveat}</p>}
            </div>
            <details className="mt-auto text-sm">
              <summary className="cursor-pointer text-mindaro">Why this objective</summary>
              <p className="mt-2 text-muted">{o.finding}</p>
              {o.evidence.length > 0 && (
                <ul className="mt-2 space-y-1 font-data text-xs">
                  {o.evidence.map((e) => (
                    <li key={e}>· {e}</li>
                  ))}
                </ul>
              )}
            </details>
          </Card>
        ))}
      </div>

      <section aria-labelledby="train-h" className="space-y-3">
        <h3 id="train-h" className="flex items-center gap-2 text-lg font-semibold">
          <Icon name="training" className="h-5 w-5 text-mindaro" />
          Training
        </h3>
        <ul className="space-y-3">
          {plan.exercises.map((e) => (
            <li key={e.id}>
              <DrillCard
                drill={e.drill}
                badge={
                  <Badge tone={e.thisWeek >= e.sessionsPerWeek ? "accent" : "neutral"}>
                    {e.thisWeek}/{e.sessionsPerWeek} this week
                  </Badge>
                }
                footer={
                  <>
                    <span className="text-xs text-muted">
                      For {e.objectiveId ? objectiveLabel.get(e.objectiveId) : "the plan"} · {e.done} of {e.planned} sessions so far
                    </span>
                    {canLog && <LogSessionButton orgId={orgId} planId={plan.id} exercise={{ id: e.id, title: e.drill.title, durationMinutes: e.drill.durationMinutes }} today={today} startsOn={plan.startsOn} />}
                  </>
                }
              />
            </li>
          ))}
        </ul>
        {plan.exercises.some((e) => e.drill.source === "starter") && (
          <p className="text-xs text-muted">Starter-library drills are common coaching exercises written up by Football Vision. Check them with a qualified coach for age, level and fitness.</p>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h3 className="text-lg font-semibold">Session log</h3>
          {plan.logs.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No sessions logged yet. {canLog ? "Use “Log session” after each drill." : ""}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {plan.logs.map((l) => (
                <li key={l.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{drillTitle.get(l.exerciseId)}</span>
                    <span className="font-data text-xs text-muted">
                      {l.doneOn} · {l.durationMinutes} min{l.effort != null ? ` · effort ${l.effort}/10` : ""}
                    </span>
                  </div>
                  {l.note && <p className="mt-1 text-muted">“{l.note}”</p>}
                  {(l.mine || canManage) && (
                    <div className="mt-1">
                      <DeleteLogButton orgId={orgId} planId={plan.id} logId={l.id} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="space-y-4 p-6">
          <h3 className="text-lg font-semibold">Feedback and reflections</h3>
          {plan.comments.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet. Coaches leave feedback here; players add their reflections.</p>
          ) : (
            <ul className="space-y-3">
              {plan.comments.map((c) => (
                <li key={c.id} className={`rounded-lg border p-3 text-sm ${c.authorKind === "coach" ? "border-cascade/40 bg-cascade/5" : "border-mindaro/30 bg-accent-soft"}`}>
                  <p className="flex items-center justify-between gap-2 text-xs text-muted">
                    <span className="font-medium text-fg/80">{c.authorKind === "coach" ? "Coach" : "Player"}{c.mine ? " (you)" : ""}</span>
                    <span className="font-data">{c.createdAt.slice(0, 10)}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-line">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          <CommentForm orgId={orgId} planId={plan.id} self={self} />
        </Card>
      </div>
    </section>
  );
}

function Ratings({ view, orgId, today }: { view: Awaited<ReturnType<typeof developmentView>>; orgId: string; today: string }) {
  const latest = latestRatings(view.observations);
  const canRate = view.access.self || view.access.canRateAsCoach;
  const byCategory = (["technical", "tactical", "defensive"] as Category[])
    .map((c) => ({ c, dims: DIMENSIONS.filter((d) => d.category === c && latest.has(d.key)) }))
    .filter((g) => g.dims.length);
  return (
    <section aria-labelledby="rate-h">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="rate-h" className="text-lg font-semibold">
              Ratings
            </h2>
            <p className="text-sm text-muted">For technical, tactical and defensive areas the video can&apos;t measure yet. Coach ratings and the player&apos;s own view are kept apart.</p>
          </div>
          {canRate && <RateButton orgId={orgId} playerId={view.player.id} self={view.access.self} today={today} />}
        </div>
        {byCategory.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No ratings yet.</p>
        ) : (
          <div className="mt-5 grid gap-6 md:grid-cols-3">
            {byCategory.map(({ c, dims }) => (
              <div key={c}>
                <p className="text-xs font-medium uppercase tracking-wider text-muted">{CATEGORY_LABEL[c]}</p>
                <ul className="mt-2 space-y-3">
                  {dims.map((d) => {
                    const r = latest.get(d.key)!;
                    return (
                      <li key={d.key} className="text-sm">
                        <p className="font-medium">{d.label}</p>
                        <p className="mt-0.5 flex flex-wrap gap-3 font-data text-xs">
                          {r.coach && (
                            <span title={RATING_LABEL[r.coach.rating]}>
                              Coach <span className="text-mindaro">{r.coach.rating}/5</span>
                            </span>
                          )}
                          {r.self && (
                            <span title={RATING_LABEL[r.self.rating]}>
                              Self <span className="text-gold">{r.self.rating}/5</span>
                            </span>
                          )}
                        </p>
                        {(r.coach?.note ?? r.self?.note) && <p className="mt-0.5 text-xs text-muted">“{r.coach?.note ?? r.self?.note}”</p>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}

