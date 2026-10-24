import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "../authz/permissions";
import type { DbOrTx } from "../db/client";
import { analysisJobs, analysisResults, analysisTracks, matches } from "../db/schema";
import { notFound } from "../http/errors";

export type Provenance = "measured" | "estimated" | "inferred" | "not_available";

const shape = z.object({ width: z.number(), depth: z.number(), line_height: z.number(), area: z.number(), players: z.number() }).nullable();

/** The analysis summary written by the worker. Parsed defensively: it crosses a process boundary. */
export const summarySchema = z.object({
  pipeline: z.string().nullable().optional(),
  models: z.record(z.string(), z.string()),
  settings: z.object({ sampleFps: z.number(), windowSeconds: z.number() }),
  pitch: z.object({ length: z.number(), width: z.number(), playersPerSide: z.number().default(11) }),
  provenance: z.record(z.string(), z.enum(["measured", "estimated", "inferred", "not_available"])),
  quality: z.object({
    calibration: z.object({ rmsErrorM: z.number().nullable().optional(), looErrorM: z.number().nullable().optional() }),
    // Older results (before small-sided support) only have the 16-people share.
    detection: z
      .object({
        framesAnalysed: z.number(),
        meanPeoplePerFrame: z.number(),
        minPeople: z.number().optional(),
        shareFramesUnderMinPeople: z.number().optional(),
        shareFramesUnder16People: z.number().optional(),
      })
      .transform((d) => ({
        framesAnalysed: d.framesAnalysed,
        meanPeoplePerFrame: d.meanPeoplePerFrame,
        minPeople: d.minPeople ?? 16,
        shareFramesUnderMinPeople: d.shareFramesUnderMinPeople ?? d.shareFramesUnder16People ?? 0,
      })),
    tracking: z.object({ tracks: z.number(), medianTrackSeconds: z.number(), meanCoverage: z.number(), tracksPerExpectedPerson: z.number() }),
    teams: z.object({ a: z.number(), b: z.number(), other: z.number(), separation: z.number().nullable().optional() }).passthrough(),
    teamShape: z.object({ windows: z.number(), windowsWithBothTeams: z.number() }),
    processingSeconds: z.number(),
  }),
  teamShape: z.array(z.object({ start: z.number(), end: z.number(), frames: z.number(), a: shape, b: shape })),
  durationSeconds: z.number(),
});
export type AnalysisSummary = z.infer<typeof summarySchema>;

/** Results of a succeeded analysis in the actor's organisation, or null if it has none. */
export async function getAnalysisResults(db: DbOrTx, actor: Actor, matchId: string, jobId: string) {
  assertCan(actor, "report.read");
  const [row] = await db
    .select({ summary: analysisResults.summary, createdAt: analysisResults.createdAt })
    .from(analysisResults)
    .innerJoin(analysisJobs, eq(analysisJobs.id, analysisResults.jobId))
    .innerJoin(matches, eq(matches.id, analysisResults.matchId))
    .where(
      and(
        eq(analysisResults.jobId, jobId),
        eq(analysisResults.matchId, matchId),
        eq(analysisResults.orgId, actor.orgId),
        eq(matches.orgId, actor.orgId),
        eq(analysisJobs.status, "succeeded"),
      ),
    );
  if (!row) throw notFound("Analysis");
  const summary = summarySchema.parse(row.summary);
  const tracks = await db
    .select({
      trackNo: analysisTracks.trackNo,
      team: analysisTracks.team,
      firstSeconds: analysisTracks.firstSeconds,
      lastSeconds: analysisTracks.lastSeconds,
      coverage: analysisTracks.coverage,
      avgX: analysisTracks.avgX,
      avgY: analysisTracks.avgY,
      distanceM: analysisTracks.distanceM,
      heatmap: analysisTracks.heatmap,
    })
    .from(analysisTracks)
    .where(and(eq(analysisTracks.jobId, jobId), eq(analysisTracks.orgId, actor.orgId)))
    .orderBy(asc(analysisTracks.trackNo));
  return { summary, tracks: tracks.map((t) => ({ ...t, heatmap: t.heatmap as number[][] })), createdAt: row.createdAt };
}

export type AnalysisResultsData = Awaited<ReturnType<typeof getAnalysisResults>>;
