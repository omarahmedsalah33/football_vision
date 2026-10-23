import Link from "next/link";
import { Pitch } from "@/components/pitch";
import { Badge, ButtonLink, Card, Logo } from "@/components/ui";

// Illustrative average positions (metres). Not derived from any real match.
const SAMPLE_HOME = [
  [6, 34], [22, 12], [20, 27], [20, 41], [22, 56], [38, 22], [36, 34], [38, 46], [56, 14], [60, 34], [56, 54],
];
const SAMPLE_AWAY = [
  [99, 34], [80, 10], [83, 26], [83, 42], [80, 58], [68, 20], [70, 34], [68, 48], [60, 24], [62, 44], [52, 34],
];

const PROVENANCE = [
  {
    label: "Measured",
    tone: "accent" as const,
    text: "Taken directly from calibrated video: player positions on the pitch, team width and depth, distances between lines.",
  },
  {
    label: "Estimated",
    tone: "info" as const,
    text: "Computed from tracking that can have gaps: distance covered, heatmaps. Always shown with tracking-quality indicators.",
  },
  {
    label: "Inferred",
    tone: "warning" as const,
    text: "Tactical interpretations such as formation shape or pressing patterns. Shown with the evidence and alternative readings.",
  },
  {
    label: "Not available yet",
    tone: "neutral" as const,
    text: "Passes, shots, xG and player identity from appearance. We will not show these until models are validated.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border/60">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" aria-label="FootballAnalyzer home">
            <Logo />
          </Link>
          <div className="flex items-center gap-1 sm:gap-3">
            <a href="#how-it-works" className="hidden rounded-md px-3 py-2 text-sm text-muted hover:text-fg sm:block">
              How it works
            </a>
            <a href="#what-we-measure" className="hidden rounded-md px-3 py-2 text-sm text-muted hover:text-fg sm:block">
              What we measure
            </a>
            <ButtonLink href="/sign-in" variant="ghost">
              Sign in
            </ButtonLink>
            <ButtonLink href="/sign-up">Get started</ButtonLink>
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div>
            <Badge tone="accent">Early access</Badge>
            <h1 className="mt-5 font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight sm:text-6xl">
              Match analysis
              <br />
              <span className="text-accent">you can verify.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              Upload footage from a fixed wide-angle camera. Get positional and tactical insight where every finding
              links back to the moments in the video it came from, and is labelled with how it was produced.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/sign-up">Start free</ButtonLink>
              <ButtonLink href="#what-we-measure" variant="secondary">
                See what we measure
              </ButtonLink>
            </div>
            <p className="mt-6 text-sm text-muted">
              Available today: secure match upload and video processing. Positional analysis is in development.
            </p>
          </div>

          <figure>
            <Card className="p-3 sm:p-4">
              <Pitch title="Illustrative average player positions for two teams" className="w-full">
                {SAMPLE_HOME.map(([x, y], i) => (
                  <circle key={`h${i}`} cx={x} cy={y} r={1.6} fill="var(--accent)" stroke="#0a1003" strokeWidth={0.3} />
                ))}
                {SAMPLE_AWAY.map(([x, y], i) => (
                  <circle key={`a${i}`} cx={x} cy={y} r={1.6} fill="#f4f7fb" stroke="#0a1003" strokeWidth={0.3} />
                ))}
              </Pitch>
            </Card>
            <figcaption className="mt-3 flex items-center gap-2 text-xs text-muted">
              <Badge>Sample</Badge>
              Illustrative data, not from a real match. Average positions in pitch metres.
            </figcaption>
          </figure>
        </section>

        <section id="how-it-works" className="border-t border-border/60 bg-surface/40">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 className="font-display text-3xl font-bold uppercase tracking-tight">How it works</h2>
            <ol className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                ["Upload", "Upload straight to private storage. Only your workspace can access it.", true],
                ["Calibrate", "Mark four known pitch points once per camera position so positions are measured in metres.", false],
                ["Review the evidence", "Every metric and observation links to timestamps, with quality indicators and limitations.", false],
              ].map(([title, text, available], i) => (
                <li key={String(title)}>
                  <Card className="h-full p-6">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-display text-4xl font-bold text-accent">{String(i + 1).padStart(2, "0")}</span>
                      <Badge tone={available ? "accent" : "neutral"}>{available ? "Available" : "In development"}</Badge>
                    </div>
                    <h3 className="mt-3 text-lg font-semibold">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>
                  </Card>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="what-we-measure" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="font-display text-3xl font-bold uppercase tracking-tight">What we measure, and what we don&apos;t</h2>
          <p className="mt-3 max-w-2xl text-muted">
            Every number in a report carries one of these labels. If the footage cannot support a metric, we say so
            instead of guessing.
          </p>
          <dl className="mt-8 grid gap-4 sm:grid-cols-2">
            {PROVENANCE.map((p) => (
              <Card key={p.label} className="p-6">
                <dt>
                  <Badge tone={p.tone}>{p.label}</Badge>
                </dt>
                <dd className="mt-3 text-sm leading-relaxed text-muted">{p.text}</dd>
              </Card>
            ))}
          </dl>
        </section>

        <section className="border-t border-border/60 bg-surface/40">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 sm:px-6 md:grid-cols-2">
            <div>
              <h2 className="font-display text-3xl font-bold uppercase tracking-tight">Your footage stays yours</h2>
              <p className="mt-3 text-muted">
                Built for clubs and academies that film players, including minors.
              </p>
            </div>
            <ul className="space-y-3 text-sm text-muted">
              {[
                "Private by default: videos are never publicly accessible; links expire within minutes.",
                "Strict workspace isolation: one club can never see another club's data.",
                "Your footage is never used to train models without your explicit, separate permission.",
                "Retention limits and deletion controls for every workspace (coming soon).",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo className="text-base" />
          <p>FootballAnalyzer: early access software.</p>
        </div>
      </footer>
    </div>
  );
}
