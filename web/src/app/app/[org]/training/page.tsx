import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-ui";
import { DimensionChips, DrillCard } from "@/components/drill-ui";
import { diagramFor } from "@/lib/development/diagrams";
import { CATEGORY_LABEL, DIMENSIONS, dimensionByKey, type Category } from "@/lib/development/framework";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { library } from "@/server/development/service";
import { ArchiveDrillButton, CreateDrillButton } from "./training-ui";

export const metadata: Metadata = { title: "Training library" };

export default function TrainingPage({ params, searchParams }: PageProps<"/app/[org]/training">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface" aria-label="Loading library" />}>
        <Library params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Library({ params, searchParams }: Pick<PageProps<"/app/[org]/training">, "params" | "searchParams">) {
  const { org } = await params;
  const sp = await searchParams;
  const actor = await pageActor(org);
  const drills = await library(getDb(), actor);
  const base = `/app/${actor.orgSlug}/training`;
  const category = typeof sp.category === "string" && sp.category in CATEGORY_LABEL ? (sp.category as Category) : null;
  const area = typeof sp.area === "string" && dimensionByKey.has(sp.area) ? sp.area : null;
  const shown = drills.filter((d) => (!area || d.dimensions.includes(area)) && (!category || d.dimensions.some((k) => dimensionByKey.get(k)?.category === category)));
  const canAdd = can(actor.role, "drill.manage");
  const chip = (href: string, label: string, on: boolean) => (
    <Link key={href} href={href} aria-current={on ? "true" : undefined} className={`rounded-full border px-3 py-1 text-sm transition-colors ${on ? "border-mindaro bg-accent-soft text-fg" : "border-border text-muted hover:text-fg"}`}>
      {label}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Home", href: `/app/${actor.orgSlug}` }, { label: "Training library" }]}
        title="Training library"
        description="Drills that development plans are built from, each with steps, coaching points, progressions and what success looks like."
        actions={canAdd && <CreateDrillButton orgId={actor.orgId} />}
      />
      <nav aria-label="Filter by category" className="flex flex-wrap gap-2">
        {chip(base, "All", !category && !area)}
        {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => chip(`${base}?category=${c}`, CATEGORY_LABEL[c], category === c))}
      </nav>
      {category && (
        <nav aria-label="Filter by area" className="flex flex-wrap gap-2">
          {DIMENSIONS.filter((d) => d.category === category).map((d) => chip(`${base}?category=${category}&area=${d.key}`, d.label, area === d.key))}
        </nav>
      )}
      <p className="text-sm text-muted">
        {shown.length} {shown.length === 1 ? "drill" : "drills"}
        {area ? ` for ${dimensionByKey.get(area)!.label.toLowerCase()}` : ""}. The starter library is made of common coaching exercises written up by Football Vision; it isn&apos;t certified by a coaching body, so check each drill for the player&apos;s age, level and fitness.
      </p>
      <ul className="space-y-3">
        {shown.map((d) => (
          <li key={d.key}>
            <DrillCard
              drill={d}
              diagram={diagramFor(d.key)}
              badge={<DimensionChips keys={d.dimensions} />}
              actions={d.source === "custom" && canAdd ? <ArchiveDrillButton orgId={actor.orgId} drillId={d.key} /> : undefined}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
