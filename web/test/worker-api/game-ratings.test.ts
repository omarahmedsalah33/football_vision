import { describe, expect, it } from "vitest";
import { buildGameRatings } from "@/lib/game-ratings";
import type { VideoEvents } from "@/lib/analysis/video-events";

type Event = VideoEvents["events"][number];
const event = (changes: Partial<Event> = {}): Event => ({ id: "e1", actorId: "Unknown1",
  type: "pass", start: 0, key: 1, end: 2, outcome: "completed", identityConfidence: "high",
  eventConfidence: "high", evidenceLevel: "direct", evidence: "Synthetic test", uncertainty: "",
  included: true, matchIncluded: true, goalAccepted: false, exclusionReasons: [], review: null, ...changes });
const score = (events: Event[], key: string) => buildGameRatings(events, 180).attributes.find(a => a.key === key)!;

describe("transparent game estimates", () => {
  it("uses explicitly labeled neutral baselines, never invented performance, for no evidence", () => {
    const r = buildGameRatings([], 180);
    expect(r.overall).toBe(50); expect(r.confidence).toBe("baseline");
    expect(r.attributes.every(a => a.baseline && a.score === 50 && !a.eventIds.length)).toBe(true);
  });
  it("shrinks one positive outcome to 60, not elite ability", () => {
    expect(score([event()], "PAS").score).toBe(60);
    expect(score([event({ outcome: "incomplete" })], "PAS").score).toBe(40);
    expect(buildGameRatings([event()], 180).confidence).toBe("limited");
  });
  it("excludes uncertain outcomes without discarding the action ledger", () => {
    expect(score([event({ outcome: "unknown" })], "PAS").baseline).toBe(true);
    expect(score([event({ review: { action: "supported", identity: "supported",
      outcome: "contradicted", comment: "No reception" } })], "PAS").baseline).toBe(true);
  });
  it("rejects excluded, duplicate, unassigned and explicitly contradicted actors", () => {
    const good = event();
    const bad = [event({ id:"x", included:false }), event({ id:"y", duplicateOf:"e1" }),
      event({ id:"z",actorId:null }),event({ id:"q",matchIncluded:false }),
      event({ id:"r",review:{action:"supported",identity:"contradicted",outcome:"supported",comment:"Wrong actor"} })];
    expect(buildGameRatings([good,...bad],180)).toEqual(buildGameRatings([good],180));
    expect(buildGameRatings([good,good],180).evidenceCount).toBe(1);
  });
  it("keeps older defense and physical estimates at baseline while recognizing new actions", () => {
    expect(score([event()], "DEF").baseline).toBe(true);
    expect(score([event()], "PHY").baseline).toBe(true);
    expect(score([event({ type:"tackle",outcome:"won" })], "DEF").score).toBe(60);
    expect(score([event({ type:"duel",outcome:"lost" })], "PHY").score).toBeGreaterThan(50);
  });
  it("does not silently call a carry a successful take-on or measured speed", () => {
    const carry = event({ type:"carry",outcome:"not_applicable",end:5 });
    expect(score([carry],"DRI").explanation).toContain("fallback");
    expect(score([carry],"PAC").explanation).toContain("NOT measured speed");
    expect(score([event({type:"take_on",outcome:"lost"})],"DRI").score).toBe(40);
  });
  it("only counts accepted goals or known shot outcomes as shooting evidence", () => {
    expect(score([event({type:"shot",outcome:"goal",goalAccepted:false})],"SHO").baseline).toBe(true);
    expect(score([event({type:"shot",outcome:"goal",goalAccepted:true})],"SHO").score).toBe(60);
  });
  it("stays bounded and deterministic, with event evidence attached", () => {
    const samples = Array.from({length:50},(_,i)=>event({id:`e${i}`}));
    const r=buildGameRatings(samples,600);
    expect(r).toEqual(buildGameRatings(samples,600));
    expect(r.attributes.every(a=>a.score>=1&&a.score<=99&&Number.isInteger(a.score))).toBe(true);
    expect(r.attributes.find(a=>a.key==="PAS")!.eventIds).toHaveLength(50);
  });
});
