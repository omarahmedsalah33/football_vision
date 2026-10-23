import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { enqueueAnalysis } from "@/server/jobs/service";

type P = { orgId: string; matchId: string };

export const POST = route<P>({ status: 202 }, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), LIMITS.analysis, actor.userId);
  const job = await enqueueAnalysis(getDb(), actor, uuidParam(params.matchId, "Match"));
  return { jobId: job.id, status: job.status };
});
