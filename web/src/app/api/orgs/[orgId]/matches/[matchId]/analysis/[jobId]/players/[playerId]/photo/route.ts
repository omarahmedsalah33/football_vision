import { getAnalysisResults } from "@/server/analysis/results";
import { getDb } from "@/server/db/client";
import { actorFor, route } from "@/server/http/route";
import { notFound, payloadTooLarge, uuidParam } from "@/server/http/errors";
import { getStorage } from "@/server/storage/s3";

type Params = { orgId: string; matchId: string; jobId: string; playerId: string };
/** Same-origin authorized image export; avoids exposing storage CORS as a user problem.
 * No arbitrary URL/key parameter and no persistence of the returned bytes.
 */
export const GET = route<Params>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  const result = await getAnalysisResults(getDb(), actor,
    uuidParam(params.matchId, "Match"), uuidParam(params.jobId, "Analysis"));
  const entry = result.summary.videoEvents?.catalog.find(p => p.id === params.playerId);
  if (!entry?.photoKey) throw notFound("Player photo");
  const url = await getStorage().presignGet(entry.photoKey, "image/jpeg", 60);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw notFound("Player photo");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw payloadTooLarge("Player photo is too large to export.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return { image: `data:image/jpeg;base64,${Buffer.concat(chunks).toString("base64")}` };
});
