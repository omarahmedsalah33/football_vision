import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { sevenAsideUpdateSchema, type SevenAsideExperience } from "@/lib/seven-a-side";
import { videoEventsSchema } from "@/lib/analysis/video-events";
import { assertCan, type Actor } from "../authz/permissions";
import { recordAudit } from "../audit";
import type { DbOrTx } from "../db/client";
import { analysisJobs, analysisResults, matches } from "../db/schema";
import { invalidInput, notFound } from "../http/errors";

export async function getSevenAside(db: DbOrTx, actor: Actor, matchId: string) {
  assertCan(actor, "match.read");
  const [match] = await db.select({ experience: matches.sevenAside }).from(matches)
    .where(and(eq(matches.id, matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)));
  if (!match) throw notFound("Match");
  return match.experience;
}

export async function updateSevenAside(db: DbOrTx, actor: Actor, matchId: string,
  input: z.infer<typeof sevenAsideUpdateSchema>) {
  assertCan(actor, "match.update");
  return db.transaction(async tx => {
    const [match] = await tx.select().from(matches)
      .where(and(eq(matches.id, matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt))).for("update");
    if (!match) throw notFound("Match");
    let experience: SevenAsideExperience;
    if (input.op === "lineup") {
      const previous = match.sevenAside;
      const slots = new Set(input.lineup.players.map(p => p.id));
      experience = { ...input.lineup, version: 1,
        assignmentJobId: previous?.assignmentJobId ?? null,
        assignments: Object.fromEntries(Object.entries(previous?.assignments ?? {}).filter(([,slot]) => slots.has(slot))),
      };
    } else {
      if (!match.sevenAside) throw invalidInput("Save the 7-a-side lineup first.");
      const [result] = await tx.select({ summary: analysisResults.summary }).from(analysisResults)
        .innerJoin(analysisJobs, eq(analysisJobs.id, analysisResults.jobId))
        .where(and(eq(analysisResults.jobId, input.jobId), eq(analysisResults.orgId, actor.orgId),
          eq(analysisResults.matchId, matchId), eq(analysisJobs.status, "succeeded")));
      const parsed = videoEventsSchema.safeParse((result?.summary as { videoEvents?: unknown } | undefined)?.videoEvents);
      if (!parsed.success || !parsed.data.catalog.some(c => c.id === input.canonicalId)) throw notFound("Player reference");
      if (input.playerId !== null && !match.sevenAside.players.some(p => p.id === input.playerId)) {
        throw invalidInput("Choose a player from this match's lineup.");
      }
      const assignments = { ...(match.sevenAside.assignmentJobId === input.jobId ? match.sevenAside.assignments : {}) };
      if (input.playerId === null) delete assignments[input.canonicalId];
      else assignments[input.canonicalId] = input.playerId;
      experience = { ...match.sevenAside, assignmentJobId: input.jobId, assignments };
    }
    await tx.update(matches).set({ sevenAside: experience, updatedAt: new Date() }).where(eq(matches.id, matchId));
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId,
      action: input.op === "lineup" ? "match.lineup_updated" : "match.player_reference_linked",
      targetType: "match", targetId: matchId });
    return experience;
  });
}
