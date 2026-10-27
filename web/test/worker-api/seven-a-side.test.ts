import { describe, expect, it } from "vitest";
import { buildSevenAsideStats, lineupInputSchema, linksForJob, sevenAsideUpdateSchema,
  type SevenAsideExperience } from "@/lib/seven-a-side";
import { videoEventsSchema } from "@/lib/analysis/video-events";
import { updateSevenAside } from "@/server/matches/seven-a-side";
import type { Actor } from "@/server/authz/permissions";
import type { DbOrTx } from "@/server/db/client";

const lineup = { teamAName: "Friends", teamBName: "Rivals",
  players: [{ id: "a1", team: "a", name: "Test Striker", shirtNumber: 9 },
    { id: "b1", team: "b", name: "Test Keeper", shirtNumber: 9 }] };
const experience: SevenAsideExperience = { ...lineupInputSchema.parse(lineup), version: 1,
  assignmentJobId: "job-one", assignments: { Unknown1: "a1", Unknown2: "a1" } };
const event = { id: "e1", actorId: "Unknown1", type: "shot", outcome: "goal", start: 1, end: 2, key: 1.5,
  identityConfidence: "high", eventConfidence: "high", evidenceLevel: "direct", evidence: "Synthetic",
  uncertainty: "", included: true, matchIncluded: true, goalAccepted: true, exclusionReasons: [], review: null };
const data = videoEventsSchema.parse({ version: 1, durationSeconds: 180, completedWindows: 9, totalWindows: 9,
  policy: "Synthetic test", models: {}, catalog: [
    { id: "Unknown1", description: "Test kit", photoKey: null },
    { id: "Unknown2", description: "Another view", photoKey: null },
  ], players: [], events: [event], audit: { reviewed: 1, candidates: 1, limit: 12, reviewStrategy: "selective" } });

describe("7-a-side lineup contract", () => {
  it("allows the same shirt number on opposite teams, but not within one team", () => {
    expect(lineupInputSchema.safeParse(lineup).success).toBe(true);
    expect(lineupInputSchema.safeParse({ ...lineup, players: [...lineup.players,
      { id: "a2", team: "a", name: "Duplicate number", shirtNumber: 9 }] }).success).toBe(false);
  });
  it("rejects duplicate slots, wrong teams and more than fourteen players", () => {
    expect(lineupInputSchema.safeParse({ ...lineup, players: [lineup.players[0], lineup.players[0]] }).success).toBe(false);
    expect(lineupInputSchema.safeParse({ ...lineup, players: [{ ...lineup.players[0], team: "b" }] }).success).toBe(false);
    expect(lineupInputSchema.safeParse({ ...lineup, players: Array(15).fill(lineup.players[0]) }).success).toBe(false);
  });
  it("allows incomplete drafts and blank numbers, but rejects blank names and invalid numbers", () => {
    expect(lineupInputSchema.safeParse({ ...lineup, players: [] }).success).toBe(true);
    expect(lineupInputSchema.safeParse({ ...lineup, players: [{ ...lineup.players[0], shirtNumber: null }] }).success).toBe(true);
    for (const override of [{ name: " " }, { shirtNumber: 100 }, { shirtNumber: -1 }, { shirtNumber: 1.5 }]) {
      expect(lineupInputSchema.safeParse({ ...lineup, players: [{ ...lineup.players[0], ...override }] }).success).toBe(false);
    }
  });
  it("bounds reference IDs and accepts explicit unlinking", () => {
    const input = { op: "assignment", jobId: "00000000-0000-4000-8000-000000000001", canonicalId: "Unknown24", playerId: null };
    expect(sevenAsideUpdateSchema.safeParse(input).success).toBe(true);
    expect(sevenAsideUpdateSchema.safeParse({ ...input, canonicalId: "Unknown25" }).success).toBe(false);
    expect(sevenAsideUpdateSchema.safeParse({ ...input, playerId: "a8" }).success).toBe(false);
  });
});

describe("conservative named-player statistics", () => {
  it("consolidates multiple references without double-counting duplicate events", () => {
    const updated = { ...data, events: [data.events[0], { ...data.events[0], id: "e2", actorId: "Unknown2",
      duplicateOf: "e1", included: false, matchIncluded: false, goalAccepted: false }] };
    const stats = buildSevenAsideStats(updated, experience, "job-one");
    expect(stats[0]).toMatchObject({ linked: true, goals: 1, shots: 1, canonicalIds: ["Unknown1", "Unknown2"] });
    expect(stats[0].highlights).toHaveLength(1);
    expect(stats[1].linked).toBe(false);
  });
  it("does not promote excluded or unassigned actions by giving a player a name", () => {
    const updated = { ...data, events: [{ ...data.events[0], included: false },
      { ...data.events[0], id: "e2", actorId: null }] };
    expect(buildSevenAsideStats(updated, experience, "job-one")[0].goals).toBe(0);
  });
  it("never transfers Unknown labels from a previous analysis job", () => {
    expect(linksForJob(experience, "another-job")).toEqual({});
    expect(buildSevenAsideStats(data, experience, "another-job")[0].linked).toBe(false);
  });
  it("rejects player-role edits before touching the database", async () => {
    const actor = { orgId: "org", userId: "user", orgSlug: "org", role: "player" } as Actor;
    await expect(updateSevenAside({} as DbOrTx, actor, "match",
      { op: "lineup", lineup: lineupInputSchema.parse(lineup) })).rejects.toMatchObject({ status: 403 });
  });
});
