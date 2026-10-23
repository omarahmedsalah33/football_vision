import type { CSSProperties } from "react";
import { Pitch } from "../pitch";

// Illustrative positions in pitch metres (105 × 68). Not derived from any real match.
type P = { x: number; y: number; id: string; dx: number; dy: number; dur: number; tracked?: boolean };

const HOME: P[] = [
  { x: 5, y: 34, id: "01", dx: 0.6, dy: 1.2, dur: 9 },
  { x: 22, y: 9, id: "02", dx: 2.4, dy: 1, dur: 7 },
  { x: 19, y: 26, id: "04", dx: 1.8, dy: -1.2, dur: 8, tracked: true },
  { x: 19, y: 42, id: "05", dx: 1.6, dy: 1.4, dur: 7.5 },
  { x: 22, y: 59, id: "03", dx: 2.6, dy: -1, dur: 6.5 },
  { x: 37, y: 34, id: "06", dx: 2.2, dy: 1.8, dur: 6, tracked: true },
  { x: 46, y: 18, id: "08", dx: 3, dy: -1.4, dur: 7 },
  { x: 47, y: 50, id: "10", dx: 3.4, dy: 1.6, dur: 6.8, tracked: true },
  { x: 64, y: 11, id: "07", dx: 3.2, dy: 1.2, dur: 5.5, tracked: true },
  { x: 67, y: 34, id: "09", dx: 2.8, dy: -2, dur: 6.2, tracked: true },
  { x: 63, y: 57, id: "11", dx: 3, dy: -1.6, dur: 5.8 },
];

const AWAY: P[] = [
  { x: 100, y: 34, id: "01", dx: -0.6, dy: -1, dur: 9 },
  { x: 82, y: 12, id: "02", dx: -1.6, dy: 1.6, dur: 7.2 },
  { x: 85, y: 28, id: "05", dx: -2, dy: 1.2, dur: 6.4, tracked: true },
  { x: 85, y: 41, id: "04", dx: -2.2, dy: -1, dur: 6.9 },
  { x: 82, y: 56, id: "03", dx: -1.4, dy: -1.8, dur: 7.6 },
  { x: 71, y: 19, id: "07", dx: -2.6, dy: 1.6, dur: 6.1 },
  { x: 73, y: 30, id: "06", dx: -2.4, dy: -1.4, dur: 5.9, tracked: true },
  { x: 73, y: 44, id: "08", dx: -2.8, dy: 1.2, dur: 6.6 },
  { x: 71, y: 52, id: "11", dx: -2.2, dy: -1.8, dur: 7.1 },
  { x: 57, y: 27, id: "09", dx: -3, dy: 1, dur: 5.6 },
  { x: 58, y: 42, id: "10", dx: -3.2, dy: -1.2, dur: 6.3 },
];

// Passing lanes between home players (indices into HOME).
const LANES: [number, number][] = [
  [2, 5],
  [5, 7],
  [7, 9],
  [5, 6],
  [6, 8],
];

function Player({ p, color, selected }: { p: P; color: string; selected?: boolean }) {
  const style = { "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, "--dur": `${p.dur}s` } as CSSProperties;
  return (
    <g className="fv-player" style={style}>
      {selected && (
        <circle cx={p.x} cy={p.y} r={4.2} fill="none" stroke="var(--gold)" strokeWidth={0.35} className="fv-pulse" />
      )}
      {p.tracked && (
        <>
          <rect
            x={p.x - 2.4}
            y={p.y - 3.4}
            width={4.8}
            height={6.8}
            rx={0.5}
            fill="none"
            stroke={color}
            strokeWidth={0.25}
            opacity={0.9}
          />
          <text
            x={p.x - 2.4}
            y={p.y - 4.1}
            fontSize={1.9}
            fill={color}
            style={{ fontFamily: "var(--font-jetbrains)" }}
          >
            ID {p.id}
          </text>
        </>
      )}
      <circle cx={p.x} cy={p.y} r={1.35} fill={color} stroke="var(--bg-brand)" strokeWidth={0.3} />
    </g>
  );
}

/** Hero visual: a stylised camera "vision feed" with tracking overlays, clearly labelled as a sample. */
export function VisionHero() {
  return (
    <figure className="fv-rise relative" style={{ animationDelay: "120ms" }}>
      <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-3 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)] sm:p-4">
        {/* Viewfinder brackets */}
        {["left-2 top-2 border-l-2 border-t-2", "right-2 top-2 border-r-2 border-t-2", "left-2 bottom-2 border-b-2 border-l-2", "right-2 bottom-2 border-b-2 border-r-2"].map(
          (c) => (
            <span key={c} aria-hidden="true" className={`pointer-events-none absolute h-5 w-5 rounded-[3px] border-mindaro/80 ${c}`} />
          ),
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 font-data text-[11px] uppercase tracking-widest text-muted">
          <span>
            Cam 01<span className="hidden sm:inline"> · Fixed wide</span>
          </span>
          <span className="flex items-center gap-2 text-gold">
            <span aria-hidden="true" className="fv-pulse h-2 w-2 rounded-full bg-gold" />
            Sample · Illustrative
          </span>
        </div>

        <Pitch title="Illustrative tracking overlay: two teams with detected players, IDs and passing lanes" className="w-full">
          <defs>
            <linearGradient id="fv-scan-grad" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="var(--mindaro)" stopOpacity="0" />
              <stop offset="0.75" stopColor="var(--mindaro)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--mindaro)" stopOpacity="0.55" />
            </linearGradient>
            <clipPath id="fv-pitch-clip">
              <rect width="105" height="68" />
            </clipPath>
          </defs>
          <g clipPath="url(#fv-pitch-clip)">
            <g className="fv-scan">
              <rect x={-10} y={0} width={10} height={68} fill="url(#fv-scan-grad)" />
              <line x1={0} y1={0} x2={0} y2={68} stroke="var(--mindaro)" strokeWidth={0.25} opacity={0.8} />
            </g>
          </g>
          {LANES.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              x1={HOME[a].x}
              y1={HOME[a].y}
              x2={HOME[b].x}
              y2={HOME[b].y}
              stroke="var(--mindaro)"
              strokeWidth={0.3}
              opacity={0.55}
              className="fv-pass"
            />
          ))}
          {AWAY.map((p) => (
            <Player key={`a${p.id}`} p={p} color="var(--gold)" />
          ))}
          {HOME.map((p) => (
            <Player key={`h${p.id}`} p={p} color="var(--mindaro)" selected={p.id === "10"} />
          ))}
        </Pitch>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted">
          <span className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-mindaro" /> Home
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-gold" /> Away
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-3.5 rounded-sm border border-mindaro" /> Tracked
            </span>
          </span>
          <span className="font-data text-fg">52:14</span>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-muted">
        Illustrative data, not from a real match. Positions in pitch metres (105 × 68 m).
      </figcaption>
    </figure>
  );
}
