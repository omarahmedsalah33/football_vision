import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 sm:py-2.5";
const variants = {
  primary: "bg-accent text-accent-fg hover:bg-[#d4ff4a]",
  secondary: "border border-border-strong bg-surface-2 text-fg hover:border-muted",
  ghost: "text-muted hover:text-fg hover:bg-surface-2",
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

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-border bg-surface ${className}`}>{children}</div>;
}

const tones = {
  neutral: "border-border-strong text-muted",
  accent: "border-accent/40 bg-accent-soft text-accent",
  info: "border-info/40 bg-info/10 text-info",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap font-display text-lg font-bold tracking-wide sm:text-xl ${className}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 shrink-0">
        <rect x="1.5" y="4" width="21" height="16" rx="2" fill="none" stroke="var(--accent)" strokeWidth="1.8" />
        <line x1="12" y1="4" x2="12" y2="20" stroke="var(--accent)" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.2" fill="none" stroke="var(--accent)" strokeWidth="1.8" />
      </svg>
      FOOTBALL<span className="text-accent">ANALYZER</span>
    </span>
  );
}
