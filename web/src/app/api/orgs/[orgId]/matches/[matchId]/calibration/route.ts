import { can } from "@/server/authz/permissions";
import { calibrationInput, saveCalibration } from "@/server/calibration/service";
import { getDb } from "@/server/db/client";
import { AppError, uuidParam } from "@/server/http/errors";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { enqueueAnalysis } from "@/server/jobs/service";

type P = { orgId: string; matchId: string };

/**
 * Saves the calibration and, for roles that may run analyses, starts the analysis straight away:
 * marking the pitch is the last thing the user has to do.
 */
export const POST = route<P, typeof calibrationInput>({ body: calibrationInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  const db = getDb();
  await enforceRateLimit(db, { name: "calibration.save", perMinute: 30 }, actor.userId);
  const matchId = uuidParam(params.matchId, "Match");
  const saved = await saveCalibration(db, actor, matchId, body);
  if (!can(actor.role, "analysis.run")) return { ...saved, analysis: { started: false, reason: "Your role can't start analyses." } };
  try {
    const job = await enqueueAnalysis(db, actor, matchId);
    return { ...saved, analysis: { started: true, jobId: job.id } };
  } catch (err) {
    // The calibration is saved either way; the match page offers "Start analysis" with the reason.
    if (err instanceof AppError && err.status < 500) return { ...saved, analysis: { started: false, reason: err.message } };
    throw err;
  }
});
