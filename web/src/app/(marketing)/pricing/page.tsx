import Link from "next/link";
import type { Metadata } from "next";
import { PageHero } from "@/components/marketing/site-chrome";
import { Badge, ButtonLink, CornerMarks } from "@/components/ui";
import { planLimitsSchema, type PlanLimits } from "@/server/billing/entitlements";
import { getDb } from "@/server/db/client";
import { plans } from "@/server/db/schema";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Tiered plans so every academy can start and every club can grow. Transparent limits, no hidden costs.",
};

// Marketing copy per plan. Limits are NOT written here: they come from the database, the same
// source the server enforces, so this page can never promise more than the product allows.
const COPY: Record<string, { for: string; highlights: string[]; featured?: boolean }> = {
  free: { for: "Try it on a real match", highlights: ["Basic match summary", "Guided onboarding"] },
  player_pro: { for: "Individual players", highlights: ["Personal performance reports", "Development tracking"] },
  coach_pro: { for: "Coaches and small teams", highlights: ["Team tactical analysis", "Exportable reports"] },
  club: {
    for: "Clubs and academies",
    highlights: ["Multiple teams and staff roles", "Shared analytics across the club"],
    featured: true,
  },
  enterprise: { for: "Federations and large organisations", highlights: ["Negotiated limits", "Custom branding and agreements"] },
};
const ORDER = ["free", "player_pro", "coach_pro", "club", "enterprise"];

function limitRows(l: PlanLimits) {
  const gb = (b: number) => `${Math.round(b / 1024 ** 3)} GB`;
  return [
    ["Match analyses / month", String(l.monthlyAnalyses)],
    ["Largest video", gb(l.maxUploadBytes)],
    ["Longest video", `${Math.round(l.maxVideoDurationSeconds / 60)} min`],
    ["Workspace members", String(l.maxMembers)],
    ["Teams", String(l.maxTeams)],
    ["Footage kept for", `${l.retentionDays} days`],
  ];
}

export default async function PricingPage() {
  const rows = await getDb().select().from(plans);
  const catalog = ORDER.map((id) => rows.find((r) => r.id === id && r.active))
    .filter((r) => r !== undefined)
    .map((r) => ({ ...r, limits: planLimitsSchema.parse(r.limits), copy: COPY[r.id] }));

  return (
    <>
      <PageHero eyebrow="Pricing" title={<>Elite tools. <span className="text-gold">Fair for every level.</span></>}>
        Start free, then pick the plan that fits your team. Every limit below is exactly what the product
        enforces. Prices in Egyptian pounds will be announced at launch.
      </PageHero>

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {catalog.map((p) => (
            <li
              key={p.id}
              className={`relative flex flex-col rounded-2xl border p-6 ${p.copy?.featured ? "border-gold/70 bg-gold/[0.05]" : "border-border bg-surface"}`}
            >
              {p.copy?.featured && <CornerMarks tone="gold" size={16} />}
              <div className="flex items-center justify-between gap-2">
                <h2 className={`font-display text-2xl font-bold uppercase ${p.copy?.featured ? "text-gold" : ""}`}>{p.name}</h2>
                {p.id === "free" && <Badge tone="accent">Available now</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">{p.copy?.for}</p>
              <p className="mt-5 font-data text-lg text-fg">{p.id === "free" ? "Free" : "Price at launch"}</p>

              <dl className="mt-5 space-y-2 border-t border-border pt-4 text-sm">
                {limitRows(p.limits).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-muted">{k}</dt>
                    <dd className="font-data text-fg">{p.id === "enterprise" ? "Negotiated" : v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-5 font-data text-[11px] uppercase tracking-widest text-muted">Planned features</p>
              <ul className="mt-2 space-y-1.5 text-sm text-muted">
                {p.copy?.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full border border-cascade" />
                    {h}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-6">
                {p.id === "free" ? (
                  <ButtonLink href="/sign-up" className="w-full">
                    Start free
                  </ButtonLink>
                ) : (
                  <ButtonLink href="/contact" variant="secondary" className="w-full">
                    {p.id === "enterprise" ? "Talk to us" : "Join the waitlist"}
                  </ButtonLink>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-10 grid gap-4 text-sm text-muted md:grid-cols-3">
          <p>
            <strong className="text-fg">What counts as an analysis?</strong> One uploaded match processed end to end.
            Failed or cancelled analyses are never counted.
          </p>
          <p>
            <strong className="text-fg">Plan features are being built.</strong> Today every plan can upload,
            calibrate and analyse video (tracking and team shape are in beta); player reports are in development (see the{" "}
            <Link href="/#how" className="text-mindaro underline underline-offset-4">roadmap</Link>).
          </p>
          <p>
            <strong className="text-fg">No hidden costs.</strong> Paid plans are not on sale yet. When they are, the
            price you see is the price you pay.
          </p>
        </div>
      </section>
    </>
  );
}
