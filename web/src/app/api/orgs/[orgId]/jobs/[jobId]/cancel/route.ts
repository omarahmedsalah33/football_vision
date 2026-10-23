import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { cancelAnalysis } from "@/server/jobs/service";

type P = { orgId: string; jobId: string };

export const POST = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  const job = await cancelAnalysis(getDb(), actor, uuidParam(params.jobId, "Analysis"));
  return { jobId: job.id, status: job.status, cancelRequested: job.cancelRequested };
});
