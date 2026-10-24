"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Pitch } from "@/components/pitch";
import { Badge, Button, Card } from "@/components/ui";
import type { Component, PlayerReport } from "@/lib/analysis/player-report";
import { apiRequest, ApiError } from "@/lib/api-client";

export type PlayerView = PlayerReport & {
  photoUrl: string | null;
  name: string | null;
  shirtNumber: number | null;
  distanceM: number;
  topSpeedKmh: number;
  sprints: number;
  heatmap: number[][];
};

const TEAM = { a: { name: "Team A", color: "var(--mindaro)" }, b: { name: "Team B", color: "var(--gold)" }, other: { name: "Other", color: "var(--cascade)" } } as const;

function displayName(p: PlayerView) {
  return p.name ?? `Player ${p.trackNo}`;
}

function ScoreRing({ score, size = 64 }: { score: number | null; size?: number }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const v = score ?? 0;
  const colour = score == null ? "var(--pitchline)" : v >= 70 ? "var(--mindaro)" : v >= 40 ? "var(--gold)" : "var(--cascade)";
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-label={score == null ? "Not scored" : `Score ${score} out of 100`} role="img">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--pitchline)" strokeWidth="5" />
        {score != null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />}
      </svg>
      <span className="font-data absolute text-lg font-bold" style={{ fontSize: size / 3.4 }}>
        {score ?? "–"}
      </span>
    </span>
  );
}

function Photo({ p, className }: { p: PlayerView; className: string }) {
  return p.photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
    <img src={p.photoUrl} alt={`Photo of ${displayName(p)}`} className={`${className} bg-bg object-contain`} />
  ) : (
    <span className={`${className} grid place-items-center bg-bg text-cascade/50`} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-1/2 w-1/2" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="7.5" r="3.5" />
        <path d="M5 21c.8-4 3.6-6.5 7-6.5s6.2 2.5 7 6.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function ComponentBar({ c }: { c: Component }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{c.label}</span>
        <span className="font-data text-muted">{c.display}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg" role="meter" aria-label={`${c.label} compared with this match`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.percentile ?? undefined}>
          {c.percentile != null && <div className="h-full rounded-full bg-mindaro" style={{ width: `${Math.max(3, c.percentile)}%` }} />}
        </div>
        <span className="font-data w-10 text-right text-xs text-muted">{c.percentile == null ? "n/a" : c.percentile}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{c.help}</p>
    </li>
  );
}

export function PlayersPanel({
  players,
  orgId,
  jobId,
  canEdit,
  pitch,
}: {
  players: PlayerView[];
  orgId: string;
  jobId: string;
  canEdit: boolean;
  pitch: { length: number; width: number; boxes: boolean };
}) {
  const [team, setTeam] = useState<"all" | "a" | "b">("all");
  const [open, setOpen] = useState<PlayerView | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const shown = useMemo(
    () =>
      players
        .filter((p) => p.team !== "other" && (team === "all" || p.team === team))
        .sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || y.minutes - x.minutes),
    [players, team],
  );
  const officials = players.filter((p) => p.team === "other").length;

  function show(p: PlayerView) {
    setOpen(p);
    dialog.current?.showModal();
  }

  return (
    <Card className="p-6" corners="mindaro">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-display text-3xl font-bold uppercase">Players</h3>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Physical score out of 100, compared with the other players in this match. It&apos;s built from tracked running only
            (work rate, high-intensity running, top speed, sprints, stamina), so every number is <Badge tone="info">Estimated</Badge>.
          </p>
        </div>
        <div className="flex gap-2" role="radiogroup" aria-label="Team">
          {(["all", "a", "b"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={team === t}
              onClick={() => setTeam(t)}
              className={`rounded-full border px-3 py-1 text-sm ${team === t ? "border-mindaro bg-accent-soft text-fg" : "border-border text-muted hover:text-fg"}`}
            >
              {t === "all" ? "Both teams" : TEAM[t].name}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No players were tracked long enough to report on.</p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => (
            <li key={p.trackNo}>
              <button
                type="button"
                onClick={() => show(p)}
                className="group flex h-full w-full flex-col rounded-xl border border-border bg-bg/40 p-4 text-left transition-colors hover:border-mindaro/60"
                aria-label={`${displayName(p)}, ${TEAM[p.team].name}, ${p.score == null ? "not scored" : `score ${p.score}`}. Open report`}
              >
                <div className="flex items-center gap-3">
                  <Photo p={p} className="h-16 w-12 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate font-semibold group-hover:text-mindaro">
                      {p.shirtNumber != null && <span className="font-data rounded bg-surface-2 px-1.5 text-xs">#{p.shirtNumber}</span>}
                      <span className="truncate">{displayName(p)}</span>
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-muted">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: TEAM[p.team].color }} />
                      {TEAM[p.team].name} · {p.zone ?? "position unknown"}
                    </p>
                  </div>
                  <ScoreRing score={p.score} size={56} />
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Distance</dt>
                    <dd className="font-data text-sm">{p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(2)} km` : `${Math.round(p.distanceM)} m`}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Top speed</dt>
                    <dd className="font-data text-sm">{p.topSpeedKmh.toFixed(1)} km/h</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Sprints</dt>
                    <dd className="font-data text-sm">{p.sprints}</dd>
                  </div>
                </dl>
                <div className="mt-3 space-y-1 text-xs">
                  {p.strengths[0] && <p className="flex gap-1.5"><span aria-hidden="true" className="text-mindaro">▲</span><span className="sr-only">Strength:</span>{p.strengths[0]}</p>}
                  {p.weaknesses[0] && <p className="flex gap-1.5"><span aria-hidden="true" className="text-gold">▼</span><span className="sr-only">Weakness:</span>{p.weaknesses[0]}</p>}
                  {!p.strengths[0] && !p.weaknesses[0] && <p className="text-muted">{p.notScoredBecause ?? "Close to the match average in every area."}</p>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 rounded-lg border border-dashed border-border-strong p-4 text-sm">
        <p className="font-medium">
          Not measured yet: <span className="text-muted">goals, assists, shots, passes, tackles and xG.</span>
        </p>
        <p className="mt-1 text-xs text-muted">
          These need reliable ball tracking, which is still in development. We won&apos;t show these numbers until they&apos;re measured.
          {officials > 0 && ` ${officials} referee or unassigned track${officials === 1 ? " is" : "s are"} left out.`}
        </p>
      </div>

      <dialog
        ref={dialog}
        onClose={() => setOpen(null)}
        className="m-auto w-[min(720px,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-fg backdrop:bg-black/70"
        aria-label={open ? `Report for ${displayName(open)}` : "Player report"}
      >
        {open && <PlayerReportView key={open.trackNo} p={open} orgId={orgId} jobId={jobId} canEdit={canEdit} pitch={pitch} onClose={() => dialog.current?.close()} />}
      </dialog>
    </Card>
  );
}

function PlayerReportView({
  p,
  orgId,
  jobId,
  canEdit,
  pitch,
  onClose,
}: {
  p: PlayerView;
  orgId: string;
  jobId: string;
  canEdit: boolean;
  pitch: { length: number; width: number; boxes: boolean };
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(p.name ?? "");
  const [number, setNumber] = useState(p.shirtNumber?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = Math.max(1, ...p.heatmap.flat());

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PATCH", `/api/orgs/${orgId}/analyses/${jobId}/players/${p.trackNo}`, {
        name: name.trim() || null,
        shirtNumber: number === "" ? null : Number(number),
      });
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative max-h-[85vh] overflow-y-auto p-6">
      {/* First in the dialog, so it takes focus and the report opens at the top. */}
      <button
        type="button"
        onClick={onClose}
        autoFocus
        aria-label="Close report"
        className="absolute right-3 top-3 rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
          <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      <div className="flex items-start gap-4 pr-8">
        <Photo p={p} className="h-28 w-20 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h4 className="font-display text-3xl font-bold uppercase leading-none">
            {p.shirtNumber != null && <span className="text-mindaro">#{p.shirtNumber} </span>}
            {displayName(p)}
          </h4>
          <p className="mt-1 text-sm text-muted">
            {TEAM[p.team].name} · {p.zone ?? "position unknown"} · on camera {p.minutes.toFixed(1)} min
          </p>
          <p className="mt-2 text-xs text-muted">
            Tracked player {p.trackNo}. {p.photoUrl ? "The photo is from the video. " : "No clear photo was found in the video. "}
            Names are added by your staff, never guessed.
          </p>
        </div>
        <div className="text-center">
          <ScoreRing score={p.score} size={84} />
          <p className="mt-1 text-[11px] uppercase tracking-wider text-muted">Physical score</p>
        </div>
      </div>
      {p.notScoredBecause && <p className="mt-4 rounded-lg border border-border bg-bg p-3 text-sm text-muted">Not scored: {p.notScoredBecause}</p>}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="strengths-h">
          <h5 id="strengths-h" className="font-semibold text-mindaro">Strengths</h5>
          <ul className="mt-2 space-y-1.5 text-sm">
            {p.strengths.length ? p.strengths.map((s) => <li key={s}>▲ {s}</li>) : <li className="text-muted">None stand out in this match.</li>}
          </ul>
        </section>
        <section aria-labelledby="weaknesses-h">
          <h5 id="weaknesses-h" className="font-semibold text-gold">To work on</h5>
          <ul className="mt-2 space-y-1.5 text-sm">
            {p.weaknesses.length ? p.weaknesses.map((s) => <li key={s}>▼ {s}</li>) : <li className="text-muted">None stand out in this match.</li>}
          </ul>
        </section>
      </div>

      <section aria-labelledby="breakdown-h" className="mt-6">
        <h5 id="breakdown-h" className="font-semibold">How the score is built</h5>
        <p className="text-xs text-muted">Each bar: where this player ranks among comparable players in this match (100 = highest). The score is their average.</p>
        <ul className="mt-3 space-y-3">
          {p.components.map((c) => (
            <ComponentBar key={c.key} c={c} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="where-h" className="mt-6">
        <h5 id="where-h" className="font-semibold">Where they played</h5>
        <Pitch title={`Heatmap of ${displayName(p)}`} className="mt-2 w-full" size={pitch} boxes={pitch.boxes}>
          {p.heatmap.flatMap((row, iy) =>
            row.map((v, ix) => (v ? <rect key={`${ix}-${iy}`} x={ix * 5} y={iy * 5} width={5} height={5} fill="var(--mindaro)" fillOpacity={0.1 + 0.75 * (v / max)} /> : null)),
          )}
        </Pitch>
      </section>

      {canEdit && (
        <form onSubmit={save} className="mt-6 grid gap-3 rounded-xl border border-border bg-bg p-4 sm:grid-cols-[1fr_120px_auto] sm:items-end">
          <label className="text-sm">
            Player name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2" placeholder="e.g. Omar Hassan" />
          </label>
          <label className="text-sm">
            Shirt number
            <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" className="font-data mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2" />
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-danger sm:col-span-3">
              {error}
            </p>
          )}
        </form>
      )}
      <div className="mt-6 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
