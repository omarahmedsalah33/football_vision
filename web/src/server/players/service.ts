import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { buildProfile, type LinkedTrack, type MatchInput, type PlayerProfileStats } from "@/lib/analysis/player-profile";
import { buildReports, type PlayerMetrics, type PlayerReport } from "@/lib/analysis/player-report";
import { recordAudit } from "../audit";
import { assertCan, type Actor } from "../authz/permissions";
import type { DbOrTx } from "../db/client";
import { analysisJobs, analysisResults, analysisTracks, matches, organizations, playerLabels, players } from "../db/schema";
import { conflict, invalidInput, notFound } from "../http/errors";
import type { ObjectStorage } from "../storage/s3";

const thisYear = () => new Date().getUTCFullYear();

export const playerInput = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(60),
  position: z.enum(["goalkeeper", "defender", "midfielder", "forward"]).nullable().default(null),
  preferredFoot: z.enum(["left", "right", "both"]).nullable().default(null),
  shirtNumber: z.number().int().min(0).max(99).nullable().default(null),
  // Year only: many players are minors, so no full date of birth is collected.
  birthYear: z
    .number()
    .int()
    .min(1940)
    .refine((y) => y <= thisYear() - 4, "Check the birth year.")
    .nullable()
    .default(null),
  clubName: z.string().trim().min(1).max(80).nullable().default(null),
});
export type PlayerInput = z.input<typeof playerInput>;

export type PlayerRow = typeof players.$inferSelect;

function parsePlayer(raw: PlayerInput) {
  const r = playerInput.safeParse(raw);
  if (!r.success) throw invalidInput(r.error.issues[0]?.message ?? "Check the player details.");
  return r.data;
}

async function findPlayer(db: DbOrTx, actor: Actor, playerId: string) {
  const [row] = await db
    .select()
    .from(players)
    .where(and(eq(players.id, playerId), eq(players.orgId, actor.orgId), isNull(players.archivedAt)));
  if (!row) throw notFound("Player");
  return row;
}

/** Creates a player profile. `me: true` makes it the signed-in user's own profile (personal workspaces). */
export async function createPlayer(db: DbOrTx, actor: Actor, raw: PlayerInput, opts: { me?: boolean } = {}) {
  assertCan(actor, "player.manage");
  const input = parsePlayer(raw);
  return db.transaction(async (tx) => {
    if (opts.me) {
      const [org] = await tx.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, actor.orgId));
      if (org?.kind !== "personal") throw invalidInput("Your own profile lives in your personal workspace.");
      const [existing] = await tx.select({ id: players.id }).from(players).where(and(eq(players.orgId, actor.orgId), eq(players.userId, actor.userId)));
      if (existing) throw conflict("You already have a profile.");
    }
    const [row] = await tx
      .insert(players)
      .values({ orgId: actor.orgId, userId: opts.me ? actor.userId : null, createdBy: actor.userId, ...input })
      .returning();
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "player.created", targetType: "player", targetId: row.id });
    return row;
  });
}

export async function updatePlayer(db: DbOrTx, actor: Actor, playerId: string, raw: PlayerInput) {
  assertCan(actor, "player.manage");
  const input = parsePlayer(raw);
  return db.transaction(async (tx) => {
    await findPlayer(tx, actor, playerId);
    const [row] = await tx.update(players).set(input).where(and(eq(players.id, playerId), eq(players.orgId, actor.orgId))).returning();
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "player.updated", targetType: "player", targetId: playerId });
    return row;
  });
}

/** Archives a profile: it disappears from the squad; links to past analyses are kept for the record. */
export async function archivePlayer(db: DbOrTx, actor: Actor, playerId: string) {
  assertCan(actor, "player.manage");
  await db.transaction(async (tx) => {
    await findPlayer(tx, actor, playerId);
    await tx.update(players).set({ archivedAt: new Date() }).where(and(eq(players.id, playerId), eq(players.orgId, actor.orgId)));
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "player.archived", targetType: "player", targetId: playerId });
  });
}

/** Links a tracked player in one analysis to a profile (or unlinks it with null). */
export async function linkTrack(db: DbOrTx, actor: Actor, jobId: string, trackNo: number, playerId: string | null) {
  assertCan(actor, "player.manage");
  const [track] = await db
    .select({ id: analysisTracks.id })
    .from(analysisTracks)
    .innerJoin(analysisJobs, eq(analysisJobs.id, analysisTracks.jobId))
    .innerJoin(matches, eq(matches.id, analysisJobs.matchId))
    .where(
      and(
        eq(analysisTracks.jobId, jobId),
        eq(analysisTracks.trackNo, trackNo),
        eq(analysisTracks.orgId, actor.orgId),
        eq(matches.orgId, actor.orgId),
        isNull(matches.deletedAt),
      ),
    );
  if (!track) throw notFound("Player");
  if (playerId) await findPlayer(db, actor, playerId);
  const [row] = await db
    .insert(playerLabels)
    .values({ orgId: actor.orgId, jobId, trackNo, playerId, updatedBy: actor.userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [playerLabels.jobId, playerLabels.trackNo], set: { playerId, updatedBy: actor.userId, updatedAt: new Date() } })
    .returning({ trackNo: playerLabels.trackNo, playerId: playerLabels.playerId });
  return row;
}

export async function listPlayers(db: DbOrTx, actor: Actor) {
  assertCan(actor, "match.read");
  return db
    .select()
    .from(players)
    .where(and(eq(players.orgId, actor.orgId), isNull(players.archivedAt)))
    .orderBy(asc(players.shirtNumber), asc(players.name));
}

export async function myPlayer(db: DbOrTx, actor: Actor) {
  const [row] = await db
    .select()
    .from(players)
    .where(and(eq(players.orgId, actor.orgId), eq(players.userId, actor.userId), isNull(players.archivedAt)));
  return row ?? null;
}

type LinkRow = { playerId: string; jobId: string; trackNo: number };

/**
 * Builds profiles for the given players from the latest succeeded analysis of each match. Each
 * match's reports are computed once (percentiles need every player in that match).
 */
export async function profileStats(db: DbOrTx, actor: Actor, playerIds: string[]): Promise<Map<string, { stats: PlayerProfileStats; photoTrack: { jobId: string; cropKey: string } | null }>> {
  assertCan(actor, "report.read");
  const out = new Map<string, { stats: PlayerProfileStats; photoTrack: { jobId: string; cropKey: string } | null }>();
  if (playerIds.length === 0) return out;

  const links: LinkRow[] = (
    await db
      .select({ playerId: playerLabels.playerId, jobId: playerLabels.jobId, trackNo: playerLabels.trackNo })
      .from(playerLabels)
      .where(and(eq(playerLabels.orgId, actor.orgId), inArray(playerLabels.playerId, playerIds), isNotNull(playerLabels.playerId)))
  ).map((l) => ({ ...l, playerId: l.playerId! }));

  // Only the latest succeeded analysis of each (live) match counts; re-runs replace older results.
  const jobs = links.length
    ? await db
        .select({ jobId: analysisJobs.id, matchId: analysisJobs.matchId, finishedAt: analysisJobs.finishedAt, title: matches.title, playedOn: matches.playedOn, summary: analysisResults.summary })
        .from(analysisJobs)
        .innerJoin(matches, eq(matches.id, analysisJobs.matchId))
        .innerJoin(analysisResults, eq(analysisResults.jobId, analysisJobs.id))
        .where(
          and(
            eq(analysisJobs.orgId, actor.orgId),
            eq(matches.orgId, actor.orgId),
            isNull(matches.deletedAt),
            eq(analysisJobs.kind, "analyze"),
            eq(analysisJobs.status, "succeeded"),
            inArray(analysisJobs.matchId, (
              await db
                .select({ matchId: analysisJobs.matchId })
                .from(analysisJobs)
                .where(and(eq(analysisJobs.orgId, actor.orgId), inArray(analysisJobs.id, [...new Set(links.map((l) => l.jobId))])))
            ).map((r) => r.matchId)),
          ),
        )
        .orderBy(desc(analysisJobs.finishedAt))
    : [];
  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) if (!latestJob.has(j.matchId)) latestJob.set(j.matchId, j);
  const liveJobs = new Map([...latestJob.values()].map((j) => [j.jobId, j]));

  const usedJobIds = [...new Set(links.map((l) => l.jobId).filter((id) => liveJobs.has(id)))];
  const tracks = usedJobIds.length
    ? await db
        .select({
          jobId: analysisTracks.jobId,
          trackNo: analysisTracks.trackNo,
          team: analysisTracks.team,
          avgX: analysisTracks.avgX,
          avgY: analysisTracks.avgY,
          heatmap: analysisTracks.heatmap,
          metrics: analysisTracks.metrics,
          cropKey: analysisTracks.cropKey,
        })
        .from(analysisTracks)
        .where(and(eq(analysisTracks.orgId, actor.orgId), inArray(analysisTracks.jobId, usedJobIds)))
    : [];

  const reportsByJob = new Map<string, Map<number, PlayerReport>>();
  for (const jobId of usedJobIds) {
    const jobTracks = tracks.filter((t) => t.jobId === jobId);
    const length = (liveJobs.get(jobId)!.summary as { pitch?: { length?: number } }).pitch?.length ?? 105;
    const reports = buildReports(
      jobTracks.map((t) => ({ trackNo: t.trackNo, team: t.team, avgX: t.avgX, avgY: t.avgY, metrics: (t.metrics ?? {}) as PlayerMetrics })),
      length,
    );
    reportsByJob.set(jobId, new Map(reports.map((r) => [r.trackNo, r])));
  }
  const trackOf = new Map(tracks.map((t) => [`${t.jobId}:${t.trackNo}`, t]));

  for (const playerId of playerIds) {
    const mine = links.filter((l) => l.playerId === playerId && liveJobs.has(l.jobId));
    const byJob = new Map<string, LinkRow[]>();
    for (const l of mine) byJob.set(l.jobId, [...(byJob.get(l.jobId) ?? []), l]);
    const inputs: MatchInput[] = [];
    let photo: { jobId: string; cropKey: string; minutes: number; finishedAt: number } | null = null;
    for (const [jobId, ls] of byJob) {
      const job = liveJobs.get(jobId)!;
      const linked: LinkedTrack[] = [];
      for (const l of ls) {
        const t = trackOf.get(`${jobId}:${l.trackNo}`);
        const report = reportsByJob.get(jobId)?.get(l.trackNo);
        if (!t || !report) continue;
        const metrics = (t.metrics ?? {}) as PlayerMetrics;
        linked.push({ team: t.team, metrics, heatmap: t.heatmap as number[][], report });
        const finished = job.finishedAt?.getTime() ?? 0;
        // Photo: the longest-tracked appearance in the most recent match.
        if (t.cropKey && (!photo || finished > photo.finishedAt || (finished === photo.finishedAt && (metrics.minutes ?? 0) > photo.minutes))) {
          photo = { jobId, cropKey: t.cropKey, minutes: metrics.minutes ?? 0, finishedAt: finished };
        }
      }
      if (linked.length) {
        inputs.push({
          matchId: job.matchId,
          jobId,
          title: job.title,
          date: job.playedOn ?? job.finishedAt?.toISOString().slice(0, 10) ?? "",
          tracks: linked,
        });
      }
    }
    out.set(playerId, { stats: buildProfile(inputs), photoTrack: photo ? { jobId: photo.jobId, cropKey: photo.cropKey } : null });
  }
  return out;
}

export async function getPlayerProfile(db: DbOrTx, storage: ObjectStorage, actor: Actor, playerId: string) {
  assertCan(actor, "report.read");
  const player = await findPlayer(db, actor, playerId);
  const stats = (await profileStats(db, actor, [playerId])).get(playerId)!;
  const photoUrl = stats.photoTrack ? await storage.presignGet(stats.photoTrack.cropKey, "image/jpeg", 600) : null;
  return { player, stats: stats.stats, photoUrl };
}

/** Squad overview: every profile with a few headline numbers and a photo. */
export async function squad(db: DbOrTx, storage: ObjectStorage, actor: Actor) {
  const list = await listPlayers(db, actor);
  const stats = await profileStats(db, actor, list.map((p) => p.id));
  return Promise.all(
    list.map(async (p) => {
      const s = stats.get(p.id)!;
      return {
        player: p,
        totals: s.stats.totals,
        form: s.stats.matches.slice(0, 6).map((m) => m.score).reverse(),
        photoUrl: s.photoTrack ? await storage.presignGet(s.photoTrack.cropKey, "image/jpeg", 600) : null,
      };
    }),
  );
}

/** Which profile each tracked player of one analysis is linked to. */
export async function trackLinks(db: DbOrTx, actor: Actor, jobId: string) {
  assertCan(actor, "report.read");
  const rows = await db
    .select({ trackNo: playerLabels.trackNo, playerId: playerLabels.playerId })
    .from(playerLabels)
    .where(and(eq(playerLabels.jobId, jobId), eq(playerLabels.orgId, actor.orgId), isNotNull(playerLabels.playerId)));
  return new Map(rows.map((r) => [r.trackNo, r.playerId!]));
}
