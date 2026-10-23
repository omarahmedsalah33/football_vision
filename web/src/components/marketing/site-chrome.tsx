import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink, CornerMarks, Logo } from "../ui";

const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/solutions", label: "Solutions" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/about", label: "About" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-bg/85 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
        <Link href="/" aria-label="Football Vision home">
          <Logo />
        </Link>
        <div className="hidden items-center gap-1 lg:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-2 text-sm text-muted hover:text-fg">
              {n.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <ButtonLink href="/sign-in" variant="ghost" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink href="/sign-up">Get started</ButtonLink>
          {/* Works without JavaScript. */}
          <details className="group relative lg:hidden">
            <summary className="grid h-10 w-10 cursor-pointer list-none place-items-center rounded-lg border border-border text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
              <span className="sr-only">Menu</span>
              <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </summary>
            <div className="absolute right-0 mt-2 w-56 rounded-xl border border-border bg-surface p-2 shadow-2xl">
              {[...NAV, { href: "/sign-in", label: "Sign in" }].map((n) => (
                <Link key={n.href} href={n.href} className="block rounded-lg px-3 py-2.5 text-sm hover:bg-surface-2">
                  {n.label}
                </Link>
              ))}
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}

const FOOTER = [
  {
    title: "Product",
    links: [
      { href: "/#how", label: "How it works" },
      { href: "/solutions", label: "Solutions" },
      { href: "/pricing", label: "Pricing" },
      { href: "/docs", label: "Docs" },
      { href: "/faq", label: "FAQ" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Trust",
    links: [
      { href: "/legal/privacy", label: "Privacy policy" },
      { href: "/legal/terms", label: "Terms of service" },
      { href: "/ai-limitations", label: "AI limitations" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Logo />
          <p className="mt-3 font-data text-xs uppercase tracking-[0.2em] text-muted">Train. Measure. Perform. Discover.</p>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
            Professional-grade football analysis, made accessible to every team. Built in Egypt.
          </p>
        </div>
        {FOOTER.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="font-display text-lg font-bold uppercase">{col.title}</p>
            <ul className="mt-3 space-y-2">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-muted hover:text-fg">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-7xl px-4 py-5 text-xs text-muted sm:px-6">
          Football Vision is early access software. Features marked “in development” are not available yet.
        </p>
      </div>
    </footer>
  );
}

/** Standard hero for inner marketing pages. */
export function PageHero({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <section className="fv-stripes relative overflow-hidden border-b border-border">
      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20">
        <CornerMarks tone="pitchline" size={26} />
        <p className="font-data text-xs uppercase tracking-[0.22em] text-mindaro">{eyebrow}</p>
        <h1 className="mt-4 max-w-4xl font-display text-5xl font-extrabold uppercase italic leading-[0.92] tracking-tight sm:text-6xl">
          {title}
        </h1>
        {children && <div className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">{children}</div>}
      </div>
    </section>
  );
}

/** Banner on legal and policy drafts. */
export function DraftNotice({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm text-fg">
      <p className="font-semibold text-gold">Draft, pending legal review</p>
      <p className="mt-1 text-muted">{children}</p>
    </div>
  );
}
