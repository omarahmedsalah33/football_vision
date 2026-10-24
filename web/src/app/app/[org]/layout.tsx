import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import { AppShell, NavLink, WorkspaceSwitcher } from "@/components/app-shell";
import { Icon } from "@/components/app-ui";
import { ButtonLink, Logo } from "@/components/ui";
import { pageActor, pageUser } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { listMatches } from "@/server/matches/service";
import { workspaceOverview } from "@/server/orgs/overview";
import { listMyOrgs } from "@/server/orgs/service";
import { myPlayer } from "@/server/players/service";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", coach: "Coach", analyst: "Analyst", scout: "Scout", player: "Player" };

export default function OrgLayout({ children, params }: LayoutProps<"/app/[org]">) {
  return (
    <AppShell
      sidebar={
        <div className="flex min-h-full flex-col gap-6 p-4">
          <Link href="/app" aria-label="Football Vision home" className="px-1 pt-1">
            <Logo className="!text-xl" />
          </Link>
          <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-surface-2" />}>
            <WorkspaceNav params={params} />
          </Suspense>
        </div>
      }
      topbar={
        <>
          <Link href="/docs#filming" className="hidden items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface hover:text-fg sm:flex">
            <Icon name="docs" className="h-4 w-4" />
            Filming guide
          </Link>
          <UserButton />
        </>
      }
    >
      {children}
    </AppShell>
  );
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "FV"
  );
}

async function WorkspaceNav({ params }: { params: LayoutProps<"/app/[org]">["params"] }) {
  const { org } = await params;
  const [actor, user] = await Promise.all([pageActor(org), pageUser()]);
  const db = getDb();
  const [workspaces, overview, matches, me] = await Promise.all([listMyOrgs(db, actor.userId), workspaceOverview(db, actor), listMatches(db, actor), myPlayer(db, actor)]);
  const personal = overview.kind === "personal";
  const name = personal ? "Personal workspace" : actor.orgName;
  const base = `/app/${actor.orgSlug}`;
  const a = overview.analyses;
  const pct = a.unlimited || a.limit === 0 ? 0 : Math.min(100, ((a.used + a.inProgress) / a.limit) * 100);

  return (
    <>
      <section aria-label="Current workspace" className="rounded-xl border border-border bg-bg/60 p-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="fv-stripes grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-mindaro/40 bg-lush/40 font-display text-lg font-extrabold text-mindaro">
            {initials(personal ? (user.displayName ?? "Me") : actor.orgName)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{name}</p>
            <p className="truncate text-xs text-muted">
              {personal ? "Personal" : "Club"} · {ROLE_LABEL[actor.role] ?? actor.role}
            </p>
          </div>
        </div>
        <p className={`mt-3 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${overview.planId === "free" ? "border-border-strong text-muted" : "border-gold/50 bg-gold/10 text-gold"}`}>
          {overview.planName}
        </p>
        {workspaces.length > 1 && (
          <div className="mt-3">
            <WorkspaceSwitcher current={actor.orgSlug} workspaces={workspaces} />
          </div>
        )}
      </section>

      {can(actor.role, "match.create") && (
        <ButtonLink href={`${base}/matches/new`} className="w-full">
          <Icon name="plus" className="h-4 w-4" />
          New match
        </ButtonLink>
      )}

      <nav aria-label="Sections" className="space-y-1">
        <NavLink href={base} icon="home" exact>
          Home
        </NavLink>
        {me && (
          <NavLink href={`${base}/players/${me.id}`} icon="user" exact>
            My profile
          </NavLink>
        )}
        <NavLink href={`${base}/matches`} icon="matches" count={matches.length}>
          Matches
        </NavLink>
        <NavLink href={`${base}/players`} icon="shirt" exact={personal}>
          {personal ? "Players" : "Squad"}
        </NavLink>
        <NavLink href={`${base}/members`} icon="members">
          Members
        </NavLink>
        <NavLink href={`${base}/settings`} icon="settings">
          Settings
        </NavLink>
      </nav>

      <div className="mt-auto space-y-4">
        <section aria-label="Usage this month" className="rounded-xl border border-border bg-bg/60 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Analyses this month</p>
            <p className="font-data text-xs">
              {a.used + a.inProgress}
              <span className="text-muted"> / {a.unlimited ? "∞" : a.limit}</span>
            </p>
          </div>
          {!a.unlimited && (
            <div role="meter" aria-label="Analyses used this month" aria-valuemin={0} aria-valuemax={a.limit} aria-valuenow={a.used + a.inProgress} className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className={`h-full ${pct >= 100 ? "bg-gold" : "bg-mindaro"}`} style={{ width: `${pct}%` }} />
            </div>
          )}
          {a.unlimited && <p className="mt-1 text-xs text-muted">Unlimited on this plan</p>}
        </section>
        <nav aria-label="Account" className="space-y-1 border-t border-border pt-4">
          <NavLink href="/app/new" icon="club">
            New club workspace
          </NavLink>
          <NavLink href="/app/account" icon="user">
            Account
          </NavLink>
        </nav>
      </div>
    </>
  );
}
