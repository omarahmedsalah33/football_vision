/**
 * Player reports from tracking data: a physical score out of 100, strengths and weaknesses.
 *
 * Everything here is relative to the other players in the same match and built only from tracked
 * movement (no ball events), so it is labelled "estimated". Every strength or weakness quotes the
 * number it comes from. Pure functions: the same input always gives the same report.
 */

export type PlayerMetrics = {
  minutes?: number;
  distance_m?: number;
  distance_per_min?: number;
  hi_distance_m?: number;
  hi_per_min?: number;
  sprints?: number;
  sprints_per_10min?: number;
  top_speed_ms?: number;
  late_vs_early?: number | null;
  fragments?: number;
};

export type TrackedPlayer = {
  trackNo: number;
  team: "a" | "b" | "other";
  avgX: number | null;
  avgY: number | null;
  metrics: PlayerMetrics;
};

export type ComponentKey = "workRate" | "intensity" | "speed" | "sprints" | "stamina";

export type Component = {
  key: ComponentKey;
  label: string;
  help: string;
  /** Shown to the user, e.g. "118 m/min". */
  display: string;
  /** 0–100 among comparable players in this match; null when it can't be judged. */
  percentile: number | null;
};

export type Zone = "goalkeeper" | "defensive third" | "middle third" | "attacking third";

export type PlayerReport = {
  trackNo: number;
  team: "a" | "b" | "other";
  zone: Zone | null;
  minutes: number;
  /** Out of 100, or null with the reason. */
  score: number | null;
  notScoredBecause: string | null;
  components: Component[];
  strengths: string[];
  weaknesses: string[];
};

export const MIN_COMPARABLE_PLAYERS = 4;
const STRONG = 75;
const WEAK = 25;

const kmh = (ms: number) => ms * 3.6;
const round = (v: number, digits = 0) => Number(v.toFixed(digits));

/** Midrank percentile of `value` among `values` (0–100). */
export function percentile(value: number, values: number[]): number {
  const below = values.filter((v) => v < value).length;
  const equal = values.filter((v) => v === value).length;
  return Math.round(((below + 0.5 * equal) / values.length) * 100);
}

function topShare(p: number) {
  const share = Math.max(5, Math.round((100 - p) / 5) * 5);
  return `top ${share}% in this match`;
}

/** Where on the pitch the player spent their time, from their own goal. Team A defends the left goal. */
export function zoneOf(p: TrackedPlayer, pitchLength: number): Zone | null {
  if (p.avgX == null || p.team === "other") return null;
  const depth = (p.team === "a" ? p.avgX : pitchLength - p.avgX) / pitchLength;
  if (depth < 0.12) return "goalkeeper";
  if (depth < 1 / 3) return "defensive third";
  if (depth < 2 / 3) return "middle third";
  return "attacking third";
}

export function buildReports(players: TrackedPlayer[], pitchLength: number): PlayerReport[] {
  const outfield = players.filter((p) => p.team !== "other");
  const longest = Math.max(0, ...outfield.map((p) => p.metrics.minutes ?? 0));
  // Enough time on camera to compare fairly: 5 minutes, or 30 % of the longest-tracked player in short clips.
  const minMinutes = Math.max(0.5, Math.min(5, 0.3 * longest));
  const zones = new Map(players.map((p) => [p.trackNo, zoneOf(p, pitchLength)]));
  // Only the deepest player of each team can be its goalkeeper.
  for (const team of ["a", "b"] as const) {
    const keepers = outfield.filter((p) => p.team === team && zones.get(p.trackNo) === "goalkeeper");
    const deepest = keepers.sort((a, b) => (team === "a" ? (a.avgX ?? 0) - (b.avgX ?? 0) : (b.avgX ?? 0) - (a.avgX ?? 0)))[0];
    for (const k of keepers) if (k !== deepest) zones.set(k.trackNo, "defensive third");
  }
  const comparable = outfield.filter((p) => (p.metrics.minutes ?? 0) >= minMinutes && zones.get(p.trackNo) !== "goalkeeper");
  const enough = comparable.length >= MIN_COMPARABLE_PLAYERS;

  const series = {
    workRate: comparable.map((p) => p.metrics.distance_per_min ?? 0),
    intensity: comparable.map((p) => p.metrics.hi_per_min ?? 0),
    speed: comparable.map((p) => p.metrics.top_speed_ms ?? 0),
    sprints: comparable.map((p) => p.metrics.sprints_per_10min ?? 0),
    stamina: comparable.map((p) => p.metrics.late_vs_early).filter((v): v is number => v != null),
  };

  return players.map((p) => {
    const m = p.metrics;
    const zone = zones.get(p.trackNo) ?? null;
    const minutes = m.minutes ?? 0;
    const isComparable = comparable.includes(p);
    const pct = (key: keyof typeof series, v: number | null | undefined) =>
      isComparable && enough && v != null && series[key].length >= MIN_COMPARABLE_PLAYERS ? percentile(v, series[key]) : null;

    const components: Component[] = [
      {
        key: "workRate",
        label: "Work rate",
        help: "Distance covered per minute while on camera.",
        display: `${round(m.distance_per_min ?? 0)} m/min`,
        percentile: pct("workRate", m.distance_per_min),
      },
      {
        key: "intensity",
        label: "High-intensity running",
        help: "Distance covered faster than 20 km/h, per minute.",
        display: `${round(m.hi_per_min ?? 0, 1)} m/min`,
        percentile: pct("intensity", m.hi_per_min),
      },
      {
        key: "speed",
        label: "Top speed",
        help: "Fastest one-second average speed.",
        display: `${round(kmh(m.top_speed_ms ?? 0), 1)} km/h`,
        percentile: pct("speed", m.top_speed_ms),
      },
      {
        key: "sprints",
        label: "Sprints",
        help: "Runs faster than 25 km/h lasting at least a second, per 10 minutes.",
        display: `${m.sprints ?? 0} (${round(m.sprints_per_10min ?? 0, 1)} per 10 min)`,
        percentile: pct("sprints", m.sprints_per_10min),
      },
      {
        key: "stamina",
        label: "Stamina",
        help: "Work rate in the last third of the time tracked, compared with the first third.",
        display: m.late_vs_early == null ? "Not enough time tracked" : `${m.late_vs_early >= 1 ? "+" : "−"}${round(Math.abs(m.late_vs_early - 1) * 100)}% late on`,
        percentile: pct("stamina", m.late_vs_early),
      },
    ];

    const scored = components.filter((c) => c.percentile != null);
    let notScoredBecause: string | null = null;
    if (p.team === "other") notScoredBecause = "Not assigned to a team (official, or shirt colour unclear).";
    else if (zone === "goalkeeper") notScoredBecause = "Goalkeepers aren't compared with outfield running numbers.";
    else if (!isComparable) notScoredBecause = `Tracked for ${round(minutes, 1)} min; at least ${round(minMinutes, 1)} min is needed to compare fairly.`;
    else if (!enough) notScoredBecause = `Needs at least ${MIN_COMPARABLE_PLAYERS} players tracked long enough to compare.`;
    const score = notScoredBecause || scored.length === 0 ? null : Math.round(scored.reduce((s, c) => s + c.percentile!, 0) / scored.length);

    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const c = Object.fromEntries(components.map((x) => [x.key, x])) as Record<ComponentKey, Component>;
    if (score != null) {
      const hi = (k: ComponentKey) => (c[k].percentile ?? 50) >= STRONG;
      const lo = (k: ComponentKey) => (c[k].percentile ?? 50) <= WEAK;
      if (hi("workRate")) strengths.push(`Covers a lot of ground: ${c.workRate.display}, ${topShare(c.workRate.percentile!)}.`);
      if (lo("workRate")) weaknesses.push(`Covers less ground than most players here: ${c.workRate.display}.`);
      if (hi("intensity")) strengths.push(`Lots of high-intensity running: ${round(m.hi_distance_m ?? 0)} m above 20 km/h.`);
      if (lo("intensity")) weaknesses.push(`Little high-intensity running: ${round(m.hi_distance_m ?? 0)} m above 20 km/h.`);
      if (hi("speed")) strengths.push(`Quick: reached ${c.speed.display}, ${topShare(c.speed.percentile!)}.`);
      if (lo("speed")) weaknesses.push(`Top speed of ${c.speed.display} is lower than most players here.`);
      if (hi("sprints")) strengths.push(`Sprints often: ${c.sprints.display}.`);
      if (lo("sprints")) weaknesses.push(`Few sprints: ${c.sprints.display}.`);
    }
    if (zone !== "goalkeeper" && p.team !== "other" && m.late_vs_early != null) {
      if (m.late_vs_early < 0.8) weaknesses.push(`Work rate fell ${round((1 - m.late_vs_early) * 100)}% in the last third of the time tracked.`);
      else if (m.late_vs_early >= 0.97) strengths.push(`Kept up the work rate to the end: ${round(m.late_vs_early * 100)}% of the early pace in the last third of the time tracked.`);
    }

    return { trackNo: p.trackNo, team: p.team, zone, minutes, score, notScoredBecause, components, strengths, weaknesses };
  });
}
