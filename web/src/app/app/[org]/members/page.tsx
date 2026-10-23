import type { Metadata } from "next";
import { Suspense } from "react";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { listMembers, listPendingInvitations } from "@/server/members/service";
import { MembersPanel } from "./members-panel";

export const metadata: Metadata = { title: "Members" };

export default function MembersPage({ params }: PageProps<"/app/[org]/members">) {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold uppercase tracking-tight">Members</h1>
      <Suspense fallback={<div className="mt-8 h-64 animate-pulse rounded-xl bg-surface" aria-label="Loading members" />}>
        <Members params={params} />
      </Suspense>
    </div>
  );
}

async function Members({ params }: { params: PageProps<"/app/[org]/members">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  const canManage = can(actor.role, "members.manage");
  const [members, invitations] = await Promise.all([
    listMembers(getDb(), actor),
    canManage ? listPendingInvitations(getDb(), actor) : Promise.resolve([]),
  ]);
  return (
    <MembersPanel
      orgId={actor.orgId}
      me={{ userId: actor.userId, role: actor.role }}
      canManage={canManage}
      members={members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))}
      invitations={invitations.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }))}
    />
  );
}
