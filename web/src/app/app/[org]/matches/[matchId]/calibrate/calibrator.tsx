"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";
import {
  apply,
  assertPlausible,
  CalibrationError,
  fitHomography,
  invert,
  rmsError,
  type Correspondence,
  type Mat3,
  type Vec2,
} from "@/lib/pitch/homography";
import {
  guidedOrder,
  hasStandardBoxes,
  LANDMARK_BY_ID,
  LANDMARK_HINT,
  landmarksFor,
  PITCH_FORMATS,
  pitchSegments,
  type PitchSize,
} from "@/lib/pitch/landmarks";

type Frame = { timeSeconds: number; width: number; height: number; url: string };
type Saved = {
  points: { landmark: string; image: [number, number] }[];
  pitchLength: number;
  pitchWidth: number;
  playersPerSide: number;
  frameTimeSeconds?: number | null;
};
type CameraMotion = "fixed" | "moving" | "unknown" | null;
type Reusable = Saved & { id: string; matchTitle: string; playedOn: string | null; createdAt: Date | string };

type Fit =
  | { ok: true; H: Mat3; inverse: Mat3; rms: number; loo: number | null; looEach: (number | null)[] }
  | { ok: false; problem: string };

const MIN_POINTS = 5;
const GOOD_M = 1;
const MAX_M = 3;

function formatFor(playersPerSide: number) {
  return PITCH_FORMATS.find((f) => f.playersPerSide === playersPerSide) ?? (playersPerSide >= 9 ? PITCH_FORMATS[1] : playersPerSide >= 7 ? PITCH_FORMATS[2] : PITCH_FORMATS[3]);
}

function hint(id: string) {
  return LANDMARK_HINT[id] ?? LANDMARK_BY_ID.get(id)?.label.toLowerCase() ?? id;
}

function mmss(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Fit plus a per-point check: each point predicted from a fit made without it. */
function computeFit(cs: Correspondence[]): Fit | null {
  if (cs.length < 4) return null;
  try {
    const H = fitHomography(cs);
    assertPlausible(H, cs.map((c) => c.image));
    const looEach =
      cs.length >= MIN_POINTS
        ? cs.map((c, i) => {
            try {
              const Hi = fitHomography(cs.filter((_, j) => j !== i));
              const q = apply(Hi, c.image);
              return Math.hypot(q[0] - c.pitch[0], q[1] - c.pitch[1]);
            } catch {
              return null;
            }
          })
        : cs.map(() => null);
    const valid = looEach.filter((e): e is number => e !== null);
    const loo = cs.length >= MIN_POINTS && valid.length === cs.length ? Math.sqrt(valid.reduce((s, e) => s + e * e, 0) / valid.length) : null;
    return { ok: true, H, inverse: invert(H), rms: rmsError(H, cs), loo, looEach };
  } catch (err) {
    return { ok: false, problem: err instanceof CalibrationError ? err.message : "These points can't be fitted." };
  }
}

/** Small top-down pitch showing which point to click next. Dots are buttons so any point can be redone. */
function PitchGuide({
  size,
  boxes,
  ids,
  placed,
  skipped,
  current,
  bad,
  onSelect,
}: {
  size: PitchSize;
  boxes: boolean;
  ids: string[];
  placed: Set<string>;
  skipped: Set<string>;
  current: string | null;
  bad: string | null;
  onSelect: (id: string) => void;
}) {
  const u = size.length / 105;
  const pad = 8 * u;
  return (
    <svg viewBox={`${-pad} ${-pad} ${size.length + 2 * pad} ${size.width + 2 * pad}`} className="w-full" aria-label="Pitch drawing: far touchline at the top, near touchline (closest to the camera) at the bottom">
      <rect x={-pad} y={-pad} width={size.length + 2 * pad} height={size.width + 2 * pad} rx={2 * u} fill="var(--forest)" />
      {pitchSegments(size, boxes).map(([a, b], i) => (
        <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--pitch-line)" strokeWidth={0.5 * u} />
      ))}
      {boxes && <circle cx={size.length / 2} cy={size.width / 2} r={9.15} fill="none" stroke="var(--pitch-line)" strokeWidth={0.5 * u} />}
      <text x={size.length / 2} y={-pad * 0.45} textAnchor="middle" fontSize={3 * u} fill="var(--cascade)">
        FAR SIDE
      </text>
      <text x={size.length / 2} y={size.width + pad * 0.8} textAnchor="middle" fontSize={3 * u} fill="var(--cascade)">
        NEAR SIDE (CAMERA)
      </text>
      {ids.map((id) => {
        const [x, y] = LANDMARK_BY_ID.get(id)!.at(size);
        const isCurrent = id === current;
        const state = id === bad ? "needs fixing" : placed.has(id) ? "placed" : skipped.has(id) ? "skipped" : "not placed";
        const fill = id === bad ? "var(--danger)" : placed.has(id) ? "var(--mindaro)" : "none";
        const stroke = id === bad ? "var(--danger)" : placed.has(id) ? "var(--mindaro)" : skipped.has(id) ? "var(--pitchline)" : "var(--cascade)";
        return (
          <g
            key={id}
            role="button"
            tabIndex={0}
            aria-label={`Select ${hint(id)} (${state})`}
            aria-pressed={isCurrent}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(id);
              }
            }}
            className="cursor-pointer outline-none [&:focus-visible>circle:last-child]:stroke-[var(--white)]"
          >
            {isCurrent && (
              <circle cx={x} cy={y} r={3.2 * u} fill="none" stroke="var(--gold)" strokeWidth={0.7 * u}>
                <animate attributeName="r" values={`${2.4 * u};${4 * u};${2.4 * u}`} dur="1.4s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={x} cy={y} r={4 * u} fill="transparent" />
            <circle cx={x} cy={y} r={1.6 * u} fill={isCurrent && !placed.has(id) ? "var(--gold)" : fill} stroke={isCurrent ? "var(--gold)" : stroke} strokeWidth={0.6 * u} />
          </g>
        );
      })}
    </svg>
  );
}

export function Calibrator({
  orgId,
  matchId,
  backHref,
  canEdit,
  width,
  height,
  frames,
  initial,
  reusable,
  cameraMotion,
  startsAnalysis = false,
}: {
  orgId: string;
  matchId: string;
  backHref: string;
  canEdit: boolean;
  width: number;
  height: number;
  frames: Frame[];
  initial: Saved | null;
  reusable: Reusable[];
  cameraMotion: CameraMotion;
  /** Saving also starts the analysis (for roles allowed to run one). */
  startsAnalysis?: boolean;
}) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);
  const [step, setStep] = useState<"pitch" | "points">(initial || !canEdit ? "points" : "pitch");
  const [formatId, setFormatId] = useState(formatFor(initial?.playersPerSide ?? 11).id);
  const format = PITCH_FORMATS.find((f) => f.id === formatId)!;
  const [playersPerSide, setPlayersPerSide] = useState<number>(initial?.playersPerSide ?? 11);
  const [size, setSize] = useState<PitchSize>(initial ? { length: initial.pitchLength, width: initial.pitchWidth } : format.size);
  const [points, setPoints] = useState<Record<string, Vec2>>(() => Object.fromEntries((initial?.points ?? []).map((p) => [p.landmark, p.image])));
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const [lastPlaced, setLastPlaced] = useState<string | null>(null);
  const moving = cameraMotion === "moving";
  const initialFrame = Math.max(0, frames.findIndex((f) => initial?.frameTimeSeconds != null && Math.abs(f.timeSeconds - initial.frameTimeSeconds) < 0.05));
  const [frameIdx, setFrameIdx] = useState(initialFrame);
  // The frame the points are clicked on. With a moving camera every point must be on this frame.
  const [anchorIdx, setAnchorIdx] = useState<number | null>(initial?.points.length ? initialFrame : null);
  const [zoom, setZoom] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const boxes = hasStandardBoxes(size, playersPerSide);
  const order = useMemo(() => guidedOrder(size, playersPerSide).map((l) => l.id), [size, playersPerSide]);
  const allowed = useMemo(() => new Set(landmarksFor(size, playersPerSide).map((l) => l.id)), [size, playersPerSide]);
  const placedIds = useMemo(() => Object.keys(points).filter((id) => allowed.has(id)), [points, allowed]);
  const placed = useMemo(() => new Set(placedIds), [placedIds]);
  const nextInOrder = order.find((id) => !placed.has(id) && !skipped.has(id)) ?? null;
  const current = chosen ?? nextInOrder;

  const correspondences: (Correspondence & { landmark: string })[] = useMemo(
    () => placedIds.map((landmark) => ({ landmark, image: points[landmark], pitch: LANDMARK_BY_ID.get(landmark)!.at(size) })),
    [placedIds, points, size],
  );
  const fit = useMemo(() => computeFit(correspondences), [correspondences]);
  const enough = correspondences.length >= MIN_POINTS;
  const quality = fit?.ok && enough ? fit.loo : null;
  const worst =
    fit?.ok && quality !== null && quality > GOOD_M
      ? correspondences[fit.looEach.reduce<number>((best, e, i) => ((e ?? 0) > (fit.looEach[best] ?? 0) ? i : best), 0)].landmark
      : null;
  const bad = quality !== null && quality > MAX_M ? worst : null;
  const r = Math.max(width, height) / 220;

  function choosePitch(id: string) {
    const f = PITCH_FORMATS.find((x) => x.id === id)!;
    setFormatId(id);
    setPlayersPerSide(f.playersPerSide);
    setSize(f.size);
  }

  function selectFrame(i: number) {
    if (i === frameIdx) return;
    if (moving && placedIds.length > 0) {
      // A moving camera shows a different view in each frame, so points can't be mixed.
      setPoints({});
      setSkipped(new Set());
      setChosen(null);
      setLastPlaced(null);
      setAnchorIdx(null);
      setNotice("Points belong to one frame with a moving camera, so switching frames starts over.");
    }
    setFrameIdx(i);
  }

  function place(at: Vec2) {
    if (!canEdit || !current) return;
    if (placedIds.length === 0 || anchorIdx === null) setAnchorIdx(frameIdx);
    const clamped: Vec2 = [Math.min(width, Math.max(0, at[0])), Math.min(height, Math.max(0, at[1]))];
    setPoints((p) => ({ ...p, [current]: clamped }));
    setSkipped((s) => {
      const n = new Set(s);
      n.delete(current);
      return n;
    });
    setLastPlaced(current);
    setChosen(null);
    setNotice(null);
    setError(null);
  }

  function onFrameClick(e: React.MouseEvent<SVGSVGElement>) {
    const box = svgRef.current!.getBoundingClientRect();
    place([((e.clientX - box.left) / box.width) * width, ((e.clientY - box.top) / box.height) * height]);
  }

  function onKey(e: React.KeyboardEvent) {
    const id = lastPlaced;
    const p = id ? points[id] : undefined;
    if (!id || !p) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, Vec2> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      setPoints((all) => ({ ...all, [id]: [p[0] + moves[e.key][0], p[1] + moves[e.key][1]] }));
    }
  }

  function skipCurrent() {
    if (!current) return;
    setSkipped((s) => new Set(s).add(current));
    setPoints((p) => {
      const copy = { ...p };
      delete copy[current];
      return copy;
    });
    setChosen(null);
  }

  function startOver() {
    setPoints({});
    setSkipped(new Set());
    setChosen(null);
    setLastPlaced(null);
    setNotice(null);
  }

  function reuse(c: Reusable) {
    setFormatId(formatFor(c.playersPerSide).id);
    setPlayersPerSide(c.playersPerSide);
    setSize({ length: c.pitchLength, width: c.pitchWidth });
    setPoints(Object.fromEntries(c.points.map((p) => [p.landmark, p.image])));
    setSkipped(new Set());
    setChosen(null);
    setStep("points");
    setNotice(`Points copied from “${c.matchTitle}”. If the camera was in the same spot, the green lines sit on the pitch lines. If not, start over.`);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/orgs/${orgId}/matches/${matchId}/calibration`, {
        pitchLength: size.length,
        pitchWidth: size.width,
        playersPerSide,
        frameTimeSeconds: frames[anchorIdx ?? frameIdx].timeSeconds,
        points: correspondences.map((c) => ({ landmark: c.landmark, x: c.image[0], y: c.image[1] })),
      });
      router.push(backHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the calibration.");
      setSaving(false);
    }
  }

  if (step === "pitch") {
    return (
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="p-6">
          {moving && <MovingNote />}
          <h2 className="text-lg font-semibold">1 · What kind of pitch is it?</h2>
          <div role="radiogroup" aria-label="Pitch type" className="mt-4 grid gap-3 sm:grid-cols-2">
            {PITCH_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={formatId === f.id}
                onClick={() => choosePitch(f.id)}
                className={`rounded-xl border p-4 text-left transition-colors ${formatId === f.id ? "border-mindaro bg-accent-soft" : "border-border hover:border-cascade"}`}
              >
                <span className="font-display text-xl font-bold uppercase">{f.label}</span>
                <span className="mt-1 block text-sm text-muted">{f.help}</span>
                <span className="font-data mt-2 block text-xs text-muted">
                  typically {f.size.length} × {f.size.width} m
                </span>
              </button>
            ))}
          </div>
          <fieldset className="mt-6">
            <legend className="font-medium">Your pitch size</legend>
            <p className="text-xs text-muted">Distances are only as accurate as these numbers. Change them if you know your pitch.</p>
            <div className="mt-2 grid max-w-sm grid-cols-2 gap-3 text-sm">
              <label>
                Length, goal to goal (m)
                <input
                  type="number"
                  min={20}
                  max={120}
                  step={0.5}
                  value={size.length}
                  onChange={(e) => setSize((s) => ({ ...s, length: Number(e.target.value) }))}
                  className="font-data mt-1 w-full rounded-lg border border-border-strong bg-bg px-2 py-1.5"
                />
              </label>
              <label>
                Width (m)
                <input
                  type="number"
                  min={12}
                  max={90}
                  step={0.5}
                  value={size.width}
                  onChange={(e) => setSize((s) => ({ ...s, width: Number(e.target.value) }))}
                  className="font-data mt-1 w-full rounded-lg border border-border-strong bg-bg px-2 py-1.5"
                />
              </label>
            </div>
          </fieldset>
          <Button className="mt-6" disabled={!(size.length >= 20 && size.width >= 12 && size.length > size.width)} onClick={() => setStep("points")}>
            Next: mark the pitch
          </Button>
        </Card>

        {reusable.length > 0 && (
          <Card className="h-fit p-6">
            <h2 className="text-lg font-semibold">Same camera spot as before?</h2>
            <p className="mt-1 text-sm text-muted">Reuse the points from an earlier match, then check the lines by eye.</p>
            <ul className="mt-3 space-y-2">
              {reusable.map((c) => (
                <li key={c.id}>
                  <Button variant="secondary" className="w-full justify-between text-left" onClick={() => reuse(c)}>
                    <span className="truncate">Use “{c.matchTitle}”</span>
                    <span className="font-data shrink-0 text-xs text-muted">{c.playedOn ?? new Date(c.createdAt).toISOString().slice(0, 10)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  }

  const status = !fit
    ? null
    : !fit.ok
      ? { tone: "danger" as const, title: "These points don't fit together", text: fit.problem }
      : !enough
        ? null
        : quality === null
          ? { tone: "warning" as const, title: "Can't check these points yet", text: "Some points line up with each other. Add a point somewhere else on the pitch." }
          : quality <= GOOD_M
            ? { tone: "accent" as const, title: `Great: accurate to about ${quality.toFixed(1)} m`, text: "Positions will be labelled as measured." }
            : quality <= MAX_M
              ? { tone: "warning" as const, title: `OK: accurate to about ${quality.toFixed(1)} m`, text: `Positions will be labelled as estimates. To improve it, redo ${hint(worst!)}.` }
              : { tone: "danger" as const, title: "The points don't agree", text: `${hint(bad!)[0].toUpperCase()}${hint(bad!).slice(1)} is probably in the wrong place. Select it (red) on the drawing and click its real spot again.` };

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-3">
        {moving && <MovingNote />}
        <div className="flex items-end gap-3">
          <div role="group" aria-label="Choose a frame" className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            {frames.map((f, i) => (
              <button
                key={f.url}
                type="button"
                onClick={() => selectFrame(i)}
                aria-pressed={i === frameIdx}
                aria-label={`Frame at ${mmss(f.timeSeconds)}${i === anchorIdx && placedIds.length ? " (your points are on this frame)" : ""}`}
                className={`relative w-24 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${i === frameIdx ? "border-mindaro" : "border-transparent opacity-70 hover:opacity-100"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage */}
                <img src={f.url} alt="" className="block aspect-video w-full object-cover" draggable={false} />
                <span className="font-data absolute bottom-0 right-0 rounded-tl bg-bg/85 px-1 text-[10px]">{mmss(f.timeSeconds)}</span>
                {i === anchorIdx && placedIds.length > 0 && <span aria-hidden="true" className="absolute left-1 top-1 h-2 w-2 rounded-full bg-mindaro" />}
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => setZoom((z) => (z === 1 ? 2 : 1))} aria-pressed={zoom === 2}>
            Zoom {zoom === 1 ? "2×" : "1×"}
          </Button>
        </div>
        <div className="overflow-auto rounded-xl border border-border bg-bg" style={{ maxHeight: "75vh" }}>
          <div className="relative" style={{ width: `${zoom * 100}%` }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage */}
            <img src={frames[frameIdx].url} alt={`Video frame at ${Math.round(frames[frameIdx].timeSeconds)} seconds`} className="block w-full select-none" draggable={false} />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${width} ${height}`}
              className={`absolute inset-0 h-full w-full ${canEdit && current ? "cursor-crosshair" : ""}`}
              onClick={onFrameClick}
              onKeyDown={onKey}
              tabIndex={0}
              role="application"
              aria-label={`Video frame. Click ${current ? hint(current) : "a point"}. Arrow keys nudge the last point, Shift for 10 pixels.`}
            >
              {fit?.ok &&
                (!moving || anchorIdx === null || anchorIdx === frameIdx) &&
                pitchSegments(size, boxes).map(([a, b], i) => {
                  const p = apply(fit.inverse, a);
                  const q = apply(fit.inverse, b);
                  return <line key={i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="var(--mindaro)" strokeWidth={r / 3} opacity={0.85} />;
                })}
              {correspondences.map((c) => {
                const color = c.landmark === bad ? "var(--danger)" : "var(--mindaro)";
                return (
                  <g key={c.landmark}>
                    <circle cx={c.image[0]} cy={c.image[1]} r={c.landmark === current ? r * 1.6 : r} fill="none" stroke={color} strokeWidth={r / 2.5} />
                    <circle cx={c.image[0]} cy={c.image[1]} r={r / 3} fill={color} />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
        <p className="text-xs text-muted">
          {moving
            ? "Pick the frame that shows the most pitch lines, then mark all points on it. Once 4 points are placed, green pitch lines are drawn over the video so you can check them."
            : "If players or the camera angle hide the lines, try another frame. Once 4 points are placed, green pitch lines are drawn over the video so you can check them."}
        </p>
      </div>

      <aside className="space-y-4">
        {canEdit && (
          <Card className="p-4" corners="pitchline">
            <p className="font-data text-xs uppercase tracking-widest text-muted">
              {format.label} · {size.length} × {size.width} m
            </p>
            {current ? (
              <>
                <h2 className="mt-2 text-xl font-semibold" aria-live="polite">
                  Click {hint(current)}
                </h2>
                <p className="mt-1 text-xs text-muted">Far = the side away from the camera. Left and right as you see them in the video.</p>
              </>
            ) : (
              <h2 className="mt-2 text-xl font-semibold" aria-live="polite">
                {enough ? "All points done" : "No more points to ask for"}
              </h2>
            )}
            <div className="mt-3">
              <PitchGuide size={size} boxes={boxes} ids={order} placed={placed} skipped={skipped} current={current} bad={bad} onSelect={setChosen} />
            </div>
            <p className="mt-2 text-sm">
              <span className="font-data">{correspondences.length}</span> placed
              {correspondences.length < MIN_POINTS && <span className="text-muted"> · {MIN_POINTS - correspondences.length} more needed</span>}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {current && (
                <Button variant="secondary" onClick={skipCurrent}>
                  {placed.has(current) ? "Remove this point" : "I can't see this point"}
                </Button>
              )}
              <Button variant="ghost" onClick={startOver}>
                Start over
              </Button>
              <Button variant="ghost" onClick={() => setStep("pitch")}>
                Change pitch
              </Button>
            </div>
            {!current && !enough && (
              <p className="mt-3 text-sm text-gold">
                Only {correspondences.length} points could be marked. Try another frame where more of the pitch lines show, or select a skipped
                point on the drawing.
              </p>
            )}
          </Card>
        )}

        {notice && <p className="rounded-lg border border-mindaro/40 bg-accent-soft p-3 text-sm">{notice}</p>}

        {status && (
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold">{status.title}</h2>
              <Badge tone={status.tone}>{status.tone === "accent" ? "Good" : status.tone === "warning" ? "Usable" : "Fix a point"}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">{status.text}</p>
            {fit?.ok && quality !== null && quality <= MAX_M && canEdit && (
              <div className="mt-4 rounded-lg border border-border bg-bg p-3">
                <p className="text-sm font-medium">Do the green lines sit on the white lines of your pitch?</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button disabled={saving} onClick={save}>
                    {saving ? "Saving…" : startsAnalysis ? "Yes, save and analyse" : "Yes, save calibration"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted">If not, select the point that&apos;s off on the drawing and click its real spot again.</p>
              </div>
            )}
            {fit?.ok && (
              <details className="mt-3 text-xs text-muted">
                <summary className="cursor-pointer">Details</summary>
                <dl className="font-data mt-2 grid grid-cols-2 gap-y-1">
                  <dt>Fit error</dt>
                  <dd className="text-right">{fit.rms.toFixed(2)} m</dd>
                  <dt>Prediction error</dt>
                  <dd className="text-right">{fit.loo === null ? "n/a" : `${fit.loo.toFixed(2)} m`}</dd>
                </dl>
                <p className="mt-1">Prediction error checks each point against a fit made without it. Under 1 m is good; over 3 m can&apos;t be saved.</p>
              </details>
            )}
          </Card>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        {!canEdit && <p className="text-sm text-muted">Your role can view but not change the calibration.</p>}
      </aside>
    </div>
  );
}

function MovingNote() {
  return (
    <p className="mb-4 rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm">
      <strong className="text-gold">Moving camera.</strong> This video follows the play, so the view changes. Pick one frame that
      shows plenty of pitch lines and mark all the points on it. We follow the camera from there, and skip replays and close-ups.
    </p>
  );
}
