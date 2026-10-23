/**
 * Admin tool: assigns a plan to every workspace owned by an email address (e.g. the internal
 * testing plan for staff). Writes an audit event per workspace. Not reachable from the web app.
 *
 *   npx tsx scripts/grant-plan.mts --email someone@example.com --plan internal
 *   npx tsx scripts/grant-plan.mts --email someone@example.com --plan free   # back to the default
 */
import { parseArgs } from "node:util";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

const { values } = parseArgs({ options: { email: { type: "string" }, plan: { type: "string" } } });
if (!values.email || !values.plan) {
  console.error("usage: grant-plan.mts --email <address> --plan <plan id>");
  process.exit(2);
}

const { and, eq, isNull, sql } = await import("drizzle-orm");
const { getDb } = await import("../src/server/db/client");
const { memberships, organizations, plans, subscriptions, users } = await import("../src/server/db/schema");
const { recordAudit } = await import("../src/server/audit");

const db = getDb();
const [plan] = await db.select().from(plans).where(eq(plans.id, values.plan));
if (!plan) {
  console.error(`No plan "${values.plan}". Run the migrations first (npm run db:migrate).`);
  process.exit(1);
}
const [user] = await db
  .select()
  .from(users)
  .where(and(sql`lower(${users.email}) = ${values.email.toLowerCase()}`, isNull(users.deletedAt)));
if (!user) {
  console.error(`No account with email ${values.email}. Sign in to the app once first, then re-run.`);
  process.exit(1);
}

const owned = await db
  .select({ id: organizations.id, name: organizations.name })
  .from(memberships)
  .innerJoin(organizations, eq(organizations.id, memberships.orgId))
  .where(and(eq(memberships.userId, user.id), eq(memberships.role, "owner"), eq(memberships.status, "active"), isNull(organizations.deletedAt)));

for (const org of owned) {
  await db.transaction(async (tx) => {
    await tx
      .insert(subscriptions)
      .values({ orgId: org.id, planId: plan.id, status: "active", provider: "internal", providerRef: "grant-plan" })
      .onConflictDoUpdate({
        target: subscriptions.orgId,
        set: { planId: plan.id, status: "active", provider: "internal", providerRef: "grant-plan", currentPeriodEnd: null, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      orgId: org.id,
      actorUserId: null,
      action: "billing.plan_changed",
      metadata: { plan: plan.id, source: "grant-plan script", email: values.email!.toLowerCase() },
    });
  });
  console.log(`✓ ${org.name}: plan "${plan.name}"`);
}
console.log(owned.length ? `Granted to ${owned.length} workspace(s).` : "This account owns no workspaces.");
process.exit(0);
