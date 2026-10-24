/**
 * Development priorities: what to work on, the evidence for it, how sure we are, possible reasons,
 * relevant drills and a goal that can be checked later.
 *
 * Rule-based and reproducible. Drills come only from the curated library (starter or a coach's
 * own), chosen by the dimension of the weakness, never generated. Pure functions.
 */
import type { PlayerProfileStats } from "@/lib/analysis/player-profile";
import { dimensionByKey, METRICS, POSSIBLE_CAUSES, RATING_LABEL, type Dimension, type MetricKey } from "./framework";
import { drillsFor, type Drill } from "./drills";
import { defaultTarget, formatMetric, measuredBaseline, metricValue } from "./progress";

export type Confidence = "strong" | "moderate" | "limited";

export type Observation = { dimension: string; rating: number; source: "coach" | "self"; on: string; at: string; note: string | null };

export type Goal = { kind: "measured"; metric: MetricKey; baseline: number; baselineMatches: number; baselineMinutes: number; target: number; text: string } | { kind: "observed"; baseline: number; target: number; text: string };

export type Priority = {
  dimension: string;
  label: string;
  category: Dimension["category"];
  source: Dimension["source"];
  confidence: Confidence;
  finding: string;
  evidence: string[];
  causes: string[];
  drills: Drill[];
  goal: Goal;
  reviewWeeks: number;
  /** Higher = more pressing. */
  weight: number;
};

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { strong: 3, moderate: 2, limited: 1 };
export const CONFIDENCE_TEXT: Record<Confidence, string> = {
  strong: "Strong evidence: seen in 3 or more matches",
  moderate: "Moderate evidence",
  limited: "Limited evidence: one match or the player's own view",
};

/** Latest rating per dimension and source. */
export function latestRatings(observations: Observation[]) {
  const out = new Map<string, { coach?: Observation; self?: Observation }>();
  for (const o of [...observations].sort((a, b) => (a.on < b.on ? -1 : 1))) {
    const cur = out.get(o.dimension) ?? {};
    cur[o.source] = o;
    out.set(o.dimension, cur);
  }
  return out;
}

export function recommend(stats: PlayerProfileStats, observations: Observation[], library: Drill[], opts: { goalkeeper?: boolean } = {}): Priority[] {
  const out: Priority[] = [];
  const n = stats.matches.length;

  // Measured: physical components ranked low against comparable players. Goalkeepers aren't
  // compared on running.
  if (!opts.goalkeeper) {
    for (const d of [...dimensionByKey.values()].filter((x) => x.source === "measured")) {
      const c = stats.componentAverages[d.component!];
      if (!c) continue;
      const confidence: Confidence | null = c.matches >= 3 && c.average <= 35 ? "strong" : c.matches === 2 && c.average <= 35 ? "moderate" : c.matches === 1 && n === 1 && c.average <= 25 ? "limited" : null;
      if (!confidence) continue;
      const metric = d.metric!;
      const base = measuredBaseline(stats.matches, metric);
      if (!base) continue;
      const evidence = stats.matches
        .filter((m) => m.components[d.component!] != null)
        .slice(0, 5)
        .map((m) => {
          const v = metricValue(m, metric);
          return `${m.title} (${m.date}): ranked ${m.components[d.component!]}/100${v != null ? `, ${formatMetric(metric, v)}` : ""}`;
        });
      const target = defaultTarget(metric, base.value);
      out.push({
        dimension: d.key,
        label: d.label,
        category: d.category,
        source: "measured",
        confidence,
        finding: `${d.label} is low compared with the other players: ranked ${c.average}/100 ${c.matches === 1 ? "in the only analysed match" : `on average across ${c.matches} matches`}.`,
        evidence,
        causes: POSSIBLE_CAUSES[d.key] ?? [],
        drills: drillsFor(d.key, library),
        goal: {
          kind: "measured",
          metric,
          baseline: base.value,
          baselineMatches: base.matches,
          baselineMinutes: base.minutes,
          target,
          text: `${METRICS[metric].label}: from ${formatMetric(metric, base.value)} (average of ${base.matches} ${base.matches === 1 ? "match" : "matches"}) to ${formatMetric(metric, target)}, averaged over at least 2 matches.`,
        },
        reviewWeeks: 4,
        weight: (50 - c.average) * CONFIDENCE_WEIGHT[confidence],
      });
    }
  }

  // Observed: rated 1 or 2 out of 5. A coach's view counts for more than the player's own.
  for (const [dimension, r] of latestRatings(observations)) {
    const d = dimensionByKey.get(dimension);
    if (!d || d.source !== "observed") continue;
    const coachLow = r.coach && r.coach.rating <= 2;
    const selfLow = r.self && r.self.rating <= 2;
    if (!coachLow && !(selfLow && !r.coach)) continue;
    const main = coachLow ? r.coach! : r.self!;
    const confidence: Confidence = coachLow && selfLow ? "moderate" : coachLow ? "moderate" : "limited";
    const evidence = [r.coach, r.self]
      .filter((o): o is Observation => !!o)
      .map((o) => `${o.source === "coach" ? "Coach" : "Self"} rating ${o.rating}/5 (${RATING_LABEL[o.rating]}) on ${o.on}${o.note ? `: “${o.note}”` : ""}`);
    const target = Math.min(5, main.rating + 1);
    out.push({
      dimension,
      label: d.label,
      category: d.category,
      source: "observed",
      confidence,
      finding: `${d.label} rated ${main.rating}/5 by ${main.source === "coach" ? "a coach" : "the player"}: ${RATING_LABEL[main.rating].toLowerCase()}.`,
      evidence,
      causes: POSSIBLE_CAUSES[dimension] ?? [],
      drills: drillsFor(dimension, library),
      goal: { kind: "observed", baseline: main.rating, target, text: `Coach rating of at least ${target}/5 (${RATING_LABEL[target]}) at the review.` },
      reviewWeeks: 4,
      weight: (3 - main.rating) * 15 * CONFIDENCE_WEIGHT[confidence],
    });
  }

  // Physical numbers move together, so a slow match can flag all five at once. Keep the three
  // clearest of each kind so coach observations are never crowded out.
  const top = (source: Priority["source"]) => out.filter((p) => p.source === source).sort((a, b) => b.weight - a.weight).slice(0, 3);
  return [...top("measured"), ...top("observed")].sort((a, b) => b.weight - a.weight).slice(0, 5);
}
