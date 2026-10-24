"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Icon } from "@/components/app-ui";
import { Button } from "@/components/ui";
import { CATEGORY_LABEL, DIMENSIONS, METRICS, RATING_LABEL, dimensionByKey, type Category } from "@/lib/development/framework";
import { DIFFICULTY_LABEL, drillsFor, type Drill } from "@/lib/development/drills";
import type { Confidence, Goal } from "@/lib/development/recommend";
import { apiPost, apiRequest, ApiError } from "@/lib/api-client";
import { Dialog } from "../../player-dialogs";

const field = "mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-fg";

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Plan builder

export type BuilderPriority = { dimension: string; label: string; finding: string; confidence: Confidence; goal: Goal };

type Pick = { dimension: string; target: string; drills: Record<string, number> };

function defaultPick(p: BuilderPriority | undefined, dimension: string, library: Drill[]): Pick {
  const target = p ? String(p.goal.target) : dimensionByKey.get(dimension)?.source === "observed" ? "3" : "";
  // Two sessions of the main drill, one of the second: a load that fits around team training.
  const drills = Object.fromEntries(drillsFor(dimension, library, 2).map((d, i) => [d.key, i === 0 && d.difficulty !== "advanced" ? 2 : 1]));
  return { dimension, target, drills };
}

export function PlanBuilder({ orgId, playerId, playerName, priorities, library, today, measuredAvailable, label = "Build a plan" }: { orgId: string; playerId: string; playerName: string; priorities: BuilderPriority[]; library: Drill[]; today: string; measuredAvailable: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<Pick[]>(() => priorities.slice(0, 2).map((p) => defaultPick(p, p.dimension, library)));
  const [reviewOn, setReviewOn] = useState(addDays(today, 28));
  const [extra, setExtra] = useState("");
  const { busy, error, run } = useSubmit();

  const byDim = new Map(priorities.map((p) => [p.dimension, p]));
  const others = DIMENSIONS.filter((d) => !byDim.has(d.key) && !picks.some((p) => p.dimension === d.key) && (d.source === "observed" || measuredAvailable));
  const toggle = (dimension: string) =>
    setPicks((cur) => (cur.some((p) => p.dimension === dimension) ? cur.filter((p) => p.dimension !== dimension) : cur.length >= 3 ? cur : [...cur, defaultPick(byDim.get(dimension), dimension, library)]));
  const update = (dimension: string, fn: (p: Pick) => Pick) => setPicks((cur) => cur.map((p) => (p.dimension === dimension ? fn(p) : p)));

  const libByKey = useMemo(() => new Map(library.map((d) => [d.key, d])), [library]);
  const weekly = picks.flatMap((p) => Object.entries(p.drills)).reduce((s, [key, n]) => ({ sessions: s.sessions + n, minutes: s.minutes + n * (libByKey.get(key)?.durationMinutes ?? 0) }), { sessions: 0, minutes: 0 });
  const drillCount = picks.reduce((s, p) => s + Object.keys(p.drills).length, 0);

  function submit() {
    void run(
      () =>
        apiPost(`/api/orgs/${orgId}/players/${playerId}/plans`, {
          reviewOn,
          objectives: picks.map((p) => ({ dimension: p.dimension, target: p.target.trim() === "" ? null : Number(p.target) })),
          exercises: picks.flatMap((p) => Object.entries(p.drills).map(([drillKey, sessionsPerWeek]) => ({ drillKey, dimension: p.dimension, sessionsPerWeek }))),
        }),
      () => setOpen(false),
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon name="target" className="h-4 w-4" />
        {label}
      </Button>
      <Dialog title={`Plan for ${playerName}`} open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset>
            <legend className="font-semibold">1 · What to work on <span className="font-normal text-muted">(up to 3)</span></legend>
            <p className="text-xs text-muted">A short list works better than a long one.</p>
            <div className="mt-3 space-y-2">
              {priorities.map((p) => (
                <label key={p.dimension} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${picks.some((x) => x.dimension === p.dimension) ? "border-mindaro bg-accent-soft" : "border-border"}`}>
                  <input type="checkbox" className="mt-1 accent-[var(--mindaro)]" checked={picks.some((x) => x.dimension === p.dimension)} onChange={() => toggle(p.dimension)} />
                  <span>
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-xs text-muted">{p.finding}</span>
                  </span>
                </label>
              ))}
              {picks
                .filter((p) => !byDim.has(p.dimension))
                .map((p) => (
                  <label key={p.dimension} className="flex cursor-pointer gap-3 rounded-lg border border-mindaro bg-accent-soft p-3">
                    <input type="checkbox" className="mt-1 accent-[var(--mindaro)]" checked onChange={() => toggle(p.dimension)} />
                    <span className="font-medium">{dimensionByKey.get(p.dimension)?.label}</span>
                  </label>
                ))}
            </div>
            {picks.length < 3 && others.length > 0 && (
              <label className="mt-3 block text-sm">
                <span className="text-muted">Something else</span>
                <select
                  className={field}
                  value={extra}
                  onChange={(e) => {
                    if (e.target.value) toggle(e.target.value);
                    setExtra("");
                  }}
                >
                  <option value="">Add another area…</option>
                  {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                    <optgroup key={c} label={CATEGORY_LABEL[c]}>
                      {others
                        .filter((d) => d.category === c)
                        .map((d) => (
                          <option key={d.key} value={d.key}>
                            {d.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}
          </fieldset>

          {picks.map((p, i) => {
            const d = dimensionByKey.get(p.dimension)!;
            const pr = byDim.get(p.dimension);
            const candidates = drillsFor(p.dimension, library, 6);
            return (
              <fieldset key={p.dimension} className="rounded-xl border border-border p-4">
                <legend className="px-1 font-semibold">
                  {i + 2} · {d.label}
                </legend>
                {d.source === "measured" ? (
                  <label className="block text-sm">
                    Target: {METRICS[d.metric!].label} <span className="text-muted">({METRICS[d.metric!].unit})</span>
                    <input className={`font-data ${field}`} inputMode="decimal" value={p.target} onChange={(e) => update(p.dimension, (x) => ({ ...x, target: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="Suggested automatically" />
                    {pr?.goal.kind === "measured" && <span className="mt-1 block text-xs text-muted">Baseline {pr.goal.baseline} {METRICS[d.metric!].unit}. Suggested: {pr.goal.target}.</span>}
                  </label>
                ) : (
                  <label className="block text-sm">
                    Target coach rating
                    <select className={field} value={p.target} onChange={(e) => update(p.dimension, (x) => ({ ...x, target: e.target.value }))}>
                      {[2, 3, 4, 5]
                        .filter((r) => pr?.goal.kind !== "observed" || r > pr.goal.baseline)
                        .map((r) => (
                          <option key={r} value={r}>
                            {r}/5 · {RATING_LABEL[r]}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <p className="mt-4 text-sm font-medium">Drills and sessions per week</p>
                <ul className="mt-2 space-y-2">
                  {candidates.map((drill) => {
                    const on = drill.key in p.drills;
                    return (
                      <li key={drill.key} className="flex flex-wrap items-center gap-3 text-sm">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            className="accent-[var(--mindaro)]"
                            checked={on}
                            onChange={() =>
                              update(p.dimension, (x) => {
                                const drills = { ...x.drills };
                                if (on) delete drills[drill.key];
                                else drills[drill.key] = 2;
                                return { ...x, drills };
                              })
                            }
                          />
                          <span className="truncate">{drill.title}</span>
                          <span className="shrink-0 text-xs text-muted">
                            {DIFFICULTY_LABEL[drill.difficulty]} · {drill.durationMinutes} min
                          </span>
                        </label>
                        {on && (
                          <select aria-label={`Sessions per week: ${drill.title}`} className="rounded-lg border border-border-strong bg-bg px-2 py-1 font-data text-sm" value={p.drills[drill.key]} onChange={(e) => update(p.dimension, (x) => ({ ...x, drills: { ...x.drills, [drill.key]: Number(e.target.value) } }))}>
                            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                              <option key={n} value={n}>
                                {n}× / week
                              </option>
                            ))}
                          </select>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}

          <label className="block text-sm font-medium">
            Review on
            <input type="date" className={`font-data ${field}`} value={reviewOn} min={addDays(today, 7)} max={addDays(today, 120)} onChange={(e) => setReviewOn(e.target.value)} required />
            <span className="mt-1 block text-xs font-normal text-muted">Four weeks is a good first block. Analyse at least two matches before the review.</span>
          </label>

          <p className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm">
            <span className="font-data">{weekly.sessions}</span> sessions a week, about <span className="font-data">{weekly.minutes}</span> minutes.
            {weekly.sessions > 8 && <span className="block text-gold">That&apos;s a heavy week on top of team training. Leave rest days.</span>}
          </p>
          <p className="text-xs text-muted">Drills come from the training library and should be checked by a qualified coach for the player&apos;s age, level and fitness. A plan doesn&apos;t guarantee a result; progress is checked against the next matches.</p>
          <ErrorText error={error} />
          <Button type="submit" disabled={busy || picks.length === 0 || drillCount === 0}>
            {busy ? "Creating…" : "Start the plan"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Training log

export function LogSessionButton({ orgId, planId, exercise, today, startsOn }: { orgId: string; planId: string; exercise: { id: string; title: string; durationMinutes: number }; today: string; startsOn: string }) {
  const [open, setOpen] = useState(false);
  const [doneOn, setDoneOn] = useState(today);
  const [minutes, setMinutes] = useState(String(exercise.durationMinutes));
  const [effort, setEffort] = useState(6);
  const [note, setNote] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} aria-label={`Log session: ${exercise.title}`}>
        <Icon name="check" className="h-4 w-4" />
        Log session
      </Button>
      <Dialog title="Log a session" open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => apiPost(`/api/orgs/${orgId}/plans/${planId}/logs`, { exerciseId: exercise.id, doneOn, durationMinutes: Number(minutes), effort, note: note.trim() || null }),
              () => {
                setOpen(false);
                setNote("");
              },
            );
          }}
        >
          <p className="font-medium">{exercise.title}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Day
              <input type="date" className={`font-data ${field}`} value={doneOn} min={startsOn} max={today} onChange={(e) => setDoneOn(e.target.value)} required />
            </label>
            <label className="block text-sm font-medium">
              Minutes
              <input className={`font-data ${field}`} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, "").slice(0, 3))} required />
            </label>
          </div>
          <label className="block text-sm font-medium">
            How hard did it feel? <span className="font-data text-mindaro">{effort}/10</span>
            <input type="range" min={1} max={10} value={effort} onChange={(e) => setEffort(Number(e.target.value))} className="mt-2 w-full accent-[var(--mindaro)]" />
            <span className="flex justify-between text-xs font-normal text-muted">
              <span>Very easy</span>
              <span>Maximal</span>
            </span>
          </label>
          <label className="block text-sm font-medium">
            How did it go? <span className="font-normal text-muted">(optional)</span>
            <textarea className={field} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Last two sprints were slower; left foot passes better than last week." />
          </label>
          <ErrorText error={error} />
          <Button type="submit" disabled={busy || !minutes}>
            {busy ? "Saving…" : "Save session"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}

export function DeleteLogButton({ orgId, planId, logId }: { orgId: string; planId: string; logId: string }) {
  const { busy, error, run } = useSubmit();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} className="text-xs text-muted underline underline-offset-4 hover:text-danger" onClick={() => void run(() => apiRequest("DELETE", `/api/orgs/${orgId}/plans/${planId}/logs/${logId}`))}>
        Remove
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Comments

export function CommentForm({ orgId, planId, self }: { orgId: string; planId: string; self: boolean }) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => apiPost(`/api/orgs/${orgId}/plans/${planId}/comments`, { body }), () => setBody(""));
      }}
    >
      <label className="block text-sm font-medium">
        {self ? "Add a reflection" : "Add feedback for the player"}
        <textarea className={field} rows={2} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={self ? "What went well, what felt hard?" : "What you saw and what to focus on next."} />
      </label>
      <ErrorText error={error} />
      <Button type="submit" variant="secondary" disabled={busy || !body.trim()}>
        <Icon name="chat" className="h-4 w-4" />
        {busy ? "Posting…" : "Post"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Ratings

export function RateButton({ orgId, playerId, self, today }: { orgId: string; playerId: string; self: boolean; today: string }) {
  const [open, setOpen] = useState(false);
  const [dimension, setDimension] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const { busy, error, run } = useSubmit();
  const observed = DIMENSIONS.filter((d) => d.source === "observed");
  const chosen = dimensionByKey.get(dimension);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icon name="edit" className="h-4 w-4" />
        {self ? "Rate yourself" : "Add a coach rating"}
      </Button>
      <Dialog title={self ? "Rate yourself" : "Coach rating"} open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => apiPost(`/api/orgs/${orgId}/players/${playerId}/observations`, { dimension, rating, note: note.trim() || null, observedOn: today }),
              () => {
                setOpen(false);
                setRating(null);
                setNote("");
              },
            );
          }}
        >
          <p className="text-sm text-muted">
            For things the video can&apos;t measure yet. {self ? "Your own view is shown as a self rating, separate from coach ratings." : "Ratings are opinions and are always shown as coach ratings, never as measurements."}
          </p>
          <label className="block text-sm font-medium">
            Area
            <select className={field} value={dimension} onChange={(e) => setDimension(e.target.value)} required>
              <option value="">Choose…</option>
              {(["technical", "tactical", "defensive"] as Category[]).map((c) => (
                <optgroup key={c} label={CATEGORY_LABEL[c]}>
                  {observed
                    .filter((d) => d.category === c)
                    .map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {chosen && <span className="mt-1 block text-xs font-normal text-muted">{chosen.meaning}</span>}
          </label>
          <fieldset>
            <legend className="text-sm font-medium">Rating</legend>
            <div role="radiogroup" aria-label="Rating" className="mt-2 grid gap-2 sm:grid-cols-5">
              {[1, 2, 3, 4, 5].map((r) => (
                <button key={r} type="button" role="radio" aria-checked={rating === r} onClick={() => setRating(r)} className={`rounded-lg border px-2 py-2 text-left text-xs transition-colors ${rating === r ? "border-mindaro bg-accent-soft" : "border-border hover:border-border-strong"}`}>
                  <span className="block font-data text-lg text-fg">{r}</span>
                  <span className="text-muted">{RATING_LABEL[r]}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium">
            What did you see? <span className="font-normal text-muted">(optional)</span>
            <textarea className={field} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Receives facing his own goal; rarely checks his shoulder." />
          </label>
          <ErrorText error={error} />
          <Button type="submit" disabled={busy || !dimension || rating == null}>
            {busy ? "Saving…" : "Save rating"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Closing a plan

export function ClosePlanButton({ orgId, planId }: { orgId: string; planId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useSubmit();
  const close = (status: "completed" | "archived") => void run(() => apiRequest("PATCH", `/api/orgs/${orgId}/plans/${planId}`, { status, closingNote: note.trim() || null }), () => setOpen(false));
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icon name="check" className="h-4 w-4" />
        Review and close
      </Button>
      <Dialog title="Close this plan" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <p className="text-sm text-muted">Closing keeps the plan, its sessions and its results in the player&apos;s history. You can then start the next plan.</p>
          <label className="block text-sm font-medium">
            Review summary <span className="font-normal text-muted">(optional)</span>
            <textarea className={field} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed, what to carry into the next plan." />
          </label>
          <ErrorText error={error} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => close("completed")}>
              Mark as completed
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => close("archived")}>
              Stop without completing
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
