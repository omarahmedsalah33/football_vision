import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "../authz/permissions";
import type { DbOrTx } from "../db/client";
import { analysisJobs, analysisTracks, matches, playerLabels } from "../db/schema";
import { notFound } from "../http/errors";
import type { ObjectStorage } from "../storage/s3";

export const playerLabelInput = z.object({
  name: z.string().trim().min(1).max(60).nullable(),
  shirtNumber: z.number().int().min(0).max(99).nullable(),
});

/** Names a tracked player in one analysis. Staff who can edit matches may do this. */
export async function setPlayerLabel(db: DbOrTx, actor: Actor, jobId: string, trackNo: number, input: z.infer<typeof playerLabelInput>) {
  assertCan(actor, "match.update");
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
      ),
    );
  if (!track) throw notFound("Player");
  const values = { orgId: actor.orgId, jobId, trackNo, name: input.name, shirtNumber: input.shirtNumber, updatedBy: actor.userId, updatedAt: new Date() };
  const [row] = await db
    .insert(playerLabels)
    .values(values)
    .onConflictDoUpdate({ target: [playerLabels.jobId, playerLabels.trackNo], set: { name: values.name, shirtNumber: values.shirtNumber, updatedBy: values.updatedBy, updatedAt: values.updatedAt } })
    .returning({ trackNo: playerLabels.trackNo, name: playerLabels.name, shirtNumber: playerLabels.shirtNumber });
  return row;
}

export async function playerLabelsFor(db: DbOrTx, actor: Actor, jobId: string) {
  assertCan(actor, "report.read");
  return db
    .select({ trackNo: playerLabels.trackNo, name: playerLabels.name, shirtNumber: playerLabels.shirtNumber })
    .from(playerLabels)
    .where(and(eq(playerLabels.jobId, jobId), eq(playerLabels.orgId, actor.orgId)));
}

/** Short-lived signed URLs for player photos; storage keys never reach the browser. */
export async function playerPhotoUrls(storage: ObjectStorage, tracks: { trackNo: number; cropKey: string | null }[]): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  await Promise.all(
    tracks.map(async (t) => {
      if (t.cropKey) out[t.trackNo] = await storage.presignGet(t.cropKey, "image/jpeg", 600);
    }),
  );
  return out;
}
