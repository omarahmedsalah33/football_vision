import type { VideoEvents } from "./analysis/video-events";

export type GameAttribute = {
  key: "PAC" | "SHO" | "PAS" | "DRI" | "DEF" | "PHY";
  label: string; score: number; observations: number; baseline: boolean;
  explanation: string; eventIds: string[];
};
export type GameRatings = {
  version: 1; overall: number; attributes: GameAttribute[];
  confidence: "baseline" | "limited" | "developing";
  evidenceCount: number; disclaimer: string;
};
type Event = VideoEvents["events"][number];
const bounded = (n: number) => Math.round(Math.max(1, Math.min(99, n)));
const outcomeUsable = (e: Event) => e.review?.outcome !== "contradicted";
/** Versioned, deliberately conservative game rules, NOT trained ability estimates.
 * Four neutral pseudo-observations shrink tiny samples toward 50.
 * No cross-player leaderboard normalization; another player's upload cannot alter a score.
 */
export function buildGameRatings(input: Event[], durationSeconds: number): GameRatings {
  const seen = new Set<string>();
  const events = input.filter(e => {
    const id = e.canonicalEventId ?? e.id;
    if (!e.actorId || !e.included || e.matchIncluded === false || e.duplicateOf ||
      e.review?.action === "contradicted" || e.review?.identity === "contradicted" ||
      seen.has(id)) return false;
    seen.add(id); return true;
  });
  const minutes = Math.max(1, Number.isFinite(durationSeconds) ? durationSeconds / 60 : 1);
  const attr = (key: GameAttribute["key"], label: string, score: number, sample: Event[], explanation: string): GameAttribute =>
    ({ key, label, score: bounded(score), observations: sample.length, baseline: !sample.length,
      explanation: (!sample.length ? "Neutral baseline 50: no usable evidence. " : "") + explanation,
      eventIds: sample.map(e => e.id) });
  const rate = (sample: Event[], success: (e: Event) => boolean) =>
    1 + 98 * (sample.filter(success).length + 2) / (sample.length + 4);
  const passes = events.filter(e => e.type === "pass" && outcomeUsable(e) &&
    ["completed", "incomplete"].includes(e.outcome));
  const shots = events.filter(e => e.type === "shot" && outcomeUsable(e) &&
    (e.goalAccepted || ["on_target", "off_target"].includes(e.outcome)));
  const carries = events.filter(e => e.type === "carry");
  const takeOns = events.filter(e => e.type === "take_on" && outcomeUsable(e) &&
    ["completed", "incomplete", "won", "lost"].includes(e.outcome));
  const defensive = events.filter(e => ["tackle", "interception", "recovery"].includes(e.type) &&
    outcomeUsable(e) && ["won", "lost", "completed", "incomplete"].includes(e.outcome));
  const duels = events.filter(e => e.type === "duel");
  const wins = (e: Event) => e.outcome === "won" || e.outcome === "completed";
  const carrySeconds = Math.min(Math.max(0, durationSeconds), carries.reduce((n, e) => n + Math.min(15, Math.max(0, e.end - e.start)), 0));
  const activity = carrySeconds / minutes;
  const involvement = duels.length / minutes;
  const attributes: GameAttribute[] = [
    attr("PAC", "Carry activity proxy", 50 + 49 * activity / (activity + 6), carries,
      "50 + 49 × carry-seconds/min ÷ (carry-seconds/min + 6). Each episode capped at 15 seconds. NOT measured speed."),
    attr("SHO", "Shooting estimate", rate(shots, e => e.goalAccepted || e.outcome === "on_target"), shots,
      "1 + 98 × (on-target shots + 2) ÷ (known-outcome shots + 4). Accepted goals are on target; unknown outcomes excluded."),
    attr("PAS", "Passing estimate", rate(passes, e => e.outcome === "completed"), passes,
      "1 + 98 × (completed passes + 2) ÷ (known-outcome attempts + 4). Unknown or contradicted outcomes excluded; not an assist score."),
    attr("DRI", "Ball progression estimate", takeOns.length ? rate(takeOns, wins) :
      50 + 49 * (carries.length / minutes) / (carries.length / minutes + 2),
      takeOns.length ? takeOns : carries,
      takeOns.length ? "1 + 98 × (successful take-ons + 2) ÷ (known-outcome take-ons + 4)." :
        "Carry-frequency fallback: 50 + 49 × carries/min ÷ (carries/min + 2). Carries are NOT successful dribbles past opponents."),
    attr("DEF", "Defensive action estimate", rate(defensive, wins), defensive,
      "1 + 98 × (successful tackles/interceptions/recoveries + 2) ÷ (known-outcome attempts + 4). Missing older-analysis coverage stays baseline."),
    attr("PHY", "Duel involvement proxy", 50 + 49 * involvement / (involvement + 2), duels,
      "50 + 49 × duels/min ÷ (duels/min + 2). Participation proxy only; NOT strength, stamina, fitness or body-size assessment."),
  ];
  return { version: 1, attributes, overall: bounded(attributes.reduce((sum, a) => sum + a.score, 0) / 6),
    confidence: events.length === 0 ? "baseline" : events.length < 12 || durationSeconds < 300 ? "limited" : "developing",
    evidenceCount: events.length,
    disclaimer: "Game-style estimates, not measured ability. Overall is the equal-weight average of six attributes, including neutral 50 baselines. Short clips and missed actions limit reliability; no professional-player comparisons." };
}
