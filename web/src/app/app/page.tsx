import { redirect } from "next/navigation";
import { Suspense } from "react";
import { pageUser } from "@/server/auth/page";
import { getDb } from "@/server/db/client";
import { listMyOrgs } from "@/server/orgs/service";

export default function AppIndex() {
  return (
    <Suspense fallback={<p className="p-8 text-muted">Opening your workspace…</p>}>
      <OpenFirstWorkspace />
    </Suspense>
  );
}

async function OpenFirstWorkspace(): Promise<never> {
  const user = await pageUser();
  // New users choose how they'll use the product first (player, coach, club, scout, parent).
  if (!user.onboardedAt) redirect("/app/welcome");
  const orgs = await listMyOrgs(getDb(), user.id);
  // Every user has a personal workspace (created on first sign-in), so this list is never empty.
  redirect(`/app/${orgs[0].slug}`);
}
