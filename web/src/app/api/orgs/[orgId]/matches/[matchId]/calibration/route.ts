import { calibrationInput, saveCalibration } from "@/server/calibration/service";
import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";

type P = { orgId: string; matchId: string };

export const POST = route<P, typeof calibrationInput>({ body: calibrationInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "calibration.save", perMinute: 30 }, actor.userId);
  return saveCalibration(getDb(), actor, uuidParam(params.matchId, "Match"), body);
});
