import { getDb } from "@/server/db/client";
import { env } from "@/server/env";
import { enforceRateLimit } from "@/server/http/rate-limit";
import { actorFor, route } from "@/server/http/route";
import { createInvitation, inviteInput, listMembers, listPendingInvitations } from "@/server/members/service";
import { can } from "@/server/authz/permissions";

type P = { orgId: string };

export const GET = route<P>({}, async ({ user, params }) => {
  const actor = await actorFor(user, params.orgId);
  const members = await listMembers(getDb(), actor);
  const invitations = can(actor.role, "members.manage") ? await listPendingInvitations(getDb(), actor) : [];
  return { members, invitations };
});

/** Invites someone; the response carries the one-time link (the token is never retrievable again). */
export const POST = route<P, typeof inviteInput>({ body: inviteInput, status: 201 }, async ({ user, params, body }) => {
  const actor = await actorFor(user, params.orgId);
  await enforceRateLimit(getDb(), { name: "member.invite", perMinute: 20 }, actor.userId);
  const inv = await createInvitation(getDb(), actor, body);
  return { id: inv.id, expiresAt: inv.expiresAt, link: `${env().APP_ORIGIN}/invite/${inv.token}` };
});
