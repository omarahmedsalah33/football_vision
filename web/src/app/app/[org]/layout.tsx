import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import { AppShell, NavLink, WorkspaceSwitcher } from "@/components/app-shell";
import { Badge, Logo } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { getDb } from "@/server/db/client";
import { listMyOrgs } from "@/server/orgs/service";

export default function OrgLayout({ children, params }: LayoutProps<"/app/[org]">) {
  return (
    <AppShell
      sidebar={
        <div className="flex h-full flex-col gap-6 p-4">
          <Link href="/app" aria-label="Workspace home">
            <Logo className="text-lg" />
          </Link>
          <Suspense fallback={<div className="h-28 animate-pulse rounded-lg bg-surface-2" />}>
            <WorkspaceNav params={params} />
          </Suspense>
        </div>
      }
      topbar={<UserButton />}
    >
      {children}
    </AppShell>
  );
}

async function WorkspaceNav({ params }: { params: LayoutProps<"/app/[org]">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  const workspaces = await listMyOrgs(getDb(), actor.userId);
  return (
    <>
      <div className="space-y-2">
        <WorkspaceSwitcher current={actor.orgSlug} workspaces={workspaces} />
        <Badge>Role: {actor.role}</Badge>
      </div>
      <nav aria-label="Sections" className="space-y-1">
        <NavLink href={`/app/${actor.orgSlug}/matches`}>Matches</NavLink>
        <NavLink href={`/app/${actor.orgSlug}/members`}>Members</NavLink>
        <NavLink href={`/app/${actor.orgSlug}/settings`}>Settings</NavLink>
      </nav>
      <nav aria-label="Account" className="mt-auto space-y-1 border-t border-border pt-4">
        <NavLink href="/app/new">New club workspace</NavLink>
        <NavLink href="/app/account">Account</NavLink>
      </nav>
    </>
  );
}
