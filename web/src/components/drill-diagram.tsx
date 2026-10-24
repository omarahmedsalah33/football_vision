"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { actorRadius, isLook, stateIn, stepPaths, stepStarts, type Diagram, type Item, type Pt, type Team } from "@/lib/development/diagram";

const TEAM_FILL: Record<Team, string> = { p: "var(--mindaro)", o: "var(--gold)", n: "var(--white)" };
const HOLD_AT_END_MS = 1400;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(q.matches);
    update();
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Stops a path short of its end, so the arrowhead sits in front of the player instead of under them. */
function trimEnd(points: Pt[], by: number): Pt[] {
  if (points.length < 2) return points;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len <= by * 1.5) return points;
  const k = (len - by) / len;
  return [...points.slice(0, -1), [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]];
}

function PitchMarkings({ sw }: { sw: number }) {
  const c = { fill: "none", stroke: "var(--pitch-line)", strokeWidth: sw };
  return (
    <g>
      <rect x={0} y={0} width={105} height={68} {...c} />
      <line x1={52.5} y1={0} x2={52.5} y2={68} {...c} />
      <circle cx={52.5} cy={34} r={9.15} {...c} />
      <rect x={0} y={13.84} width={16.5} height={40.32} {...c} />
      <rect x={88.5} y={13.84} width={16.5} height={40.32} {...c} />
      <rect x={0} y={24.84} width={5.5} height={18.32} {...c} />
      <rect x={99.5} y={24.84} width={5.5} height={18.32} {...c} />
      <rect x={-1.5} y={30.34} width={1.5} height={7.32} {...c} />
      <rect x={105} y={30.34} width={1.5} height={7.32} {...c} />
    </g>
  );
}

function ItemShape({ item, r }: { item: Item; r: number }) {
  const sw = r * 0.14;
  const coneAt = ([x, y]: Pt, k: string) => <path key={k} d={`M${x} ${y - r * 0.55} L${x + r * 0.45} ${y + r * 0.35} L${x - r * 0.45} ${y + r * 0.35} Z`} fill="var(--gold)" opacity={0.9} />;
  switch (item.kind) {
    case "pitch":
      return <PitchMarkings sw={sw} />;
    case "cone":
      return coneAt(item.at, "c");
    case "gate":
      return (
        <g>
          <line x1={item.a[0]} y1={item.a[1]} x2={item.b[0]} y2={item.b[1]} stroke="var(--gold)" strokeWidth={sw} strokeDasharray={`${r * 0.3} ${r * 0.3}`} opacity={0.7} />
          {coneAt(item.a, "a")}
          {coneAt(item.b, "b")}
        </g>
      );
    case "goal": {
      const depth = Math.max(0.6, item.width * 0.22);
      const x = item.facing === "right" ? item.at[0] - depth : item.at[0];
      return <rect x={x} y={item.at[1] - item.width / 2} width={depth} height={item.width} fill="color-mix(in srgb, var(--white) 12%, transparent)" stroke="var(--white)" strokeWidth={sw * 1.4} />;
    }
    case "wall":
      return <line x1={item.a[0]} y1={item.a[1]} x2={item.b[0]} y2={item.b[1]} stroke="var(--cascade)" strokeWidth={r * 0.7} strokeLinecap="round" />;
    case "line":
      return <line x1={item.a[0]} y1={item.a[1]} x2={item.b[0]} y2={item.b[1]} stroke="var(--pitch-line)" strokeWidth={sw} />;
    case "zone":
      return (
        <g>
          <rect x={item.at[0]} y={item.at[1]} width={item.w} height={item.h} fill="var(--mindaro)" fillOpacity={0.08} stroke="var(--mindaro)" strokeOpacity={0.5} strokeWidth={sw} strokeDasharray={`${r * 0.4} ${r * 0.3}`} />
          {item.label && (
            <text x={item.at[0] + r * 0.3} y={item.at[1] - r * 0.3} fontSize={r * 1.1} fill="var(--mindaro)" style={{ fontFamily: "var(--font-jetbrains)" }}>
              {item.label}
            </text>
          )}
        </g>
      );
  }
}

/** An animated, step-by-step drill diagram. Plays when visible; respects reduced motion. */
export function DrillDiagram({ diagram, title }: { diagram: Diagram; title: string }) {
  const uid = useId().replace(/:/g, "");
  const starts = useMemo(() => stepStarts(diagram), [diagram]);
  const r = actorRadius(diagram);
  const reduced = usePrefersReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  // "auto" plays whenever the diagram is on screen (unless the viewer prefers less motion).
  const [choice, setChoice] = useState<"auto" | "play" | "pause">("auto");
  const playing = visible && (choice === "play" || (choice === "auto" && !reduced));
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const pos = useRef({ step: 0, progress: 0, hold: 0 });
  // Read by the animation loop, so a frame already queued stops the moment the viewer pauses.
  const live = useRef(false);
  useEffect(() => {
    live.current = playing;
  }, [playing]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && e.intersectionRatio > 0.3), { threshold: [0, 0.3, 0.6] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (!live.current) return;
      const dt = Math.min(100, now - last);
      last = now;
      const s = pos.current;
      if (s.hold > 0) {
        s.hold -= dt;
        if (s.hold <= 0) Object.assign(s, { step: 0, progress: 0, hold: 0 });
      } else {
        s.progress += dt / (diagram.frames[s.step].seconds * 1000);
        if (s.progress >= 1) {
          if (s.step < diagram.frames.length - 1) Object.assign(s, { step: s.step + 1, progress: 0 });
          else Object.assign(s, { progress: 1, hold: HOLD_AT_END_MS });
        }
      }
      setStep(s.step);
      setProgress(s.progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, diagram]);

  const goTo = (k: number) => {
    live.current = false;
    pos.current = { step: k, progress: 1, hold: 0 };
    setStep(k);
    setProgress(1);
    setChoice("pause");
  };
  const togglePlay = () => {
    if (playing) {
      live.current = false;
      setChoice("pause");
      return;
    }
    const s = pos.current;
    if (s.progress >= 1) Object.assign(s, s.step < diagram.frames.length - 1 ? { step: s.step + 1, progress: 0, hold: 0 } : { step: 0, progress: 0, hold: 0 });
    setChoice("play");
  };
  const restart = () => {
    pos.current = { step: 0, progress: 0, hold: 0 };
    setStep(0);
    setProgress(0);
    setChoice("play");
  };

  const frame = diagram.frames[step];
  const now = stateIn(diagram, starts[step], step, progress);
  const paths = stepPaths(diagram, starts[step], frame);
  const pad = Math.max(diagram.w, diagram.h) * 0.04 + r;
  const stripes = 8;
  const sw = r * 0.2;

  return (
    <figure ref={box} className="overflow-hidden rounded-xl border border-border bg-bg/60">
      <svg
        viewBox={`${-pad} ${-pad} ${diagram.w + pad * 2} ${diagram.h + pad * 2}`}
        className="mx-auto block max-h-[26rem] w-full"
        role="img"
        aria-label={`Diagram of ${title}, step ${step + 1} of ${diagram.frames.length}: ${frame.caption}`}
      >
        <defs>
          {(["p", "o", "n"] as Team[]).map((t) => (
            <marker key={t} id={`${uid}-run-${t}`} viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth={r * 1.1} markerHeight={r * 1.1} orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 Z" fill={TEAM_FILL[t]} />
            </marker>
          ))}
          <marker id={`${uid}-ball`} viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth={r * 0.9} markerHeight={r * 0.9} orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 Z" fill="var(--white)" />
          </marker>
        </defs>
        <rect x={-pad} y={-pad} width={diagram.w + pad * 2} height={diagram.h + pad * 2} fill="color-mix(in srgb, var(--lush) 32%, var(--bg-brand))" />
        {Array.from({ length: stripes }, (_, i) => (
          <rect key={i} x={-pad + ((diagram.w + pad * 2) / stripes) * i} y={-pad} width={(diagram.w + pad * 2) / stripes} height={diagram.h + pad * 2} fill="var(--lush)" opacity={i % 2 ? 0.1 : 0} />
        ))}
        {!diagram.items.some((it) => it.kind === "pitch") && <rect x={0} y={0} width={diagram.w} height={diagram.h} fill="none" stroke="var(--pitch-line)" strokeOpacity={0.35} strokeWidth={sw * 0.8} strokeDasharray={`${r * 0.5} ${r * 0.5}`} />}
        {diagram.items.map((it, i) => (
          <ItemShape key={i} item={it} r={r} />
        ))}

        {/* This step's movements: runs dashed, passes solid. */}
        {paths.map((pth, i) => {
          const team = pth.who ? diagram.actors[pth.who].team : null;
          const color = team ? TEAM_FILL[team] : "var(--white)";
          const dash = pth.kind === "run" ? (pth.style === "walk" ? `${r * 0.3} ${r * 0.4}` : `${r * 0.7} ${r * 0.4}`) : undefined;
          return (
            <polyline
              key={i}
              points={trimEnd(pth.points, pth.kind === "run" ? r * 1.15 : r * 0.55).map((q) => q.join(",")).join(" ")}
              fill="none"
              stroke={color}
              strokeOpacity={0.7}
              strokeWidth={pth.kind === "ball" ? sw * 1.1 : sw * (pth.style === "sprint" ? 1.4 : 1)}
              strokeDasharray={dash}
              strokeLinejoin="round"
              markerEnd={`url(#${uid}-${team ? `run-${team}` : "ball"})`}
            />
          );
        })}
        {frame.moves.filter(isLook).map((m, i) => {
          const from = now.actors[m.look];
          return (
            <g key={`look-${i}`} opacity={0.85}>
              <line x1={from[0]} y1={from[1]} x2={m.at[0]} y2={m.at[1]} stroke="var(--white)" strokeWidth={sw * 0.8} strokeDasharray={`${r * 0.2} ${r * 0.3}`} />
              <circle cx={m.at[0]} cy={m.at[1]} r={r * 0.45} fill="none" stroke="var(--white)" strokeWidth={sw} />
            </g>
          );
        })}

        {Object.entries(diagram.actors).map(([k, a]) => {
          const [x, y] = now.actors[k];
          return (
            <g key={k}>
              <circle cx={x} cy={y} r={r} fill={TEAM_FILL[a.team]} stroke="var(--bg-brand)" strokeWidth={sw} />
              {a.label && (
                <text x={x} y={y + r * 0.38} textAnchor="middle" fontSize={r * 1.05} fontWeight={700} fill="var(--bg-brand)">
                  {a.label}
                </text>
              )}
            </g>
          );
        })}
        {now.ball && <circle cx={now.ball[0]} cy={now.ball[1]} r={r * 0.48} fill="var(--white)" stroke="var(--bg-brand)" strokeWidth={sw * 0.8} />}
      </svg>

      <figcaption className="space-y-3 border-t border-border p-3">
        <p className="min-h-10 text-sm" aria-live={playing ? "off" : "polite"}>
          <span className="font-data text-xs text-mindaro">
            STEP {step + 1}/{diagram.frames.length}
          </span>{" "}
          {frame.caption}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={togglePlay} className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold hover:border-cascade">
            {playing ? (
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <path d="M3 2l7 4-7 4z" fill="currentColor" />
              </svg>
            )}
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={restart} className="rounded-lg px-2 py-1.5 text-xs text-muted hover:text-fg">
            Restart
          </button>
          <ol className="ml-auto flex items-center gap-1.5" aria-label="Steps">
            {diagram.frames.map((f, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Step ${i + 1}: ${f.caption}`}
                  aria-current={i === step ? "step" : undefined}
                  className={`block h-2.5 rounded-full transition-all ${i === step ? "w-6 bg-mindaro" : "w-2.5 bg-border-strong hover:bg-cascade"}`}
                />
              </li>
            ))}
          </ol>
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-mindaro" /> Player
          </span>
          {Object.values(diagram.actors).some((a) => a.team === "o") && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-gold" /> Opponent
            </span>
          )}
          {Object.values(diagram.actors).some((a) => a.team === "n") && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-fg" /> Partner or coach
            </span>
          )}
          <span>- - run</span>
          <span>── pass</span>
        </p>
      </figcaption>
    </figure>
  );
}
