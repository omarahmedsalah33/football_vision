import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { revokeInvitation } from "@/server/members/service";

type P = { orgId: string; invitationId: string };

export const DELETE = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await revokeInvitation(getDb(), actor, uuidParam(params.invitationId, "Invitation"));
});
