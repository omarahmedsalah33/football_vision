import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "@/components/marketing/site-chrome";
import { Badge } from "@/components/ui";

export const metadata: Metadata = {
  title: "AI limitations",
  description: "What Football Vision's AI can and can't measure, how to read confidence labels, and when to rely on a human.",
};

const LIMITS: [string, string][] = [
  ["Players hidden behind each other", "When players overlap, one may be missed or two may swap identities. Tracking quality indicators show where this happened."],
  ["Distance from the camera", "Players far from the camera cover few pixels, so they are detected less reliably. Higher, closer camera positions help."],
  ["Camera movement", "A camera that turns and zooms from one spot is followed from the frame you calibrate, and every placement is checked against the pitch lines; moments that can't be confirmed (cuts, replays, close-ups, few lines in view) are left out and counted. Positions from moving cameras are always labelled estimated. A camera carried around can't be followed."],
  ["Light and weather", "Strong shadows, backlight, rain and poor floodlights reduce accuracy."],
  ["Low resolution", "Below 1080p, small details like the ball and shirt colours are harder to see."],
  ["Similar kits", "Teams are told apart by kit colour. Similar colours, or a goalkeeper or referee in a team's colours, can cause mix-ups."],
];

export default function AiLimitationsPage() {
  return (
    <>
      <PageHero eyebrow="Integrity" title={<>What our AI <span className="text-gold">can&apos;t</span> do</>}>
        Honest limits, so you know when to trust a number and when to watch the clip yourself.
      </PageHero>
      <article className="fv-prose mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h2>Where we are today</h2>
        <p>
          Football Vision checks uploaded video, calibrates the pitch and tracks players to measure team shape.
          Tracking and team shape are in beta: the calculations are tested against a synthetic match with known
          answers, but accuracy on real football hasn&apos;t been measured yet. This page will include accuracy
          measured on reference matches when it is. We will not publish accuracy claims before we have measured them.
        </p>

        <h2>Every number has a label</h2>
        <ul>
          <li><Badge tone="accent">Measured</Badge> directly from calibrated video.</li>
          <li><Badge tone="info">Estimated</Badge> from tracking that can have gaps; check the quality indicator.</li>
          <li><Badge tone="gold">Inferred</Badge> an interpretation; we show the evidence and other possible readings.</li>
          <li><Badge>Not available</Badge> the footage can&apos;t support it, so we don&apos;t show a number.</li>
        </ul>

        <h2>What we don&apos;t do</h2>
        <ul>
          <li>We don&apos;t identify players by face or appearance. Your staff link tracked players to names.</li>
          <li>We don&apos;t detect passes, shots, tackles or xG yet. We won&apos;t until those models are validated.</li>
          <li>We don&apos;t analyse live: only recordings, after the match.</li>
          <li>Fixed, elevated, wide recordings work best. Handheld, broadcast or close-up footage may miss actions or mix up players, and we can&apos;t promise accuracy on any recording.</li>
          <li>We don&apos;t judge a player&apos;s potential, character, health or future. Nobody should, from video alone.</li>
        </ul>

        <h2>What affects accuracy</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Situation</th>
              <th scope="col">Effect</th>
            </tr>
          </thead>
          <tbody>
            {LIMITS.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Keep a human in the loop</h2>
        <p>
          Use results to decide what to review, not as the final word. Before decisions that matter to a person,
          such as selection, contracts or anything involving minors, watch the linked clips and involve a coach.
          The <Link href="/docs#filming">filming guide</Link> explains how to get the most reliable results.
        </p>
      </article>
    </>
  );
}
