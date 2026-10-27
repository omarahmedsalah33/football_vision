import { z } from "zod";
import type { VideoEvents } from "./analysis/video-events";
import { buildGameRatings } from "./game-ratings";

export const lineupPlayerSchema = z.object({
  id: z.string().regex(/^[ab][1-7]$/),
  team: z.enum(["a", "b"]),
  name: z.string().trim().min(1).max(60),
  shirtNumber: z.number().int().min(0).max(99).nullable(),
}).strict();
export const lineupInputSchema = z.object({
  teamAName: z.string().trim().min(1).max(40),
  teamBName: z.string().trim().min(1).max(40),
  players: z.array(lineupPlayerSchema).max(14),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>(), numbers = new Set<string>();
  for (const player of value.players) {
    if (!player.id.startsWith(player.team) || ids.has(player.id)) {
      ctx.addIssue({ code: "custom", message: "Each player needs a different slot on the correct team.", path: ["players"] });
    }
    ids.add(player.id);
    const number = `${player.team}:${player.shirtNumber}`;
    if (player.shirtNumber !== null && numbers.has(number)) {
      ctx.addIssue({ code: "custom", message: "Shirt numbers must be different within each team.", path: ["players"] });
    }
    if (player.shirtNumber !== null) numbers.add(number);
  }
});
export type LineupPlayer = z.infer<typeof lineupPlayerSchema>;
export type LineupInput = z.infer<typeof lineupInputSchema>;
export type SevenAsideExperience = LineupInput & {
  version: 1;
  assignmentJobId: string | null;
  assignments: Record<string, string>;
};
export const sevenAsideUpdateSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("lineup"), lineup: lineupInputSchema }).strict(),
  z.object({
    op: z.literal("assignment"), jobId: z.uuid(),
    canonicalId: z.string().regex(/^Unknown([1-9]|1[0-9]|2[0-4])$/),
    playerId: z.string().regex(/^[ab][1-7]$/).nullable(),
  }).strict(),
]);

export function linksForJob(experience: SevenAsideExperience | null, jobId: string): Record<string, string> {
  return experience?.assignmentJobId === jobId ? experience.assignments : {};
}

export function buildSevenAsideStats(data: VideoEvents, experience: SevenAsideExperience, jobId: string) {
  const links = linksForJob(experience, jobId);
  return experience.players.map(player => {
    const canonicalIds = data.catalog.filter(c => links[c.id] === player.id).map(c => c.id);
    const events = data.events.filter(e => e.actorId !== null && canonicalIds.includes(e.actorId)
      && e.included && e.matchIncluded !== false && !e.duplicateOf);
    const counts = {
      goals: events.filter(e => e.goalAccepted).length,
      shots: events.filter(e => e.type === "shot").length,
      passes: events.filter(e => e.type === "pass").length,
      carries: events.filter(e => e.type === "carry").length,
    };
    return { ...player, canonicalIds, linked: canonicalIds.length > 0, ...counts,
      ratings: buildGameRatings(events, data.durationSeconds),
      highlights: [...events].sort((a,b) => Number(b.goalAccepted)-Number(a.goalAccepted)
        || Number(b.type === "shot")-Number(a.type === "shot") || a.key-b.key).slice(0,8) };
  });
}
export type SevenAsideStats = ReturnType<typeof buildSevenAsideStats>[number];
