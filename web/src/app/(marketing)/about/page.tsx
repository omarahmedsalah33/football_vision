import type { Metadata } from "next";
import { PageHero } from "@/components/marketing/site-chrome";
import { Card } from "@/components/ui";

export const metadata: Metadata = {
  title: "About",
  description: "Why Football Vision exists: professional-grade football analysis, accessible to every team. Built in Egypt.",
};

const VALUES = [
  {
    title: "Democratization",
    text: "Elite technology shouldn't be reserved for the few. Every academy, every club and every player deserves performance intelligence.",
  },
  {
    title: "Evidence",
    text: "We replace guesswork with data, opinions with facts and potential with proof. Every player's journey should be recorded and measurable.",
  },
  {
    title: "Innovation",
    text: "We push what AI can do for football, and keep it easy enough to use without a technician. Even parents and beginners.",
  },
  {
    title: "Integrity",
    text: "We're honest about what our technology can and can't do, and transparent about our prices. That's why every number we show carries a label.",
  },
  {
    title: "Egypt-first",
    text: "We're part of the market we serve. We build for Egyptian infrastructure, Egyptian price points and Egyptian football culture.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero eyebrow="About us" title={<>From raw talent <span className="text-mindaro">to real opportunity</span></>}>
        We exist to close the gap between talent and opportunity: turning match footage into measurable,
        professional-grade evidence that helps ordinary become superb.
      </PageHero>

      <section className="mx-auto grid max-w-7xl gap-6 px-4 py-16 sm:px-6 lg:grid-cols-2">
        <Card className="p-8" corners="mindaro">
          <p className="font-data text-xs uppercase tracking-[0.2em] text-mindaro">Our mission</p>
          <p className="mt-4 text-xl leading-relaxed">
            Build AI-powered football intelligence that captures, analyses and visualises performance, and make it
            accessible and affordable for academies, clubs, coaches, scouts and athletes across Egypt and beyond.
          </p>
        </Card>
        <Card className="p-8" corners="gold">
          <p className="font-data text-xs uppercase tracking-[0.2em] text-gold">Where we&apos;re going</p>
          <p className="mt-4 text-xl leading-relaxed">
            To become the leading football intelligence platform in Africa and the Middle East, powering talent
            discovery and player development at every level of the game.
          </p>
        </Card>
      </section>

      <section className="border-t border-border bg-surface/40">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 className="font-display text-4xl font-extrabold uppercase">What we stand for</h2>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {VALUES.map((v) => (
              <li key={v.title}>
                <Card className="h-full p-6">
                  <span aria-hidden="true" className="block h-1 w-10 rounded-full bg-gold" />
                  <h3 className="mt-4 font-display text-2xl font-bold uppercase">{v.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{v.text}</p>
                </Card>
              </li>
            ))}
          </ul>
          <p className="mt-10 max-w-3xl text-muted">
            <strong className="text-fg">Affordable never means ordinary.</strong> We hold ourselves to professional
            standards: private by default, strict separation between clubs, and no number shown without saying how
            it was produced.
          </p>
        </div>
      </section>
    </>
  );
}
