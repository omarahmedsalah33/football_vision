import Link from "next/link";
import type { ReactNode } from "react";
import { SampleReport } from "@/components/marketing/sample-report";
import { VisionHero } from "@/components/marketing/vision-hero";
import { Badge, ButtonLink, Card, CornerMarks, Logo } from "@/components/ui";

const TAGLINE = ["Train", "Measure", "Perform", "Discover"];

/* Minimal geometric icons (brand AI iconography: nodes, chips, waves). */
const icon = "h-6 w-6";
const Icons = {
  upload: (
    <svg viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  calibrate: (
    <svg viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M12 5v14" />
      <circle cx="12" cy="12" r="2.6" />
      <circle cx="3" cy="5" r="1.4" fill="currentColor" />
      <circle cx="21" cy="5" r="1.4" fill="currentColor" />
      <circle cx="3" cy="19" r="1.4" fill="currentColor" />
      <circle cx="21" cy="19" r="1.4" fill="currentColor" />
    </svg>
  ),
  track: (
    <svg viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="5" cy="17" r="2" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="19" cy="14" r="2" />
      <path d="M6.3 15.4 10.7 8.6M13.7 8.3l3.9 4.2" />
      <path d="M2 4h4M2 4v4M22 20h-4M22 20v-4" strokeLinecap="round" />
    </svg>
  ),
  evidence: (
    <svg viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="m10 8 4 2-4 2V8Z" fill="currentColor" />
      <path d="M3 20h18M7 20v-2M12 20v-3M17 20v-1" strokeLinecap="round" />
    </svg>
  ),
};

const STEPS: { title: string; text: string; live: boolean; icon: ReactNode }[] = [
  {
    title: "Upload",
    text: "Send your match video straight to private storage. Big files are fine. Only your workspace can see it.",
    live: true,
    icon: Icons.upload,
  },
  {
    title: "Calibrate",
    text: "Tap four points on the pitch once per camera spot. From then on, positions are measured in real metres.",
    live: false,
    icon: Icons.calibrate,
  },
  {
    title: "Detect & track",
    text: "Computer vision finds and follows every player, frame by frame, and separates the two teams.",
    live: false,
    icon: Icons.track,
  },
  {
    title: "Review the evidence",
    text: "Every finding links to the exact moment in the video, with a clear note on how reliable it is.",
    live: false,
    icon: Icons.evidence,
  },
];

const FACTS = [
  { value: "105 × 68 m", text: "Positions measured on a real pitch model, not screen pixels." },
  { value: "4 labels", text: "Measured, estimated, inferred or not available. On every number." },
  { value: "0 public links", text: "Footage is private by default. Viewing links expire in minutes." },
  { value: "1 club · 1 vault", text: "Strict walls between workspaces. Your data stays yours." },
];

const PROVENANCE = [
  { tag: "Measured", tone: "accent" as const, text: "Taken straight from calibrated video, like team width or where your back line sits." },
  { tag: "Estimated", tone: "info" as const, text: "Built from tracking that can have gaps, like distance covered. Always shown with a quality note." },
  { tag: "Inferred", tone: "gold" as const, text: "A reading of the game, like shape or pressing. Shown with the clips behind it." },
  { tag: "Not available", tone: "neutral" as const, text: "If the footage can't support it, we say so. No guessing, no filler numbers." },
];

const AUDIENCES = [
  { title: "Academies", text: "Track every player's growth season by season, with proof you can show parents and scouts." },
  { title: "Clubs", text: "Give your coaching staff one shared view of every match, with clear roles and access." },
  { title: "Coaches & analysts", text: "Spend your time coaching, not scrubbing video. Jump straight to the moments that matter." },
  { title: "Scouts", text: "Compare players on evidence, not highlight reels, and see exactly what each claim is based on." },
  { title: "Players & parents", text: "Simple enough to use without a technician. See your progress, match after match." },
];

const TIERS = [
  { name: "Free trial", for: "Try it on a real match", featured: false },
  { name: "Player Pro", for: "Individual players", featured: false },
  { name: "Coach Pro", for: "Coaches and small teams", featured: false },
  { name: "Club / Academy", for: "Multiple teams and staff", featured: true },
  { name: "Enterprise", for: "Federations and large clubs", featured: false },
];

function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <p className="font-data text-xs uppercase tracking-[0.2em] text-mindaro">{eyebrow}</p>
      <h2 className="mt-3 font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-5xl">{title}</h2>
      {children && <p className="mt-4 text-lg leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-bg/85 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <Link href="/" aria-label="Football Vision home">
            <Logo />
          </Link>
          <div className="hidden items-center gap-1 lg:flex">
            {[
              ["#how", "How it works"],
              ["#evidence", "Evidence"],
              ["#who", "Who it's for"],
              ["#privacy", "Privacy"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="rounded-md px-3 py-2 text-sm text-muted hover:text-fg">
                {label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <ButtonLink href="/sign-in" variant="ghost">
              Sign in
            </ButtonLink>
            <ButtonLink href="/sign-up">Get started</ButtonLink>
          </div>
        </nav>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="fv-stripes relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-40 -top-40 h-[560px] w-[560px] rounded-full opacity-30 blur-3xl"
            style={{ background: "radial-gradient(circle, var(--lush), transparent 65%)" }}
          />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:py-24">
            <div className="fv-rise">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-data text-xs uppercase tracking-[0.22em] text-muted">
                {TAGLINE.map((w, i) => (
                  <span key={w} className="flex items-center gap-3">
                    {i > 0 && <span aria-hidden="true" className="h-1 w-1 rounded-full bg-mindaro" />}
                    {w}.
                  </span>
                ))}
              </p>
              <h1 className="mt-6 font-display text-6xl font-extrabold uppercase italic leading-[0.88] tracking-tight sm:text-7xl xl:text-8xl">
                Professional-grade analysis.
                <span className="mt-2 block text-mindaro">For every team.</span>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted">
                Football Vision turns your match footage into insight you can actually check. Every finding points
                back to the moment in the video it came from, and tells you how it was measured. Built in Egypt for
                academies, clubs, coaches, scouts and players.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href="/sign-up" className="px-6 text-base">
                  Start free
                </ButtonLink>
                <ButtonLink href="#how" variant="secondary" className="px-6 text-base">
                  See how it works
                </ButtonLink>
              </div>
              <ul className="mt-8 flex flex-wrap gap-2 text-sm">
                <li className="flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-mindaro" />
                  Live today: secure upload &amp; video processing
                </li>
                <li className="flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1.5 text-muted">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full border border-cascade" />
                  In development: tracking &amp; tactical reports
                </li>
              </ul>
            </div>
            <VisionHero />
          </div>
        </section>

        {/* Facts */}
        <section aria-label="How we work" className="border-y border-border bg-surface/50">
          <dl className="mx-auto grid max-w-7xl grid-cols-1 divide-y divide-border px-4 sm:grid-cols-2 sm:divide-y-0 sm:px-6 lg:grid-cols-4 lg:divide-x">
            {FACTS.map((f) => (
              <div key={f.value} className="px-2 py-7 lg:px-6">
                <dt className="font-data text-2xl font-bold text-mindaro">{f.value}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted">{f.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-20 sm:px-6">
          <SectionHeading eyebrow="From footage to evidence" title={<>How it <span className="text-mindaro">works</span></>}>
            No technician, no special equipment beyond a camera that sees the whole pitch.
          </SectionHeading>
          <ol className="relative mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <span aria-hidden="true" className="absolute left-0 right-0 top-[38px] hidden border-t border-dashed border-border-strong xl:block" />
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative">
                <Card className="h-full p-6" corners="pitchline">
                  <div className="flex items-center justify-between">
                    <span className={`grid h-12 w-12 place-items-center rounded-xl border ${s.live ? "border-mindaro/50 bg-accent-soft text-mindaro" : "border-border bg-bg text-cascade"}`}>
                      {s.icon}
                    </span>
                    <Badge tone={s.live ? "accent" : "neutral"}>{s.live ? "Live" : "In development"}</Badge>
                  </div>
                  <p className="mt-5 font-data text-xs text-muted">STEP {String(i + 1).padStart(2, "0")}</p>
                  <h3 className="mt-1 font-display text-2xl font-bold uppercase">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.text}</p>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        {/* Evidence */}
        <section id="evidence" className="scroll-mt-24 border-y border-border bg-surface/40">
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div>
              <SectionHeading eyebrow="Our promise" title={<>Evidence, <span className="text-gold">not opinions.</span></>}>
                We replace guesswork with proof. Every number carries a label that tells you exactly how much you
                can trust it.
              </SectionHeading>
              <dl className="mt-8 space-y-4">
                {PROVENANCE.map((p) => (
                  <div key={p.tag} className="flex gap-4">
                    <dt className="w-32 shrink-0 pt-0.5">
                      <Badge tone={p.tone}>{p.tag}</Badge>
                    </dt>
                    <dd className="text-sm leading-relaxed text-muted">{p.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <SampleReport />
          </div>
        </section>

        {/* Audiences */}
        <section id="who" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-20 sm:px-6">
          <SectionHeading eyebrow="Built for the whole game" title={<>From grassroots <span className="text-mindaro">to the first team</span></>}>
            Elite technology shouldn&apos;t be reserved for the few. Every academy, club and player deserves it.
          </SectionHeading>
          <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {AUDIENCES.map((a) => (
              <li key={a.title}>
                <Card className="group h-full p-6 transition-colors hover:border-gold/60">
                  <span aria-hidden="true" className="block h-1 w-10 rounded-full bg-gold transition-all group-hover:w-16" />
                  <h3 className="mt-5 font-display text-2xl font-bold uppercase">{a.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{a.text}</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        {/* Tiers */}
        <section className="border-y border-border bg-surface/40">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
            <SectionHeading eyebrow="Accessible, never ordinary" title={<>Elite tools. <span className="text-gold">Fair for every level.</span></>}>
              Tiered plans so every academy can start, and every club can grow. Transparent, with no hidden
              costs. Prices are announced at launch, in Egyptian pounds.
            </SectionHeading>
            <ul className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {TIERS.map((t) => (
                <li
                  key={t.name}
                  className={`relative rounded-xl border p-5 ${t.featured ? "border-gold/70 bg-gold/[0.06]" : "border-border bg-surface"}`}
                >
                  {t.featured && <CornerMarks tone="gold" size={14} />}
                  <p className={`font-display text-xl font-bold uppercase ${t.featured ? "text-gold" : ""}`}>{t.name}</p>
                  <p className="mt-1 text-sm text-muted">{t.for}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Privacy */}
        <section id="privacy" className="mx-auto grid max-w-7xl scroll-mt-24 gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <SectionHeading eyebrow="Trust" title={<>Your footage <span className="text-mindaro">stays yours</span></>}>
            Built for clubs and academies that film players, including minors.
          </SectionHeading>
          <ul className="space-y-4 self-center">
            {[
              "Private by default. Videos are never public, and viewing links expire within minutes.",
              "Strict separation between workspaces: one club can never see another club's data.",
              "Your footage is never used to train our models without your explicit, separate permission.",
              "Retention limits and deletion controls for every workspace (coming soon).",
            ].map((t) => (
              <li key={t} className="flex gap-3 text-muted">
                <svg viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-mindaro" aria-hidden="true">
                  <path d="M4 10.5 8 14.5 16 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t}
              </li>
            ))}
          </ul>
        </section>

        {/* Call to action */}
        <section className="px-4 pb-20 sm:px-6">
          <div className="fv-stripes relative mx-auto max-w-7xl overflow-hidden rounded-3xl bg-lush px-6 py-14 text-center sm:px-12">
            <CornerMarks tone="gold" size={28} />
            {/* Lush Green is ~3.9:1 against white, so only large or bold text sits directly on it. */}
            <p className="inline-block rounded-full bg-bg px-4 py-1.5 font-data text-xs uppercase tracking-[0.22em] text-mindaro">
              Train. Measure. Perform. Discover.
            </p>
            <h2 className="mx-auto mt-5 max-w-3xl font-display text-5xl font-extrabold uppercase italic leading-[0.92] text-white sm:text-6xl">
              Bring your next match.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-xl font-semibold text-white">
              Start free with one match. Upload it and see what&apos;s ready today.
            </p>
            <div className="mt-8 flex justify-center">
              <ButtonLink href="/sign-up" className="px-7 text-base">
                Start free
              </ButtonLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <Logo />
            <p className="mt-2 font-data text-xs uppercase tracking-[0.2em] text-muted">
              Train. Measure. Perform. Discover.
            </p>
          </div>
          <p className="text-sm text-muted">Built in Egypt. Early access software.</p>
        </div>
      </footer>
    </div>
  );
}
