/**
 * Animated drill diagrams: a top-down area in metres, fixed items (cones, gates, goals), players and
 * a ball, and a sequence of steps. Each step moves players and the ball and has a caption that
 * follows the drill's written steps. Pure data and geometry; rendering is in components/drill-diagram.
 */

export type Pt = readonly [number, number];
/** p = the player(s) doing the drill, o = opponents or attackers to defend against, n = partner or coach. */
export type Team = "p" | "o" | "n";

export type Item =
  | { kind: "cone"; at: Pt }
  | { kind: "gate"; a: Pt; b: Pt }
  | { kind: "goal"; at: Pt; facing: "left" | "right"; width: number }
  | { kind: "wall"; a: Pt; b: Pt }
  | { kind: "zone"; at: Pt; w: number; h: number; label?: string }
  | { kind: "line"; a: Pt; b: Pt }
  /** Full-size pitch markings; the diagram must be 105 × 68. */
  | { kind: "pitch" };

export type Style = "sprint" | "run" | "jog" | "walk";

export type Move =
  | { who: string; to: Pt; via?: Pt[]; style?: Style }
  /** `touch`: small touches (juggling) shown without a path. */
  | { ball: Pt; via?: Pt[]; kick?: "pass" | "shot" | "cross" | "touch" }
  /** The ball stays at this player's feet for the step. */
  | { carry: string }
  /** A scan: a sight line from the player to a point. */
  | { look: string; at: Pt };

export type Frame = { caption: string; seconds: number; moves: Move[] };

export type Diagram = {
  w: number;
  h: number;
  items: Item[];
  actors: Record<string, { team: Team; label?: string; at: Pt }>;
  ball?: Pt;
  frames: Frame[];
};

export type State = { actors: Record<string, Pt>; ball: Pt | null };

export const isActorMove = (m: Move): m is Extract<Move, { who: string }> => "who" in m;
export const isBallMove = (m: Move): m is Extract<Move, { ball: Pt }> => "ball" in m;
export const isCarry = (m: Move): m is Extract<Move, { carry: string }> => "carry" in m;
export const isLook = (m: Move): m is Extract<Move, { look: string }> => "look" in m;

/** Player radius in metres, so small grids and full pitches both read well. */
export function actorRadius(d: Pick<Diagram, "w" | "h">) {
  return Math.min(2.6, Math.max(0.45, Math.max(d.w, d.h) * 0.032));
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The point a share `t` (0–1) of the way along a polyline, by length. */
export function along(points: readonly Pt[], t: number): Pt {
  if (points.length === 1 || t <= 0) return points[0];
  const lens = points.slice(1).map((p, i) => dist(points[i], p));
  const total = lens.reduce((s, l) => s + l, 0);
  if (total === 0 || t >= 1) return points[points.length - 1];
  let left = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i]) {
      const k = lens[i] ? left / lens[i] : 0;
      const [a, b] = [points[i], points[i + 1]];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    left -= lens[i];
  }
  return points[points.length - 1];
}

/** Smooth start and stop, so runs look like people rather than sliders. */
export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function initialState(d: Diagram): State {
  return { actors: Object.fromEntries(Object.entries(d.actors).map(([k, a]) => [k, a.at])), ball: d.ball ?? null };
}

/** Where the ball sits when a player carries it: just ahead of them in the direction they move. */
function carried(d: Diagram, from: Pt, to: Pt, now: Pt): Pt {
  const r = actorRadius(d) * 1.25;
  const len = dist(from, to);
  const [dx, dy] = len > 0.01 ? [(to[0] - from[0]) / len, (to[1] - from[1]) / len] : [1, 0];
  return [now[0] + dx * r, now[1] + dy * r];
}

export type StepPath = { kind: "run" | "ball"; who: string | null; style: Style | "pass" | "shot" | "cross" | "touch"; points: Pt[] };

/** Paths of one step, from the state at its start. */
export function stepPaths(d: Diagram, start: State, frame: Frame): StepPath[] {
  return frame.moves.flatMap((m): StepPath[] => {
    if (isActorMove(m)) return [{ kind: "run" as const, who: m.who, style: m.style ?? "run", points: [start.actors[m.who], ...(m.via ?? []), m.to] }];
    if (isBallMove(m) && start.ball && m.kick !== "touch") return [{ kind: "ball" as const, who: null, style: m.kick ?? "pass", points: [start.ball, ...(m.via ?? []), m.ball] }];
    return [];
  });
}

/** Positions during step `i`, a share `p` (0–1) of the way through it. */
export function stateIn(d: Diagram, start: State, i: number, p: number): State {
  const frame = d.frames[i];
  const e = ease(p);
  const actors = { ...start.actors };
  let ball = start.ball;
  for (const m of frame.moves) if (isActorMove(m)) actors[m.who] = along([start.actors[m.who], ...(m.via ?? []), m.to], e);
  for (const m of frame.moves) {
    if (isBallMove(m) && start.ball) ball = along([start.ball, ...(m.via ?? []), m.ball], e);
    if (isCarry(m)) {
      const run = frame.moves.find((x) => isActorMove(x) && x.who === m.carry) as Extract<Move, { who: string }> | undefined;
      ball = carried(d, start.actors[m.carry], run?.to ?? start.actors[m.carry], actors[m.carry]);
    }
  }
  return { actors, ball };
}

/** The state at the start of every step (index = step), plus the end state. */
export function stepStarts(d: Diagram): State[] {
  const out = [initialState(d)];
  d.frames.forEach((_, i) => out.push(stateIn(d, out[i], i, 1)));
  return out;
}

/** Checks a diagram is self-consistent: known players, points inside the area, sensible steps. */
export function diagramProblems(d: Diagram): string[] {
  const out: string[] = [];
  const inside = (p: Pt) => p[0] >= -2 && p[0] <= d.w + 2 && p[1] >= -2 && p[1] <= d.h + 2;
  for (const [k, a] of Object.entries(d.actors)) if (!inside(a.at)) out.push(`${k} starts outside the area`);
  if (d.frames.length < 2 || d.frames.length > 6) out.push("needs 2 to 6 steps");
  d.frames.forEach((f, i) => {
    if (!f.caption || f.caption.length > 110) out.push(`step ${i + 1}: caption missing or too long`);
    if (f.seconds < 0.4 || f.seconds > 6) out.push(`step ${i + 1}: duration out of range`);
    for (const m of f.moves) {
      const who = isActorMove(m) ? m.who : isCarry(m) ? m.carry : isLook(m) ? m.look : null;
      if (who && !d.actors[who]) out.push(`step ${i + 1}: unknown player ${who}`);
      if (isBallMove(m) && !d.ball) out.push(`step ${i + 1}: ball move without a ball`);
      const pts = isActorMove(m) ? [m.to, ...(m.via ?? [])] : isBallMove(m) ? [m.ball, ...(m.via ?? [])] : isLook(m) ? [m.at] : [];
      if (!pts.every(inside)) out.push(`step ${i + 1}: point outside the area`);
    }
  });
  if (d.items.some((it) => it.kind === "pitch") && (d.w !== 105 || d.h !== 68)) out.push("pitch markings need a 105 × 68 area");
  return out;
}
