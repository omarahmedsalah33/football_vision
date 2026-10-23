"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";
import {
  apply,
  CalibrationError,
  fitHomography,
  invert,
  leaveOneOutError,
  residuals,
  rmsError,
  type Correspondence,
  type Mat3,
  type Vec2,
} from "@/lib/pitch/homography";
import { LANDMARK_BY_ID, LANDMARKS, pitchSegments } from "@/lib/pitch/landmarks";

type Frame = { timeSeconds: number; width: number; height: number; url: string };
type Fit =
  | { ok: true; H: Mat3; inverse: Mat3; rms: number; loo: number | null; res: number[] }
  | { ok: false; problem: string };
type Saved = { points: { landmark: string; image: [number, number] }[]; pitchLength: number; pitchWidth: number } | null;

const GOOD_M = 1;
const MAX_M = 3;
const GROUPS = ["Centre", "Left half", "Right half"];

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function qualityTone(m: number) {
  return m <= GOOD_M ? "accent" : m <= MAX_M ? "warning" : "danger";
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
}: {
  orgId: string;
  matchId: string;
  backHref: string;
  canEdit: boolean;
  width: number;
  height: number;
  frames: Frame[];
  initial: Saved;
}) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pitch, setPitch] = useState({ length: initial?.pitchLength ?? 105, width: initial?.pitchWidth ?? 68 });
  const [points, setPoints] = useState<Record<string, Vec2>>(() =>
    Object.fromEntries((initial?.points ?? []).map((p) => [p.landmark, p.image])),
  );
  const [selected, setSelected] = useState<string>(LANDMARKS[0].id);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const correspondences: (Correspondence & { landmark: string })[] = useMemo(
    () =>
      Object.entries(points).map(([landmark, image]) => ({
        landmark,
        image,
        pitch: LANDMARK_BY_ID.get(landmark)!.at(pitch),
      })),
    [points, pitch],
  );

  const fit = useMemo((): Fit | null => {
    if (correspondences.length < 4) return null;
    try {
      const H = fitHomography(correspondences);
      return {
        ok: true,
        H,
        inverse: invert(H),
        rms: rmsError(H, correspondences),
        loo: leaveOneOutError(correspondences),
        res: residuals(H, correspondences),
      };
    } catch (err) {
      return { ok: false, problem: err instanceof CalibrationError ? err.message : "These points can't be fitted." };
    }
  }, [correspondences]);

  const quality = fit?.ok ? (fit.loo ?? fit.rms) : null;
  const sx = width / frames[frameIdx].width; // frames may be stored downscaled
  const r = Math.max(width, height) / 220; // marker size relative to the frame

  function place(landmark: string, at: Vec2) {
    if (!canEdit) return;
    const clamped: Vec2 = [Math.min(width, Math.max(0, at[0])), Math.min(height, Math.max(0, at[1]))];
    setPoints((p) => ({ ...p, [landmark]: clamped }));
    setError(null);
  }

  function onClick(e: React.MouseEvent<SVGSVGElement>) {
    const box = svgRef.current!.getBoundingClientRect();
    place(selected, [((e.clientX - box.left) / box.width) * width, ((e.clientY - box.top) / box.height) * height]);
  }

  function onKey(e: React.KeyboardEvent) {
    const p = points[selected];
    if (!p) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, Vec2> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      place(selected, [p[0] + moves[e.key][0], p[1] + moves[e.key][1]]);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setPoints((p) => without(p, selected));
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/orgs/${orgId}/matches/${matchId}/calibration`, {
        pitchLength: pitch.length,
        pitchWidth: pitch.width,
        points: correspondences.map((c) => ({ landmark: c.landmark, x: c.image[0], y: c.image[1] })),
      });
      router.push(backHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the calibration.");
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Frame:</span>
          {frames.map((f, i) => (
            <Button key={f.url} variant={i === frameIdx ? "primary" : "secondary"} onClick={() => setFrameIdx(i)} aria-pressed={i === frameIdx}>
              <span className="font-data">{Math.floor(f.timeSeconds / 60)}:{String(Math.round(f.timeSeconds % 60)).padStart(2, "0")}</span>
            </Button>
          ))}
          <span className="ml-auto" />
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
              className={`absolute inset-0 h-full w-full ${canEdit ? "cursor-crosshair" : ""}`}
              onClick={onClick}
              onKeyDown={onKey}
              tabIndex={0}
              role="application"
              aria-label="Video frame. Click to place the selected landmark; arrow keys nudge it, Shift for 10 pixels, Delete removes it."
            >
              {fit?.ok &&
                pitchSegments(pitch).map(([a, b], i) => {
                  const p = apply(fit.inverse, a);
                  const q = apply(fit.inverse, b);
                  return <line key={i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="var(--mindaro)" strokeWidth={r / 3} opacity={0.85} />;
                })}
              {correspondences.map((c, i) => {
                const isSel = c.landmark === selected;
                const res = fit?.ok ? fit.res[i] : undefined;
                const color = res === undefined ? "var(--white)" : res <= GOOD_M ? "var(--mindaro)" : res <= MAX_M ? "var(--gold)" : "var(--danger)";
                return (
                  <g key={c.landmark}>
                    <circle cx={c.image[0]} cy={c.image[1]} r={isSel ? r * 1.6 : r} fill="none" stroke={color} strokeWidth={r / 2.5} />
                    <circle cx={c.image[0]} cy={c.image[1]} r={r / 3} fill={color} />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
        <p className="text-xs text-muted">
          Frame resolution {width}×{height}
          {sx !== 1 ? " (shown downscaled)" : ""}. Lines are drawn from the fitted calibration: if they don&apos;t sit on
          the real pitch markings, a landmark is misplaced.
        </p>
      </div>

      <aside className="space-y-4">
        <Card className="p-4">
          <h2 className="font-semibold">Pitch size</h2>
          <p className="mt-1 text-xs text-muted">Use your real pitch dimensions: distances are only as accurate as these.</p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <label>
              Length (m)
              <input
                type="number"
                min={50}
                max={120}
                step={0.5}
                value={pitch.length}
                disabled={!canEdit}
                onChange={(e) => setPitch((p) => ({ ...p, length: Number(e.target.value) }))}
                className="font-data mt-1 w-full rounded-lg border border-border-strong bg-bg px-2 py-1.5"
              />
            </label>
            <label>
              Width (m)
              <input
                type="number"
                min={30}
                max={90}
                step={0.5}
                value={pitch.width}
                disabled={!canEdit}
                onChange={(e) => setPitch((p) => ({ ...p, width: Number(e.target.value) }))}
                className="font-data mt-1 w-full rounded-lg border border-border-strong bg-bg px-2 py-1.5"
              />
            </label>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Fit quality</h2>
            {quality !== null && <Badge tone={qualityTone(quality)}>{quality <= GOOD_M ? "Good" : quality <= MAX_M ? "Usable" : "Too inaccurate"}</Badge>}
          </div>
          {correspondences.length < 4 ? (
            <p className="mt-2 text-sm text-muted">Mark {4 - correspondences.length} more landmark{4 - correspondences.length === 1 ? "" : "s"}.</p>
          ) : fit && !fit.ok ? (
            <p className="mt-2 text-sm text-gold">{fit.problem}</p>
          ) : fit?.ok ? (
            <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted">Fit error</dt>
              <dd className="font-data text-right">{fit.rms.toFixed(2)} m</dd>
              <dt className="text-muted">Prediction error</dt>
              <dd className="font-data text-right">{fit.loo === null ? "needs 5+" : `${fit.loo.toFixed(2)} m`}</dd>
            </dl>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            Prediction error checks each landmark against a fit made without it. Under 1 m is good; over 3 m can&apos;t be saved.
          </p>
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold">Landmarks</h2>
          {canEdit && (
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" onClick={() => place(selected, [width / 2, height / 2])}>
                Place at centre
              </Button>
              {points[selected] && (
                <Button variant="ghost" onClick={() => setPoints((p) => without(p, selected))}>
                  Remove
                </Button>
              )}
            </div>
          )}
          <div className="mt-3 max-h-[42vh] space-y-3 overflow-y-auto pr-1">
            {GROUPS.map((g) => (
              <fieldset key={g}>
                <legend className="font-data text-[11px] uppercase tracking-widest text-muted">{g}</legend>
                <ul className="mt-1 space-y-0.5">
                  {LANDMARKS.filter((l) => l.group === g).map((l) => {
                    const idx = correspondences.findIndex((c) => c.landmark === l.id);
                    const res = idx >= 0 && fit?.ok ? fit.res[idx] : undefined;
                    return (
                      <li key={l.id}>
                        <label className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm ${selected === l.id ? "bg-accent-soft text-fg" : "hover:bg-surface-2"}`}>
                          <input type="radio" name="landmark" checked={selected === l.id} onChange={() => setSelected(l.id)} className="accent-[var(--mindaro)]" />
                          <span className="flex-1">{l.label.replace(/^(Left|Right) /, "")}</span>
                          {idx >= 0 && (
                            <span className={`font-data text-xs ${res === undefined ? "text-mindaro" : res <= GOOD_M ? "text-mindaro" : res <= MAX_M ? "text-gold" : "text-danger"}`}>
                              {res === undefined ? "✓" : `${res.toFixed(1)} m`}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
          </div>
        </Card>

        {error && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        {canEdit ? (
          <Button className="w-full" disabled={saving || quality === null || quality > MAX_M} onClick={save}>
            {saving ? "Saving…" : "Save calibration"}
          </Button>
        ) : (
          <p className="text-sm text-muted">Your role can view but not change the calibration.</p>
        )}
      </aside>
    </div>
  );
}
