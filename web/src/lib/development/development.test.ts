import { describe, expect, it } from "vitest";
import type { MatchPerformance, PlayerProfileStats } from "@/lib/analysis/player-profile";
import { DIMENSIONS, POSSIBLE_CAUSES } from "./framework";
import { drillsFor, STARTER_DRILLS } from "./drills";
import { defaultTarget, measuredBaseline, objectiveProgress, sessionsPlanned, weekStart } from "./progress";
import { recommend, type Observation } from "./recommend";

function perf(date: string, o: Partial<MatchPerformance> = {}): MatchPerformance {
  return {
    matchId: date,
    jobId: `j${date}`,
    title: `Match ${date}`,
    date,
    team: "a",
    zone: "middle third",
    minutes: 40,
    distanceM: 4000,
    hiDistanceM: 120,
    sprints: 4,
    topSpeedKmh: 27,
    lateVsEarly: 0.9,
    score: 50,
    components: {},
    ...o,
  };
}

function stats(matches: MatchPerformance[], componentAverages: PlayerProfileStats["componentAverages"]): PlayerProfileStats {
  return { matches, componentAverages, totals: {} as PlayerProfileStats["totals"], strengths: [], weaknesses: [], heatmap: [] };
}

describe("framework and library", () => {
  it("defines every dimension with a meaning, method and limitations, and says where its evidence comes from", () => {
    for (const d of DIMENSIONS) {
      expect(d.meaning.length).toBeGreaterThan(10);
      expect(d.method.length).toBeGreaterThan(5);
      expect(d.limitations.length).toBeGreaterThan(20);
      expect(POSSIBLE_CAUSES[d.key]?.length).toBeGreaterThan(0);
      if (d.source === "measured") expect(d.metric && d.component).toBeTruthy();
    }
  });

  it("has at least one drill for every dimension, simplest first", () => {
    for (const d of DIMENSIONS) expect(drillsFor(d.key, STARTER_DRILLS).length, d.key).toBeGreaterThan(0);
    const speed = drillsFor("sprints", STARTER_DRILLS);
    expect(speed[0].dimensions[0]).toBe("sprints");
  });
});

describe("recommendations", () => {
  const matches = [perf("2026-09-15", { components: { sprints: 20, workRate: 60 }, sprints: 2 }), perf("2026-09-08", { components: { sprints: 25, workRate: 55 }, sprints: 3 }), perf("2026-09-01", { components: { sprints: 30, workRate: 50 }, sprints: 2 })];

  it("turns a weakness seen across matches into a priority with evidence, causes, drills and a measurable goal", () => {
    const [p] = recommend(stats(matches, { sprints: { average: 25, matches: 3 }, workRate: { average: 55, matches: 3 } }), [], STARTER_DRILLS);
    expect(p.dimension).toBe("sprints");
    expect(p.confidence).toBe("strong");
    expect(p.evidence[0]).toBe("Match 2026-09-15 (2026-09-15): ranked 20/100, 3.0 per hour");
    expect(p.causes[0]).toMatch(/Role or tactics/);
    expect(p.drills.every((d) => d.dimensions.includes("sprints"))).toBe(true);
    expect(p.goal).toMatchObject({ kind: "measured", metric: "sprintsPerHour", baseline: 3.5, baselineMatches: 3, target: 5.2 });
  });

  it("doesn't call one weak match a strong pattern, and skips goalkeepers' running", () => {
    expect(recommend(stats(matches.slice(0, 1), { sprints: { average: 30, matches: 1 } }), [], STARTER_DRILLS)).toEqual([]);
    expect(recommend(stats(matches.slice(0, 1), { sprints: { average: 20, matches: 1 } }), [], STARTER_DRILLS)[0].confidence).toBe("limited");
    expect(recommend(stats(matches, { sprints: { average: 10, matches: 3 } }), [], STARTER_DRILLS, { goalkeeper: true })).toEqual([]);
  });

  it("uses coach ratings for things the video can't measure, and treats a self rating as weaker evidence", () => {
    const obs: Observation[] = [
      { dimension: "scanning", rating: 2, source: "coach", on: "2026-09-10", at: "2026-09-10T10:00:00Z", note: "Receives without checking" },
      { dimension: "firstTouch", rating: 1, source: "self", on: "2026-09-10", at: "2026-09-10T10:00:00Z", note: null },
      { dimension: "passing", rating: 2, source: "self", on: "2026-09-10", at: "2026-09-10T10:00:00Z", note: null },
      { dimension: "passing", rating: 4, source: "coach", on: "2026-09-12", at: "2026-09-12T10:00:00Z", note: null },
    ];
    const ps = recommend(stats([], {}), obs, STARTER_DRILLS);
    expect(ps.map((p) => [p.dimension, p.confidence])).toEqual([
      ["scanning", "moderate"],
      ["firstTouch", "limited"],
    ]); // passing: the coach rated it 4, so the low self rating doesn't make it a priority
    expect(ps[0].evidence[0]).toBe("Coach rating 2/5 (Below what the role needs) on 2026-09-10: “Receives without checking”");
    expect(ps[0].goal).toMatchObject({ kind: "observed", baseline: 2, target: 3 });
    expect(ps[0].drills[0].key).toBe("starter:scan-cue");
  });
});

describe("progress", () => {
  const base = { kind: "measured" as const, metric: "sprintsPerHour" as const, dimensionLabel: "Sprinting", baseline: 3.5, baselineMinutes: 40, target: 5.2, startsOn: "2026-10-01", createdAt: "2026-10-01T09:00:00Z" };

  it("baselines on matches before the plan and sets a reachable target", () => {
    const ms = [perf("2026-10-05", { sprints: 10 }), perf("2026-09-20", { sprints: 2 }), perf("2026-09-10", { sprints: 4 })];
    expect(measuredBaseline(ms, "sprintsPerHour", "2026-10-01")).toEqual({ value: 4.5, matches: 2, minutes: 40 });
    expect(defaultTarget("topSpeedKmh", 27.3)).toBe(28.3);
    expect(defaultTarget("staminaPercent", 96)).toBe(100);
  });

  it("waits for two follow-up matches before judging, and says when conditions differ", () => {
    expect(objectiveProgress(base, [perf("2026-09-20")], []).status).toBe("waiting");
    // A match on the start day belongs to the baseline, never to the follow-up.
    expect(objectiveProgress(base, [perf("2026-10-01", { sprints: 20 })], []).status).toBe("waiting");
    const one = objectiveProgress(base, [perf("2026-10-05", { sprints: 6 })], []);
    expect(one).toMatchObject({ status: "early", current: 9, evidence: 1 });
    const two = objectiveProgress(base, [perf("2026-10-05", { sprints: 4 }), perf("2026-10-12", { sprints: 4 })], []);
    expect(two).toMatchObject({ status: "reached", current: 6, change: 2.5 });
    const flat = objectiveProgress(base, [perf("2026-10-05", { sprints: 2, minutes: 35 }), perf("2026-10-12", { sprints: 2, minutes: 35 })], []);
    expect(flat.status).toBe("no_change");
    const short = objectiveProgress(base, [perf("2026-10-05", { minutes: 10, sprints: 1 }), perf("2026-10-12", { minutes: 10, sprints: 1 })], []);
    expect(short.caveat).toMatch(/Minutes on camera differ/);
  });

  it("judges observed objectives on the latest coach rating, falling back to the player's own view", () => {
    const o = { kind: "observed" as const, metric: null, dimensionLabel: "Scanning", baseline: 2, baselineMinutes: null, target: 3, startsOn: "2026-10-01", createdAt: "2026-10-01T09:00:00Z" };
    expect(objectiveProgress(o, [], [{ rating: 2, source: "coach", on: "2026-09-01", at: "2026-09-01T09:00:00Z" }]).status).toBe("waiting");
    // The rating the plan was built from (made just before it) isn't progress.
    expect(objectiveProgress(o, [], [{ rating: 4, source: "coach", on: "2026-10-01", at: "2026-10-01T08:59:00Z" }]).status).toBe("waiting");
    const self = objectiveProgress(o, [], [{ rating: 3, source: "self", on: "2026-10-10", at: "2026-10-10T09:00:00Z" }]);
    expect(self).toMatchObject({ status: "reached" });
    expect(self.caveat).toMatch(/own view/);
    const coach = objectiveProgress(o, [], [{ rating: 4, source: "self", on: "2026-10-12", at: "2026-10-12T09:00:00Z" }, { rating: 2, source: "coach", on: "2026-10-10", at: "2026-10-10T09:00:00Z" }]);
    expect(coach.status).toBe("no_change");
  });

  it("counts planned sessions per week, including the week in progress", () => {
    expect(sessionsPlanned("2026-10-01", "2026-10-01", 3)).toBe(3);
    expect(sessionsPlanned("2026-10-01", "2026-10-08", 3)).toBe(6);
    expect(sessionsPlanned("2026-10-01", "2026-12-01", 2, "2026-10-14")).toBe(4);
    expect(sessionsPlanned("2026-10-05", "2026-10-01", 2)).toBe(0);
    expect(weekStart("2026-10-24")).toBe("2026-10-19");
  });
});
