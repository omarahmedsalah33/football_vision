import { requireRecentVerification } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { actorFor, route } from "@/server/http/route";
import { deleteOrg, deleteOrgInput, renameOrg, renameOrgInput } from "@/server/orgs/settings";

type P = { orgId: string };

export const PATCH = route<P, typeof renameOrgInput>({ body: renameOrgInput }, async ({ user, params, body }) => {
  await renameOrg(getDb(), await actorFor(user, params.orgId), body);
});

export const DELETE = route<P, typeof deleteOrgInput>({ body: deleteOrgInput }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await requireRecentVerification();
  await deleteOrg(getDb(), actor, body);
});
