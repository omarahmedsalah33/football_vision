import { playerLabelInput, setPlayerLabel } from "@/server/analysis/players";
import { getDb } from "@/server/db/client";
import { invalidInput, uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; jobId: string; trackNo: string };

/** Sets the name and shirt number of a tracked player. */
export const PATCH = route<P, typeof playerLabelInput>({ body: playerLabelInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  const trackNo = Number(params.trackNo);
  if (!Number.isInteger(trackNo) || trackNo < 1 || trackNo > 100_000) throw invalidInput("Unknown player.");
  return setPlayerLabel(getDb(), actor, uuidParam(params.jobId, "Analysis"), trackNo, body);
});
