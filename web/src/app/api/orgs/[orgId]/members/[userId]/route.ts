import { getDb } from "@/server/db/client";
import { uuidParam } from "@/server/http/errors";
import { actorFor, route } from "@/server/http/route";
import { changeRole, changeRoleInput, removeMember } from "@/server/members/service";

type P = { orgId: string; userId: string };

export const PATCH = route<P, typeof changeRoleInput>({ body: changeRoleInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await changeRole(getDb(), actor, uuidParam(params.userId, "Member"), body.role);
});

/** Removes a member; targeting yourself means leaving the workspace. */
export const DELETE = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  await removeMember(getDb(), actor, uuidParam(params.userId, "Member"));
});
