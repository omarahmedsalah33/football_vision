import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { NewMatchForm } from "./new-match-form";

export const metadata: Metadata = { title: "New match" };

export default function NewMatchPage({ params }: PageProps<"/app/[org]/matches/new">) {
  return (
    <div className="mx-auto max-w-xl">
      <Suspense fallback={<div className="h-72 animate-pulse rounded-xl bg-surface" />}>
        <Form params={params} />
      </Suspense>
    </div>
  );
}

async function Form({ params }: { params: PageProps<"/app/[org]/matches/new">["params"] }) {
  const { org } = await params;
  const actor = await pageActor(org);
  const header = (
    <PageHeader
      crumbs={[{ label: "Home", href: `/app/${actor.orgSlug}` }, { label: "Matches", href: `/app/${actor.orgSlug}/matches` }, { label: "New" }]}
      title="New match"
      description="Add the match details, then upload the footage."
    />
  );
  if (!can(actor.role, "match.create")) {
    return (
      <>
        {header}
        <p role="alert" className="mt-8 rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          Your role in this workspace ({actor.role}) can view matches but not create them. Ask a workspace admin if you
          need access.
        </p>
      </>
    );
  }
  return (
    <>
      {header}
      <NewMatchForm orgId={actor.orgId} orgSlug={actor.orgSlug} />
    </>
  );
}
