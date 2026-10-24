import { z } from "zod";
import { getDb } from "@/server/db/client";
import { invalidInput, uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { linkTrack } from "@/server/players/service";

type P = { orgId: string; jobId: string; trackNo: string };
const linkInput = z.object({ playerId: z.string().uuid().nullable() });

/** Links a tracked player to a player profile ("This is me" / squad member), or unlinks it. */
export const POST = route<P, typeof linkInput>({ body: linkInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  const trackNo = Number(params.trackNo);
  if (!Number.isInteger(trackNo) || trackNo < 1 || trackNo > 100_000) throw invalidInput("Unknown player.");
  return linkTrack(getDb(), actor, uuidParam(params.jobId, "Analysis"), trackNo, body.playerId);
});
