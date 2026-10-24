"use client";

import { useMemo, useState } from "react";
import { Pitch } from "@/components/pitch";
import { hasStandardBoxes } from "@/lib/pitch/landmarks";
import { Badge, Card } from "@/components/ui";
import type { AnalysisSummary, Provenance } from "@/server/analysis/results";

type Track = {
  trackNo: number;
  team: "a" | "b" | "other";
  firstSeconds: number;
  lastSeconds: number;
  coverage: number;
  avgX: number | null;
  avgY: number | null;
  distanceM: number | null;
  heatmap: number[][];
};

// Team identity: Team A = signature (Mindaro, solid), Team B = accent (Elite Gold, dashed).
// Brand colours pass CVD/normal-vision separation; the dash adds a non-colour cue.
const TEAM = {
  a: { name: "Team A", color: "var(--mindaro)", dash: undefined },
  b: { name: "Team B", color: "var(--gold)", dash: "6 4" },
} as const;

const TONE = { measured: "accent", estimated: "info", inferred: "gold", not_available: "neutral" } as const;
const LABEL = { measured: "Measured", estimated: "Estimated", inferred: "Inferred", not_available: "Not available" } as const;

function Prov({ p }: { p: Provenance | undefined }) {
  const v = p ?? "not_available";
  return <Badge tone={TONE[v]}>{LABEL[v]}</Badge>;
}

function mmss(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

type Metric = "width" | "depth" | "line_height";
const METRICS: { key: Metric; title: string; help: string; prov: string }[] = [
  { key: "width", title: "Team width", help: "Distance between the widest outfield players", prov: "team_width" },
  { key: "depth", title: "Team depth", help: "Distance from the deepest to the highest outfield player", prov: "team_depth" },
  { key: "line_height", title: "Defensive line height", help: "How far the back line sits from its own goal", prov: "line_height" },
];

/** Small-multiple line chart of one metric for both teams over time, with a crosshair tooltip. */
function ShapeChart({ windows, metric, title, help, provenance }: { windows: AnalysisSummary["teamShape"]; metric: Metric; title: string; help: string; provenance: Provenance | undefined }) {
  const [hover, setHover] = useState<number | null>(null);
  // Sized close to the rendered width (three charts per row) so text stays legible when scaled.
  const W = 360;
  const H = 170;
  const pad = { l: 30, r: 10, t: 10, b: 24 };
  const values = windows.flatMap((w) => [w.a?.[metric], w.b?.[metric]]).filter((v): v is number => v != null);
  const maxT = windows.length ? windows[windows.length - 1].end : 1;
  const maxV = values.length ? Math.ceil((Math.max(...values) * 1.1) / 10) * 10 : 10;
  const x = (t: number) => pad.l + (t / maxT) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
  const mid = (w: (typeof windows)[number]) => (w.start + w.end) / 2;

  function path(team: "a" | "b") {
    let d = "";
    let pen = false;
    for (const w of windows) {
      const v = w[team]?.[metric];
      if (v == null) {
        pen = false; // gap: insufficient evidence in this window
        continue;
      }
      d += `${pen ? "L" : "M"}${x(mid(w)).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  const ticks = [0, maxV / 2, maxV];
  const tTicks = Array.from({ length: 5 }, (_, i) => (maxT * i) / 4);
  const hw = hover != null ? windows[hover] : null;

  return (
    <figure className="min-w-0">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <Prov p={provenance} />
      </figcaption>
      <p className="text-xs text-muted">{help} (metres)</p>
      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`${title} over time for Team A and Team B, in metres. Use the data table below for exact values.`}
          tabIndex={0}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const t = (((e.clientX - box.left) / box.width) * W - pad.l) / (W - pad.l - pad.r) * maxT;
            setHover(Math.max(0, Math.min(windows.length - 1, Math.floor(t / (windows[0]?.end - windows[0]?.start || 10)))));
          }}
          onMouseLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setHover((h) => Math.min(windows.length - 1, (h ?? -1) + 1));
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? 1) - 1));
          }}
          onBlur={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--pitchline)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--cascade)" style={{ fontFamily: "var(--font-jetbrains)" }}>
                {Math.round(v)}
              </text>
            </g>
          ))}
          {tTicks.map((t, i) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === tTicks.length - 1 ? "end" : "middle"} fontSize={11} fill="var(--cascade)" style={{ fontFamily: "var(--font-jetbrains)" }}>
              {mmss(t)}
            </text>
          ))}
          {hw && <line x1={x(mid(hw))} x2={x(mid(hw))} y1={pad.t} y2={H - pad.b} stroke="var(--cascade)" strokeWidth={1} />}
          {(["a", "b"] as const).map((team) => (
            <path key={team} d={path(team)} fill="none" stroke={TEAM[team].color} strokeWidth={2} strokeDasharray={TEAM[team].dash} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {hw &&
            (["a", "b"] as const).map((team) => {
              const v = hw[team]?.[metric];
              return v == null ? null : <circle key={team} cx={x(mid(hw))} cy={y(v)} r={4} fill={TEAM[team].color} stroke="var(--bg-brand)" strokeWidth={2} />;
            })}
        </svg>
        {hw && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
            <p className="font-data text-muted">
              {mmss(hw.start)}–{mmss(hw.end)}
            </p>
            {(["a", "b"] as const).map((team) => (
              <p key={team} className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: TEAM[team].color }} />
                {TEAM[team].name}: <span className="font-data">{hw[team]?.[metric] != null ? `${hw[team]![metric].toFixed(1)} m` : "not enough players visible"}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm" aria-hidden="true">
      {(["a", "b"] as const).map((t) => (
        <span key={t} className="flex items-center gap-2">
          <svg width="24" height="8">
            <line x1="0" y1="4" x2="24" y2="4" stroke={TEAM[t].color} strokeWidth="2" strokeDasharray={TEAM[t].dash} />
          </svg>
          {TEAM[t].name}
        </span>
      ))}
      <span className="text-muted">Gaps = not enough players visible to measure</span>
    </div>
  );
}

export function ResultsView({ summary, tracks }: { summary: AnalysisSummary; tracks: Track[] }) {
  const [heatTeam, setHeatTeam] = useState<"a" | "b">("a");
  const { length: L, width: Wd, playersPerSide } = summary.pitch;
  const pitchSize = { length: L, width: Wd };
  const boxes = hasStandardBoxes(pitchSize, playersPerSide);
  // Drawings are in real metres; markers scale with the pitch so they stay readable on small pitches.
  const u = L / 105;
  // "Regular" tracks: on camera for at least a minute, or half the clip when the clip is shorter.
  const minSeconds = Math.min(60, 0.5 * summary.durationSeconds);
  const regular = tracks.filter((t) => t.team !== "other" && t.lastSeconds - t.firstSeconds >= minSeconds && t.coverage >= 0.3 && t.avgX != null);

  const heat = useMemo(() => {
    const sum: number[][] = [];
    for (const t of tracks) {
      if (t.team !== heatTeam) continue;
      t.heatmap.forEach((row, iy) =>
        row.forEach((v, ix) => {
          sum[iy] ??= [];
          sum[iy][ix] = (sum[iy][ix] ?? 0) + v;
        }),
      );
    }
    const max = Math.max(1, ...sum.flat().filter(Number.isFinite));
    return { sum, max };
  }, [tracks, heatTeam]);
  const cellW = 5;
  const cellH = 5;

  return (
    <>
      <Card className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Team shape over time</h3>
          <Legend />
        </div>
        <div className="grid gap-8 xl:grid-cols-3">
          {METRICS.map((m) => (
            <ShapeChart key={m.key} windows={summary.teamShape} metric={m.key} title={m.title} help={m.help} provenance={summary.provenance[m.prov]} />
          ))}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Show as a table</summary>
          <div className="mt-3 max-h-80 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3">Time</th>
                  {(["a", "b"] as const).flatMap((t) =>
                    METRICS.map((m) => (
                      <th key={t + m.key} scope="col" className="py-1 pr-3">
                        {TEAM[t].name} {m.title.toLowerCase()} (m)
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody className="font-data">
                {summary.teamShape.map((w) => (
                  <tr key={w.start} className="border-t border-border">
                    <td className="py-1 pr-3">{mmss(w.start)}</td>
                    {(["a", "b"] as const).flatMap((t) =>
                      METRICS.map((m) => (
                        <td key={t + m.key} className="py-1 pr-3">
                          {w[t] ? w[t]![m.key].toFixed(1) : "–"}
                        </td>
                      )),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold">Average positions</h3>
            <Prov p={summary.provenance.average_position as Provenance} />
          </div>
          <p className="mt-1 text-xs text-muted">
            Tracks seen for at least {minSeconds >= 60 ? "a minute" : `${Math.round(minSeconds)} seconds`}. Team A ●, Team B ◆.
            Numbers are track ids, not shirt numbers.
          </p>
          <Pitch title="Average positions of tracked players, Team A and Team B" className="mt-3 w-full" size={pitchSize} boxes={boxes}>
            {regular.map((t) => (
              <g key={t.trackNo}>
                {/* Shape is a second, colour-independent cue: Team A circles, Team B diamonds. */}
                {t.team === "a" ? (
                  <circle cx={t.avgX!} cy={t.avgY!} r={1.8 * u} fill="var(--mindaro)" stroke="var(--bg-brand)" strokeWidth={0.4 * u} />
                ) : (
                  <rect
                    x={t.avgX! - 1.55 * u}
                    y={t.avgY! - 1.55 * u}
                    width={3.1 * u}
                    height={3.1 * u}
                    transform={`rotate(45 ${t.avgX!} ${t.avgY!})`}
                    fill="var(--gold)"
                    stroke="var(--bg-brand)"
                    strokeWidth={0.4 * u}
                  />
                )}
                <text x={t.avgX!} y={t.avgY! + 0.9 * u} textAnchor="middle" fontSize={1.9 * u} fill="var(--bg-brand)" style={{ fontFamily: "var(--font-jetbrains)", fontWeight: 700 }}>
                  {t.trackNo}
                </text>
              </g>
            ))}
          </Pitch>
        </Card>

        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold">Where the team played</h3>
            <Prov p={summary.provenance.heatmap as Provenance} />
          </div>
          <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Team">
            {(["a", "b"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={heatTeam === t}
                onClick={() => setHeatTeam(t)}
                className={`rounded-full border px-3 py-1 text-sm ${heatTeam === t ? "border-mindaro bg-accent-soft text-fg" : "border-border text-muted"}`}
              >
                {TEAM[t].name}
              </button>
            ))}
          </div>
          <Pitch title={`Heatmap of ${TEAM[heatTeam].name}: time spent in each 5-metre area`} className="mt-3 w-full" size={pitchSize} boxes={boxes}>
            {heat.sum.flatMap((row, iy) =>
              row.map((v, ix) =>
                v ? (
                  <rect key={`${ix}-${iy}`} x={ix * cellW} y={iy * cellH} width={cellW} height={cellH} fill="var(--mindaro)" fillOpacity={0.08 + 0.72 * (v / heat.max)} />
                ) : null,
              ),
            )}
          </Pitch>
          <p className="mt-2 text-xs text-muted">Darker = less time, brighter = more time. Built from tracking, so gaps in tracking leave gaps here.</p>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">Tracked players</h3>
          <span className="flex items-center gap-2 text-xs text-muted">
            Distance <Prov p={summary.provenance.distance_covered as Provenance} />
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          A track is one continuous sighting. When the system loses someone (for example behind another player), they come
          back as a new track, so one player can have several.
        </p>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr>
                <th scope="col" className="py-2 pr-3">Track</th>
                <th scope="col" className="py-2 pr-3">Team</th>
                <th scope="col" className="py-2 pr-3">On camera</th>
                <th scope="col" className="py-2 pr-3">Coverage</th>
                <th scope="col" className="py-2 pr-3">Distance (est.)</th>
              </tr>
            </thead>
            <tbody className="font-data">
              {[...tracks]
                .sort((a, b) => b.lastSeconds - b.firstSeconds - (a.lastSeconds - a.firstSeconds))
                .slice(0, 60)
                .map((t) => (
                  <tr key={t.trackNo} className="border-t border-border">
                    <td className="py-1.5 pr-3">#{t.trackNo}</td>
                    <td className="py-1.5 pr-3">{t.team === "other" ? "Other" : TEAM[t.team].name}</td>
                    <td className="py-1.5 pr-3">
                      {mmss(t.firstSeconds)}–{mmss(t.lastSeconds)}
                    </td>
                    <td className="py-1.5 pr-3">{Math.round(t.coverage * 100)}%</td>
                    <td className="py-1.5 pr-3">
                      {t.distanceM == null ? "–" : t.distanceM >= 1000 ? `${(t.distanceM / 1000).toFixed(2)} km` : `${Math.round(t.distanceM)} m`}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
