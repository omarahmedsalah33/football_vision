/**
 * Measuring change. Two separate questions, never merged into one number:
 * - Was the training done? (sessions logged against sessions planned)
 * - Did the skill change? (follow-up matches or coach ratings against the baseline)
 * Pure functions.
 */
import type { MatchPerformance } from "@/lib/analysis/player-profile";
import { METRICS, type MetricKey } from "./framework";

/** Matches with fewer minutes tracked than this don't count as evidence. */
export const MIN_MINUTES = 5;

/** Changes smaller than this are within the measurement noise of one match. */
export const NOISE: Record<MetricKey, number> = { metresPerMinute: 3, hiMetresPerMinute: 1, topSpeedKmh: 0.5, sprintsPerHour: 1, staminaPercent: 3 };

export function metricValue(m: MatchPerformance, metric: MetricKey): number | null {
  if (m.minutes < MIN_MINUTES) return null;
  switch (metric) {
    case "metresPerMinute":
      return m.distanceM / m.minutes;
    case "hiMetresPerMinute":
      return m.hiDistanceM / m.minutes;
    case "topSpeedKmh":
      return m.topSpeedKmh > 0 ? m.topSpeedKmh : null;
    case "sprintsPerHour":
      return (m.sprints / m.minutes) * 60;
    case "staminaPercent":
      return m.lateVsEarly == null ? null : m.lateVsEarly * 100;
  }
}

export function formatMetric(metric: MetricKey, v: number) {
  const d = METRICS[metric];
  return `${v.toFixed(d.digits)} ${d.unit}`;
}

const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
const round = (v: number, digits: number) => Number(v.toFixed(digits));

/**
 * Baseline: the average over the last few matches (up to 5) played on or before `upTo`. Evidence
 * is split by day: baseline matches are on or before the plan's start day, follow-ups after it, so
 * no match ever counts as both.
 */
export function measuredBaseline(matches: MatchPerformance[], metric: MetricKey, upTo?: string) {
  const usable = matches
    .filter((m) => !upTo || m.date <= upTo)
    .map((m) => ({ m, v: metricValue(m, metric) }))
    .filter((x): x is { m: MatchPerformance; v: number } => x.v != null)
    .sort((a, b) => (a.m.date < b.m.date ? 1 : -1))
    .slice(0, 5);
  if (!usable.length) return null;
  return {
    value: round(avg(usable.map((x) => x.v)), METRICS[metric].digits),
    matches: usable.length,
    minutes: round(avg(usable.map((x) => x.m.minutes)), 1),
  };
}

/** A realistic first target: a step a player can reach in a few weeks, not a leap. */
export function defaultTarget(metric: MetricKey, baseline: number) {
  const t = {
    metresPerMinute: baseline * 1.05,
    hiMetresPerMinute: baseline * 1.15 + 0.5,
    topSpeedKmh: baseline + 1,
    sprintsPerHour: baseline * 1.2 + 1,
    staminaPercent: Math.min(100, baseline + 8),
  }[metric];
  return round(t, METRICS[metric].digits);
}

export type ProgressStatus = "waiting" | "early" | "reached" | "improving" | "no_change" | "declined";

export type Progress = {
  status: ProgressStatus;
  current: number | null;
  change: number | null;
  evidence: number; // follow-up matches or ratings
  text: string;
  caveat: string | null;
};

export type ObjectiveForProgress = {
  kind: "measured" | "observed";
  metric: MetricKey | null;
  dimensionLabel: string;
  baseline: number | null;
  baselineMinutes: number | null;
  target: number | null;
  startsOn: string; // YYYY-MM-DD
  /** When the plan was made (ISO timestamp): ratings after this are follow-ups. */
  createdAt: string;
};

/** `at`: when the rating was recorded (ISO timestamp); `on`: the day it refers to. */
export type RatingForProgress = { rating: number; source: "coach" | "self"; on: string; at: string };

export function objectiveProgress(o: ObjectiveForProgress, matches: MatchPerformance[], ratings: RatingForProgress[]): Progress {
  if (o.kind === "measured" && o.metric) {
    const metric = o.metric;
    const follow = matches.filter((m) => m.date > o.startsOn).map((m) => ({ m, v: metricValue(m, metric) })).filter((x): x is { m: MatchPerformance; v: number } => x.v != null);
    if (!follow.length) return { status: "waiting", current: null, change: null, evidence: 0, text: "No match played since the plan started. Upload the next match to measure progress.", caveat: null };
    const current = round(avg(follow.map((x) => x.v)), METRICS[metric].digits);
    const change = o.baseline == null ? null : round(current - o.baseline, METRICS[metric].digits);
    const minutes = avg(follow.map((x) => x.m.minutes));
    const caveat =
      o.baselineMinutes && (minutes < o.baselineMinutes * 0.5 || minutes > o.baselineMinutes * 2)
        ? "Minutes on camera differ a lot from the baseline matches, so compare with care."
        : null;
    const now = `${formatMetric(metric, current)} in ${follow.length} ${follow.length === 1 ? "match" : "matches"} since the plan started`;
    const from = o.baseline == null ? "" : `, from ${formatMetric(metric, o.baseline)}`;
    if (follow.length === 1) return { status: "early", current, change, evidence: 1, text: `${now}${from}. One match isn't enough to judge: wait for a second.`, caveat };
    if (o.target != null && current >= o.target) return { status: "reached", current, change, evidence: follow.length, text: `Target reached: ${now}${from}.`, caveat };
    if (change != null && change > NOISE[metric]) return { status: "improving", current, change, evidence: follow.length, text: `Improving: ${now}${from}.`, caveat };
    if (change != null && change < -NOISE[metric]) return { status: "declined", current, change, evidence: follow.length, text: `Lower than the baseline: ${now}${from}.`, caveat };
    return { status: "no_change", current, change, evidence: follow.length, text: `No clear change yet: ${now}${from}.`, caveat };
  }

  // Observed: the latest coach rating after the start; a self rating only if no coach has rated.
  const after = ratings.filter((r) => r.at > o.createdAt).sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : a.at < b.at ? 1 : -1));
  const latest = after.find((r) => r.source === "coach") ?? after[0];
  if (!latest) return { status: "waiting", current: null, change: null, evidence: 0, text: `No new rating of ${o.dimensionLabel.toLowerCase()} since the plan started. Rate it again at the review.`, caveat: null };
  const who = latest.source === "coach" ? "Coach" : "Self";
  const caveat = latest.source === "self" ? "This is the player's own view; a coach rating is stronger evidence." : null;
  const change = o.baseline == null ? null : latest.rating - o.baseline;
  const text = `${who} rating ${latest.rating}/5 on ${latest.on}${o.baseline != null ? `, from ${o.baseline}/5` : ""}.`;
  if (o.target != null && latest.rating >= o.target) return { status: "reached", current: latest.rating, change, evidence: after.length, text: `Target reached. ${text}`, caveat };
  if (change != null && change > 0) return { status: "improving", current: latest.rating, change, evidence: after.length, text: `Improving. ${text}`, caveat };
  if (change != null && change < 0) return { status: "declined", current: latest.rating, change, evidence: after.length, text: `Lower than before. ${text}`, caveat };
  return { status: "no_change", current: latest.rating, change, evidence: after.length, text: `No change yet. ${text}`, caveat };
}

/** Sessions expected so far: so many per week, counting the week in progress. */
export function sessionsPlanned(startsOn: string, today: string, perWeek: number, until?: string) {
  const end = until && until < today ? until : today;
  const days = Math.floor((Date.parse(end) - Date.parse(startsOn)) / 86_400_000);
  if (days < 0) return 0;
  return perWeek * (Math.floor(days / 7) + 1);
}

/** Monday of the week containing `day` (UTC), YYYY-MM-DD. */
export function weekStart(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
