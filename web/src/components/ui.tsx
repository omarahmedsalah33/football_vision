import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 sm:py-2.5";
const variants = {
  primary: "bg-mindaro text-accent-fg hover:bg-[color-mix(in_srgb,var(--mindaro)_85%,white)]",
  gold: "bg-gold text-accent-fg hover:bg-[color-mix(in_srgb,var(--gold)_85%,white)]",
  secondary: "border border-border-strong bg-surface text-fg hover:border-cascade",
  ghost: "text-muted hover:text-fg hover:bg-surface",
  danger: "border border-danger/40 text-danger hover:bg-danger/10",
} as const;
type Variant = keyof typeof variants;

export function Button({ variant = "primary", className = "", ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

/**
 * Brand corner elements: quarter-circle arcs taken from pitch corner markings. Decorative only.
 */
export function CornerMarks({ tone = "pitchline", size = 18 }: { tone?: "pitchline" | "mindaro" | "gold"; size?: number }) {
  const color = { pitchline: "var(--pitchline)", mindaro: "var(--mindaro)", gold: "var(--gold)" }[tone];
  const corners = [
    { pos: "left-0 top-0", d: `M 1 ${size} A ${size - 1} ${size - 1} 0 0 1 ${size} 1` },
    { pos: "right-0 top-0", d: `M 0 1 A ${size - 1} ${size - 1} 0 0 1 ${size - 1} ${size}` },
    { pos: "right-0 bottom-0", d: `M ${size - 1} 0 A ${size - 1} ${size - 1} 0 0 1 0 ${size - 1}` },
    { pos: "left-0 bottom-0", d: `M ${size} ${size - 1} A ${size - 1} ${size - 1} 0 0 1 1 0` },
  ];
  return (
    <>
      {corners.map((c) => (
        <svg
          key={c.pos}
          aria-hidden="true"
          width={size}
          height={size}
          className={`pointer-events-none absolute ${c.pos} m-2`}
          viewBox={`0 0 ${size} ${size}`}
        >
          <path d={c.d} fill="none" stroke={color} strokeWidth="1.5" />
        </svg>
      ))}
    </>
  );
}

export function Card({
  children,
  className = "",
  corners,
}: {
  children: ReactNode;
  className?: string;
  corners?: "pitchline" | "mindaro" | "gold";
}) {
  return (
    <div className={`relative rounded-xl border border-border bg-surface ${className}`}>
      {corners && <CornerMarks tone={corners} />}
      {children}
    </div>
  );
}

const tones = {
  neutral: "border-border-strong text-muted",
  accent: "border-mindaro/40 bg-accent-soft text-mindaro",
  gold: "border-gold/45 bg-gold/10 text-gold",
  lush: "border-lush/60 bg-lush/15 text-fg",
  info: "border-cascade/40 bg-cascade/10 text-cascade",
  warning: "border-gold/45 bg-gold/10 text-gold",
  danger: "border-danger/40 bg-danger/10 text-danger",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** The mark: an eye (vision) drawn as a pitch: halfway line, centre-circle iris, gold centre spot. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M2.5 16 C 8 6.5, 24 6.5, 29.5 16 C 24 25.5, 8 25.5, 2.5 16 Z" fill="none" stroke="var(--mindaro)" strokeWidth="2.2" strokeLinejoin="round" />
      <line x1="16" y1="8.6" x2="16" y2="23.4" stroke="var(--mindaro)" strokeWidth="1.6" />
      <circle cx="16" cy="16" r="4.6" fill="var(--bg-brand)" stroke="var(--mindaro)" strokeWidth="2" />
      <circle cx="16" cy="16" r="1.7" fill="var(--gold)" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap font-display text-xl font-extrabold uppercase tracking-wide sm:text-2xl ${className}`}>
      <LogoMark />
      <span>
        Football <span className="text-mindaro">Vision</span>
      </span>
    </span>
  );
}
