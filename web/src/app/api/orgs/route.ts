import { getDb } from "@/server/db/client";
import { enforceRateLimit, LIMITS } from "@/server/http/rate-limit";
import { route } from "@/server/http/route";
import { createOrg, createOrgInput, listMyOrgs } from "@/server/orgs/service";

export const GET = route({}, async ({ user }) => {
  return { organizations: await listMyOrgs(getDb(), user.id) };
});

export const POST = route({ body: createOrgInput, status: 201 }, async ({ user, body }) => {
  await enforceRateLimit(getDb(), LIMITS.createOrg, user.id);
  const org = await createOrg(getDb(), user.id, body);
  return { id: org.id, slug: org.slug, name: org.name, kind: org.kind };
});
