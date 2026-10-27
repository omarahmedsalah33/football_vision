import { describe, expect, it } from "vitest";
import { videoEventsSchema } from "@/lib/analysis/video-events";
import { workerRequest } from "@/server/jobs/worker-contract";

function result() {
  return {
    version: 1, durationSeconds: 180, completedWindows: 9, totalWindows: 9,
    policy: "Test fixture, not real analysis", models: { events: "gemini-3.8-flash" },
    catalog: [{ id: "Unknown1", description: "Test kit", photoKey: null }],
    players: [], events: [], audit: { reviewed: 0, candidates: 0, limit: 6 },
  };
}

describe("optional tracking result contract", () => {
  it("keeps existing Gemini–Astra reports readable", () => {
    expect(videoEventsSchema.parse(result()).tracking).toBeUndefined();
  });
  it("retains tracking diagnostics and separate original AI attribution", () => {
    const data = { ...result(), tracking: {
      enabled: true, method: "rfdetr-bytetrack-v1", sampleFps: 5, trackCount: 8,
      sceneCount: 1, anchoredTracks: 3, duplicateReferencesRemoved: 1,
      supportedEvents: 0, unresolvedEvents: 1, limitations: "No cross-cut identity or speed measurements",
    }, events: [{
      id: "w1-e1", actorId: null, geminiActorId: "Unknown1", type: "shot",
      start: 1, end: 2, key: 1.5, outcome: "goal", evidence: "Synthetic fixture",
      uncertainty: "Lost track", identityConfidence: "unassigned", eventConfidence: "high",
      evidenceLevel: "direct", included: false, matchIncluded: true, goalAccepted: true,
      exclusionReasons: ["Player assignment uncertain"], review: null,
      tracking: { trackId: "T9", status: "unanchored", suggestedActorId: null },
    }] };
    const parsed = videoEventsSchema.parse(data);
    expect(parsed.tracking?.duplicateReferencesRemoved).toBe(1);
    expect(parsed.events[0].tracking?.status).toBe("unanchored");
    expect(parsed.events[0].geminiActorId).toBe("Unknown1");
    expect(parsed.events[0].matchIncluded).toBe(true);
    expect(parsed.events[0].included).toBe(false);
    expect(videoEventsSchema.safeParse({ ...data, tracking: { ...data.tracking, trackCount: -1 } }).success).toBe(false);
  });
});

describe("backward-compatible action-first contract", () => {
  it("allows a match-only result with no invented player photos", () => {
    const manifest = { op: "outputs", workerId: "test-worker",
      jobId: "00000000-0000-4000-8000-000000000001", count: 0 };
    expect(workerRequest.safeParse(manifest).success).toBe(true);
    expect(workerRequest.safeParse({ ...manifest, count: -1 }).success).toBe(false);
  });
  it("retains canonical events, actor evidence and full-review audit through parsing", () => {
    const data = { ...result(), audit: { reviewed: 1, candidates: 1, limit: 1,
      actionFirst: true, catalogPolicy: "action-first-v1", catalogScope: "actors_of_detected_actions",
      reviewAllCanonicalActions: true, duplicateProposals: 1,
      identity: { targetedGroups: 1, lateLinkGroups: 0, assignedActions: 0, unresolvedActions: 1,
        referenceViews: 0, unresolvedReferences: [] },
    }, events: [{
      id: "w2-e1", canonicalEventId: "w1-e1", duplicateOf: "w1-e1",
      actorId: null, actorBox: [100,100,200,500], type: "pass",
      start: 1, end: 2, key: 1.5, outcome: "completed", evidence: "Synthetic fixture", uncertainty: "",
      identityConfidence: "unassigned", eventConfidence: "high", evidenceLevel: "direct",
      included: false, matchIncluded: false, goalAccepted: false,
      exclusionReasons: ["Overlapping event already counted"], review: null,
      actorAssignment: { status: "unresolved", method: "targeted_video", evidence: "Kit ambiguous",
        referenceSeconds: 1.5, referenceBox: [100,100,200,500] },
    }] };
    const parsed = videoEventsSchema.parse(data);
    expect(parsed.version).toBe(1);
    expect(parsed.audit.actionFirst).toBe(true);
    expect(parsed.audit.identity?.unresolvedActions).toBe(1);
    expect(parsed.events[0].duplicateOf).toBe("w1-e1");
    expect(parsed.events[0].actorAssignment?.evidence).toBe("Kit ambiguous");
    expect(videoEventsSchema.safeParse({ ...data, events: [{ ...data.events[0], actorBox: [0,0,1200,500] }] }).success).toBe(false);
  });
});
