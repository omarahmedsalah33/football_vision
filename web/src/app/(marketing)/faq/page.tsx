import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHero } from "@/components/marketing/site-chrome";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers about footage, cameras, accuracy, privacy, pricing and what Football Vision can do today.",
};

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "What can Football Vision do today?",
    a: "You can create a workspace, add matches, upload full match videos securely and have them checked and processed. Player tracking, tactical analysis and reports are in development. Features that aren't ready are always marked “in development”.",
  },
  {
    q: "What kind of camera footage works?",
    a: (
      <>
        A fixed, wide-angle camera that sees most of the pitch: on a tripod or a raised position near the halfway
        line, without zooming or panning. Broadcast TV footage and handheld phone videos aren&apos;t supported yet.
        See the <Link href="/docs#filming">filming guide</Link>.
      </>
    ),
  },
  {
    q: "How accurate is it?",
    a: (
      <>
        We will publish measured accuracy once our evaluation on reference matches is complete. Until then we
        won&apos;t quote numbers. Every metric will carry a label (measured, estimated, inferred or not
        available) so you always know how much to trust it. Read our{" "}
        <Link href="/ai-limitations">AI limitations</Link>.
      </>
    ),
  },
  {
    q: "Can it recognise who a player is?",
    a: "No. We never identify people from their face or appearance. Your staff assign names and shirt numbers to the players the system follows.",
  },
  {
    q: "Who can see our videos?",
    a: "Only members of your workspace, according to their role. Videos are stored privately, links to view them expire within minutes, and one club can never see another club's data.",
  },
  {
    q: "Do you use our footage to train your AI?",
    a: "Not without your explicit, separate permission. Using Football Vision doesn't give us that permission.",
  },
  {
    q: "We film youth players. What do we need to do?",
    a: "Make sure you have consent from each player's parent or guardian before uploading footage of minors. Your club stays in control of the footage, and you can delete it at any time.",
  },
  {
    q: "How much does it cost?",
    a: (
      <>
        You can start free with one analysis per month. Paid plans will be priced in Egyptian pounds and
        announced at launch. Plan limits are already on the <Link href="/pricing">pricing page</Link>.
      </>
    ),
  },
  {
    q: "Is the analysis live during the match?",
    a: "No. You upload the recording after the match and Football Vision processes it. Live analysis is not part of the product today.",
  },
  {
    q: "Which video files can I upload?",
    a: "MP4, MOV, M4V, MKV and WebM, at least 640×360 (1080p or higher recommended), between 10 seconds and your plan's maximum length.",
  },
];

export default function FaqPage() {
  return (
    <>
      <PageHero eyebrow="FAQ" title={<>Straight <span className="text-mindaro">answers</span></>}>
        The questions coaches, clubs and parents ask us most. Can&apos;t find yours?{" "}
        <Link href="/contact" className="text-mindaro underline underline-offset-4">
          Ask us
        </Link>
        .
      </PageHero>
      <section className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <div className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                {f.q}
                <span aria-hidden="true" className="font-data text-mindaro transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <div className="fv-prose mt-3 text-base">
                <p>{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
