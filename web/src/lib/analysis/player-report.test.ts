import { describe, expect, it } from "vitest";
import { buildReports, percentile, type TrackedPlayer } from "./player-report";

function player(trackNo: number, team: "a" | "b" | "other", avgX: number, m: Partial<TrackedPlayer["metrics"]>): TrackedPlayer {
  return {
    trackNo,
    team,
    avgX,
    avgY: 34,
    metrics: { minutes: 20, distance_per_min: 100, hi_per_min: 5, hi_distance_m: 100, top_speed_ms: 7, sprints: 4, sprints_per_10min: 2, late_vs_early: 0.9, ...m },
  };
}

const MATCH: TrackedPlayer[] = [
  player(1, "a", 4, { distance_per_min: 40 }), // keeper
  player(2, "a", 25, { distance_per_min: 130, hi_per_min: 12, hi_distance_m: 240, top_speed_ms: 8.6, sprints: 9, sprints_per_10min: 4.5, late_vs_early: 0.99 }),
  player(3, "a", 40, { distance_per_min: 90, hi_per_min: 2, hi_distance_m: 40, top_speed_ms: 6.1, sprints: 1, sprints_per_10min: 0.5, late_vs_early: 0.7 }),
  player(4, "b", 70, { distance_per_min: 110 }),
  player(5, "b", 60, { distance_per_min: 105, hi_per_min: 6 }),
  player(6, "b", 50, { distance_per_min: 100, hi_per_min: 4 }),
  player(7, "other", 52, { distance_per_min: 95 }), // referee
  player(8, "a", 50, { minutes: 1.5 }), // barely seen
];

describe("player reports", () => {
  const reports = new Map(buildReports(MATCH, 105).map((r) => [r.trackNo, r]));

  it("scores comparable outfield players out of 100 and explains every exclusion", () => {
    expect(reports.get(2)!.score).toBeGreaterThan(80);
    expect(reports.get(3)!.score).toBeLessThan(30);
    for (const n of [2, 3, 4, 5, 6]) expect(reports.get(n)!.score).toBeGreaterThanOrEqual(0);
    expect(reports.get(1)).toMatchObject({ zone: "goalkeeper", score: null, notScoredBecause: expect.stringContaining("Goalkeepers") });
    expect(reports.get(7)).toMatchObject({ score: null, notScoredBecause: expect.stringContaining("team") });
    expect(reports.get(8)).toMatchObject({ score: null, notScoredBecause: expect.stringContaining("Tracked for 1.5 min") });
  });

  it("quotes the evidence in every strength and weakness", () => {
    const strong = reports.get(2)!;
    expect(strong.strengths.join(" ")).toMatch(/130 m\/min/);
    expect(strong.strengths.join(" ")).toMatch(/31 km\/h/);
    expect(strong.strengths).toContain("Kept up the work rate to the end: 99% of the early pace in the last third of the time tracked.");
    const weak = reports.get(3)!;
    expect(weak.weaknesses).toContain("Work rate fell 30% in the last third of the time tracked.");
    expect(weak.weaknesses.join(" ")).toMatch(/Few sprints/);
    for (const r of reports.values()) for (const s of [...r.strengths, ...r.weaknesses]) expect(s).toMatch(/\d/);
  });

  it("places players by where they spent their time, from their own goal", () => {
    expect(reports.get(2)!.zone).toBe("defensive third"); // team A defends the left goal
    expect(reports.get(4)!.zone).toBe("middle third"); // team B at x = 70 is 35 m from its goal
  });

  it("refuses to score when too few players can be compared", () => {
    const few = buildReports(MATCH.slice(0, 3), 105);
    expect(few.every((r) => r.score === null)).toBe(true);
    expect(few[1].notScoredBecause).toMatch(/at least 4 players/);
  });

  it("uses midrank percentiles", () => {
    expect(percentile(5, [1, 5, 9])).toBe(50);
    expect(percentile(9, [1, 5, 9])).toBe(83);
  });
});
