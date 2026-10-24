import type { Metadata } from "next";
import { PageHero } from "@/components/marketing/site-chrome";
import { Badge, ButtonLink, Card } from "@/components/ui";

export const metadata: Metadata = {
  title: "Solutions",
  description: "How Football Vision helps academies, clubs, coaches, analysts, scouts and players.",
};

type Solution = { id: string; title: string; pitch: string; today: string[]; planned: string[] };

const SOLUTIONS: Solution[] = [
  {
    id: "academies",
    title: "Academies",
    pitch:
      "Your players grow every season. Record that growth with evidence you can show players, parents and the scouts who come looking.",
    today: [
      "Private workspace for your academy",
      "Secure upload of full matches",
      "Staff roles with clear permissions",
      "Beta: a profile for every squad player, built match after match",
    ],
    planned: ["Development objectives set by coaches", "Shareable progress reports"],
  },
  {
    id: "clubs",
    title: "Clubs",
    pitch: "One shared view of every match for your whole staff, with each person seeing exactly what their role allows.",
    today: [
      "Club workspaces with owner, admin, coach, analyst, scout and player roles",
      "Match library with processing status",
      "Beta: team shape after every analysed match",
    ],
    planned: ["Multiple teams and squads", "Team shape and tactical trends across the season", "Club-branded reports"],
  },
  {
    id: "coaches",
    title: "Coaches & analysts",
    pitch: "Spend your time coaching, not scrubbing through video. Go straight to the moments that matter for training.",
    today: [
      "Upload straight from your laptop, even large files",
      "Automatic checks that the video can be analysed",
      "Pitch calibration with the error shown in metres",
      "Beta: team width, depth and line heights in metres",
      "Beta: average positions and heatmaps with tracking-quality indicators",
    ],
    planned: [
      "Per-player physical and positional reports",
      "Every finding linked to the moment in the video",
      "Ask questions about a match and get answers linked to the video",
    ],
  },
  {
    id: "scouts",
    title: "Scouts",
    pitch: "Compare players on evidence, not highlight reels, and see exactly what every claim is based on.",
    today: ["Read-only scout role inside a club's workspace"],
    planned: ["Structured scouting reports", "Player comparisons with provenance on every metric"],
  },
  {
    id: "players",
    title: "Players & parents",
    pitch: "Simple enough to use without a technician. See your progress, match after match.",
    today: [
      "Your own player profile, set up when you sign up",
      "Beta: a score out of 100 for every match, and your form over time",
      "Beta: top speed, sprints, distance and where you play",
      "Strengths and weaknesses that hold across your matches",
      "Parents: follow your child's profile from your own workspace",
    ],
    planned: ["Goals, assists and shots (needs ball tracking)", "Share your profile with a coach or scout"],
  },
];

export default function SolutionsPage() {
  return (
    <>
      <PageHero eyebrow="Solutions" title={<>Built for <span className="text-mindaro">everyone who lives the game</span></>}>
        Each role gets the view it needs. Here is what is available today and what we are building next, kept
        honest so you can plan around it.
      </PageHero>
      <section className="mx-auto max-w-7xl space-y-6 px-4 py-16 sm:px-6">
        {SOLUTIONS.map((s) => (
          <Card key={s.id} className="scroll-mt-24 p-6 sm:p-8" corners="pitchline">
            <article id={s.id} className="grid gap-8 lg:grid-cols-[1.1fr_1fr_1fr]">
              <div>
                <span aria-hidden="true" className="block h-1 w-12 rounded-full bg-gold" />
                <h2 className="mt-4 font-display text-4xl font-extrabold uppercase">{s.title}</h2>
                <p className="mt-3 leading-relaxed text-muted">{s.pitch}</p>
              </div>
              <div>
                <Badge tone="accent">Available today</Badge>
                <ul className="mt-4 space-y-2 text-sm">
                  {s.today.map((t) => (
                    <li key={t} className="flex gap-2">
                      <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-mindaro" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <Badge>In development</Badge>
                <ul className="mt-4 space-y-2 text-sm text-muted">
                  {s.planned.map((t) => (
                    <li key={t} className="flex gap-2">
                      <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full border border-cascade" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          </Card>
        ))}
        <div className="flex flex-wrap items-center gap-3 pt-4">
          <ButtonLink href="/sign-up">Start free</ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Talk to us about your club
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
