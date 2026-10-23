import type { Metadata } from "next";
import { Suspense } from "react";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { NewMatchForm } from "./new-match-form";

export const metadata: Metadata = { title: "New match" };

export default function NewMatchPage({ params }: PageProps<"/app/[org]/matches/new">) {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-display text-3xl font-bold uppercase tracking-tight">New match</h1>
      <p className="mt-1 text-sm text-muted">Add the match details, then upload the footage.</p>
      <Suspense fallback={<div className="mt-8 h-72 animate-pulse rounded-xl bg-surface" />}>
        <Form params={params} />
      </Suspense>
    </div>
  );
}

async function Form({ params }: { params: PageProps<"/app/[org]/matches/new">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  if (!can(actor.role, "match.create")) {
    return (
      <p role="alert" className="mt-8 rounded-xl border border-border bg-surface p-6 text-sm text-muted">
        Your role in this workspace ({actor.role}) can view matches but not create them. Ask a workspace admin if you
        need access.
      </p>
    );
  }
  return <NewMatchForm orgId={actor.orgId} orgSlug={actor.orgSlug} />;
}
