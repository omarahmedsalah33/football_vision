/**
 * A player's profile across matches: totals, form over time, and strengths or weaknesses that hold
 * up across several matches (one good game isn't a strength).
 *
 * Inputs are the per-match reports (player-report.ts) of the tracked players linked to this profile.
 * Everything stays "estimated": it is built from tracking only. Pure functions.
 */
import type { ComponentKey, PlayerMetrics, PlayerReport } from "./player-report";

/** Heatmaps are resampled to this grid, oriented so the player always attacks to the right. */
export const PROFILE_GRID = { nx: 21, ny: 14 } as const;

export type LinkedTrack = {
  team: "a" | "b" | "other";
  metrics: PlayerMetrics;
  heatmap: number[][];
  report: PlayerReport;
};

export type MatchInput = {
  matchId: string;
  jobId: string;
  title: string;
  date: string; // YYYY-MM-DD (played on, or analysed on)
  tracks: LinkedTrack[]; // one player can appear as several tracks (fragments) in one match
};

export type MatchPerformance = {
  matchId: string;
  jobId: string;
  title: string;
  date: string;
  team: "a" | "b" | "other";
  zone: string | null;
  minutes: number;
  distanceM: number;
  hiDistanceM: number;
  sprints: number;
  topSpeedKmh: number;
  lateVsEarly: number | null;
  score: number | null;
  components: Partial<Record<ComponentKey, number>>;
};

export type ProfileInsight = { text: string; key: ComponentKey | "form" | "stamina" };

export type PlayerProfileStats = {
  matches: MatchPerformance[]; // newest first
  totals: {
    matches: number;
    minutes: number;
    distanceKm: number;
    distancePerMatchKm: number;
    metresPerMinute: number;
    hiMetresPerMinute: number;
    sprints: number;
    sprintsPerMatch: number;
    topSpeedKmh: number;
    topSpeedMatch: string | null;
    averageScore: number | null;
    scoredMatches: number;
  };
  componentAverages: Partial<Record<ComponentKey, { average: number; matches: number }>>;
  strengths: ProfileInsight[];
  weaknesses: ProfileInsight[];
  heatmap: number[][]; // PROFILE_GRID, attacking to the right
};

const LABEL: Record<ComponentKey, string> = {
  workRate: "work rate",
  intensity: "high-intensity running",
  speed: "top speed",
  sprints: "sprinting",
  stamina: "stamina",
};

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Resamples a heatmap (rows = width cells, cols = length cells) to PROFILE_GRID, attacking right. */
export function normaliseHeatmap(heatmap: number[][], team: "a" | "b" | "other"): number[][] {
  const out = Array.from({ length: PROFILE_GRID.ny }, () => Array(PROFILE_GRID.nx).fill(0));
  const ny = heatmap.length;
  const nx = heatmap[0]?.length ?? 0;
  if (!ny || !nx) return out;
  const total = heatmap.flat().reduce((s, v) => s + v, 0) || 1;
  // Team A defends the left goal, so attacks right; team B attacks left: mirror it.
  const flip = team === "b";
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = heatmap[iy][ix];
      if (!v) continue;
      const fx = (ix + 0.5) / nx;
      const gx = Math.min(PROFILE_GRID.nx - 1, Math.floor((flip ? 1 - fx : fx) * PROFILE_GRID.nx));
      const gy = Math.min(PROFILE_GRID.ny - 1, Math.floor(((iy + 0.5) / ny) * PROFILE_GRID.ny));
      out[gy][gx] += v / total;
    }
  }
  return out;
}

/** One match: the linked tracks combined (fragments of the same person add up). */
export function matchPerformance(m: MatchInput): MatchPerformance {
  const minutes = m.tracks.reduce((s, t) => s + (t.metrics.minutes ?? 0), 0);
  const weight = (t: LinkedTrack) => (minutes > 0 ? (t.metrics.minutes ?? 0) / minutes : 1 / m.tracks.length);
  const scored = m.tracks.filter((t) => t.report.score != null);
  const scoredWeight = scored.reduce((s, t) => s + weight(t), 0);
  const components: Partial<Record<ComponentKey, number>> = {};
  for (const key of ["workRate", "intensity", "speed", "sprints", "stamina"] as const) {
    const vals = m.tracks
      .map((t) => ({ w: weight(t), p: t.report.components.find((c) => c.key === key)?.percentile }))
      .filter((v): v is { w: number; p: number } => v.p != null);
    const w = vals.reduce((s, v) => s + v.w, 0);
    if (vals.length && w > 0) components[key] = Math.round(vals.reduce((s, v) => s + v.w * v.p, 0) / w);
  }
  const longest = [...m.tracks].sort((a, b) => (b.metrics.minutes ?? 0) - (a.metrics.minutes ?? 0))[0];
  const late = m.tracks.map((t) => t.metrics.late_vs_early).filter((v): v is number => v != null);
  return {
    matchId: m.matchId,
    jobId: m.jobId,
    title: m.title,
    date: m.date,
    team: longest?.team ?? "other",
    zone: longest?.report.zone ?? null,
    minutes,
    distanceM: m.tracks.reduce((s, t) => s + (t.metrics.distance_m ?? 0), 0),
    hiDistanceM: m.tracks.reduce((s, t) => s + (t.metrics.hi_distance_m ?? 0), 0),
    sprints: m.tracks.reduce((s, t) => s + (t.metrics.sprints ?? 0), 0),
    topSpeedKmh: Math.max(0, ...m.tracks.map((t) => (t.metrics.top_speed_ms ?? 0) * 3.6)),
    lateVsEarly: late.length ? late.reduce((s, v) => s + v, 0) / late.length : null,
    score: scored.length ? Math.round(scored.reduce((s, t) => s + weight(t) * t.report.score!, 0) / scoredWeight) : null,
    components,
  };
}

export function buildProfile(inputs: MatchInput[]): PlayerProfileStats {
  const matches = inputs.map(matchPerformance).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const minutes = matches.reduce((s, m) => s + m.minutes, 0);
  const distance = matches.reduce((s, m) => s + m.distanceM, 0);
  const hi = matches.reduce((s, m) => s + m.hiDistanceM, 0);
  const sprints = matches.reduce((s, m) => s + m.sprints, 0);
  const fastest = matches.reduce<MatchPerformance | null>((best, m) => (!best || m.topSpeedKmh > best.topSpeedKmh ? m : best), null);
  const scored = matches.filter((m) => m.score != null);
  const scoredMinutes = scored.reduce((s, m) => s + m.minutes, 0);
  const n = matches.length;

  const componentAverages: PlayerProfileStats["componentAverages"] = {};
  for (const key of ["workRate", "intensity", "speed", "sprints", "stamina"] as const) {
    const vals = matches.map((m) => m.components[key]).filter((v): v is number => v != null);
    if (vals.length) componentAverages[key] = { average: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length), matches: vals.length };
  }

  const strengths: (ProfileInsight & { weight: number })[] = [];
  const weaknesses: (ProfileInsight & { weight: number })[] = [];
  for (const [key, v] of Object.entries(componentAverages) as [ComponentKey, { average: number; matches: number }][]) {
    if (v.matches < Math.min(2, n)) continue; // one good game isn't a strength
    const span = v.matches === 1 ? "in your only analysed match" : `on average across ${v.matches} matches`;
    const strongIn = matches.filter((m) => (m.components[key] ?? 0) >= 75).length;
    const weakIn = matches.filter((m) => m.components[key] != null && m.components[key]! <= 25).length;
    if (v.average >= 70) {
      strengths.push({ key, weight: v.average, text: `Strong ${LABEL[key]}: ranked ${v.average}/100 ${span}${v.matches > 1 ? `, top quarter in ${strongIn} of them` : ""}.` });
    } else if (v.average <= 30) {
      weaknesses.push({ key, weight: 100 - v.average, text: `${LABEL[key][0].toUpperCase()}${LABEL[key].slice(1)} to work on: ranked ${v.average}/100 ${span}${v.matches > 1 ? `, bottom quarter in ${weakIn} of them` : ""}.` });
    }
  }
  if (scored.length >= 4) {
    // Form: the last three scored matches against the three before them.
    const recent = scored.slice(0, 3).map((m) => m.score!);
    const before = scored.slice(3, 6).map((m) => m.score!);
    const a = recent.reduce((s, v) => s + v, 0) / recent.length;
    const b = before.reduce((s, v) => s + v, 0) / before.length;
    // Form changes lead the list: they're what a player most wants to know.
    if (a - b >= 8) strengths.push({ key: "form", weight: 1000, text: `Improving: average score ${Math.round(a)} in the last 3 matches, up from ${Math.round(b)}.` });
    if (b - a >= 8) weaknesses.push({ key: "form", weight: 1000, text: `Dipping: average score ${Math.round(a)} in the last 3 matches, down from ${Math.round(b)}.` });
  }

  const heat = Array.from({ length: PROFILE_GRID.ny }, () => Array(PROFILE_GRID.nx).fill(0));
  for (const input of inputs) {
    for (const t of input.tracks) {
      const grid = normaliseHeatmap(t.heatmap, t.team);
      const w = t.metrics.minutes ?? 0;
      grid.forEach((row, y) => row.forEach((v, x) => (heat[y][x] += v * w)));
    }
  }

  return {
    matches,
    totals: {
      matches: n,
      minutes: r1(minutes),
      distanceKm: r1(distance / 1000),
      distancePerMatchKm: n ? Math.round((distance / 1000 / n) * 100) / 100 : 0,
      metresPerMinute: minutes ? Math.round(distance / minutes) : 0,
      hiMetresPerMinute: minutes ? r1(hi / minutes) : 0,
      sprints,
      sprintsPerMatch: n ? r1(sprints / n) : 0,
      topSpeedKmh: fastest ? r1(fastest.topSpeedKmh) : 0,
      topSpeedMatch: fastest?.title ?? null,
      averageScore: scored.length ? Math.round(scored.reduce((s, m) => s + m.score! * m.minutes, 0) / (scoredMinutes || 1)) : null,
      scoredMatches: scored.length,
    },
    componentAverages,
    // The three clearest of each: a long list says less than a short one.
    strengths: strengths.sort((x, y) => y.weight - x.weight).slice(0, 3).map(({ key, text }) => ({ key, text })),
    weaknesses: weaknesses.sort((x, y) => y.weight - x.weight).slice(0, 3).map(({ key, text }) => ({ key, text })),
    heatmap: heat,
  };
}
