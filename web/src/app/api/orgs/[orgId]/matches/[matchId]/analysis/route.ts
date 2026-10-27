import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { enqueueAnalysis } from "@/server/jobs/service";
import { z } from "zod";
import { invalidInput } from "@/server/http/errors";

type P = { orgId: string; matchId: string };

export const POST = route<P>({ status: 202 }, async ({ user, params, req }) => {
  const text = await req.text();
  if (Buffer.byteLength(text) > 1000) throw invalidInput("Analysis options are too large.");
  let value: unknown = {};
  if (text) {
    try { value = JSON.parse(text); } catch { throw invalidInput("Invalid analysis options."); }
  }
  const body = z.object({ engine: z.literal("llm").default("llm"), playerTracking: z.boolean().default(false) }).strict().parse(value);
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), LIMITS.analysis, actor.userId);
  const job = await enqueueAnalysis(getDb(), actor, uuidParam(params.matchId, "Match"), new Date(), body.engine, body.playerTracking);
  return { jobId: job.id, status: job.status };
});
