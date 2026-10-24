import { describe, expect, it } from "vitest";
import { buildProfile, matchPerformance, normaliseHeatmap, type LinkedTrack, type MatchInput } from "./player-profile";
import type { ComponentKey, PlayerReport } from "./player-report";

function report(score: number | null, pct: Partial<Record<ComponentKey, number>>): PlayerReport {
  return {
    trackNo: 1,
    team: "a",
    zone: "middle third",
    minutes: 0,
    score,
    notScoredBecause: score == null ? "x" : null,
    components: (["workRate", "intensity", "speed", "sprints", "stamina"] as const).map((key) => ({ key, label: key, help: "", display: "", percentile: pct[key] ?? null })),
    strengths: [],
    weaknesses: [],
  };
}

function track(minutes: number, score: number | null, pct: Partial<Record<ComponentKey, number>>, extra: Partial<LinkedTrack["metrics"]> = {}, team: "a" | "b" = "a"): LinkedTrack {
  const heat = Array.from({ length: 14 }, () => Array(21).fill(0));
  heat[7][2] = 10; // near the left end of the pitch
  return { team, heatmap: heat, metrics: { minutes, distance_m: minutes * 100, hi_distance_m: minutes * 5, sprints: 3, top_speed_ms: 8, late_vs_early: 0.9, ...extra }, report: report(score, pct) };
}

function match(id: string, date: string, tracks: LinkedTrack[]): MatchInput {
  return { matchId: id, jobId: `j${id}`, title: `Match ${id}`, date, tracks };
}

describe("player profile", () => {
  it("adds up fragments of one player within a match, weighting the score by minutes", () => {
    const m = matchPerformance(match("1", "2026-09-01", [track(30, 80, { workRate: 90 }), track(10, 40, { workRate: 50 }, { top_speed_ms: 9 })]));
    expect(m.minutes).toBe(40);
    expect(m.distanceM).toBe(4000);
    expect(m.sprints).toBe(6);
    expect(m.topSpeedKmh).toBeCloseTo(32.4);
    expect(m.score).toBe(70); // (30 × 80 + 10 × 40) / 40
    expect(m.components.workRate).toBe(80);
  });

  it("totals, best top speed and a minutes-weighted average score across matches", () => {
    const p = buildProfile([
      match("1", "2026-09-01", [track(40, 60, { speed: 50 })]),
      match("2", "2026-09-08", [track(80, 90, { speed: 80 }, { top_speed_ms: 9.5 })]),
      match("3", "2026-09-15", [track(20, null, {})]),
    ]);
    expect(p.matches.map((m) => m.matchId)).toEqual(["3", "2", "1"]); // newest first
    expect(p.totals).toMatchObject({ matches: 3, minutes: 140, distanceKm: 14, metresPerMinute: 100, sprints: 9, topSpeedKmh: 34.2, topSpeedMatch: "Match 2", averageScore: 80, scoredMatches: 2 });
  });

  it("only calls something a strength when it holds across matches, and quotes the numbers", () => {
    const strongOnce = buildProfile([match("1", "2026-09-01", [track(40, 70, { sprints: 95 })]), match("2", "2026-09-08", [track(40, 70, { sprints: 40 })])]);
    expect(strongOnce.strengths.map((s) => s.key)).not.toContain("sprints");

    const p = buildProfile([
      match("1", "2026-09-01", [track(40, 70, { intensity: 85, speed: 20 })]),
      match("2", "2026-09-08", [track(40, 70, { intensity: 80, speed: 25 })]),
      match("3", "2026-09-15", [track(40, 70, { intensity: 70, speed: 30 })]),
    ]);
    expect(p.strengths).toContainEqual({ key: "intensity", text: "Strong high-intensity running: ranked 78/100 on average across 3 matches, top quarter in 2 of them." });
    expect(p.weaknesses).toContainEqual({ key: "speed", text: "Top speed to work on: ranked 25/100 on average across 3 matches, bottom quarter in 2 of them." });
  });

  it("spots improving form from the last three matches against the three before", () => {
    const scores = [40, 45, 42, 60, 62, 58]; // oldest → newest
    const p = buildProfile(scores.map((s, i) => match(String(i), `2026-09-0${i + 1}`, [track(40, s, {})])));
    expect(p.strengths).toContainEqual({ key: "form", text: "Improving: average score 60 in the last 3 matches, up from 42." });
  });

  it("orients every heatmap so the player attacks to the right", () => {
    const a = normaliseHeatmap(track(10, 50, {}).heatmap, "a");
    const b = normaliseHeatmap(track(10, 50, {}).heatmap, "b");
    expect(a[7][2]).toBeCloseTo(1); // team A attacks right: left end is their own end
    expect(b[7][18]).toBeCloseTo(1); // team B attacks left: mirrored
  });

  it("an empty profile has no numbers to show", () => {
    const p = buildProfile([]);
    expect(p.totals).toMatchObject({ matches: 0, averageScore: null, topSpeedMatch: null });
    expect(p.strengths).toEqual([]);
  });
});

describe("profile insights", () => {
  it("lists at most the three clearest strengths, form first", () => {
    const all = { workRate: 90, intensity: 95, speed: 80, sprints: 85, stamina: 75 };
    const scores = [40, 45, 42, 60, 62, 58];
    const p = buildProfile(scores.map((s, i) => match(String(i), `2026-09-0${i + 1}`, [track(40, s, all)])));
    expect(p.strengths).toHaveLength(3);
    expect(p.strengths[0].key).toBe("form");
    expect(p.strengths.slice(1).map((s) => s.key)).toEqual(["intensity", "workRate"]);
  });
});
