import Link from "next/link";
import type { ReactNode } from "react";

/** Shared visual pieces for player cards and profiles (server-safe: no hooks). */

export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

export function PlayerAvatar({ name, photoUrl, className = "h-16 w-16" }: { name: string; photoUrl: string | null; className?: string }) {
  return photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
    <img src={photoUrl} alt={`Photo of ${name} from match video`} className={`${className} shrink-0 rounded-2xl border border-border bg-bg object-contain`} />
  ) : (
    <span aria-hidden="true" className={`${className} fv-stripes grid shrink-0 place-items-center rounded-2xl border border-mindaro/40 bg-lush/40 font-display font-extrabold text-mindaro`} style={{ fontSize: "1.6em" }}>
      {initials(name)}
    </span>
  );
}

export function ScoreDial({ score, size = 72, label }: { score: number | null; size?: number; label?: string }) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const v = score ?? 0;
  const colour = score == null ? "var(--pitchline)" : v >= 70 ? "var(--mindaro)" : v >= 40 ? "var(--gold)" : "var(--cascade)";
  return (
    <span className="inline-flex flex-col items-center">
      <span className="relative inline-grid place-items-center" style={{ width: size, height: size }} role="img" aria-label={score == null ? "No score yet" : `Average score ${score} out of 100`}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--pitchline)" strokeWidth="6" />
          {score != null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />}
        </svg>
        <span className="font-data absolute font-bold" style={{ fontSize: size / 3.2 }}>
          {score ?? "–"}
        </span>
      </span>
      {label && <span className="mt-1 text-[11px] uppercase tracking-wider text-muted">{label}</span>}
    </span>
  );
}

/** Tiny line of the last few scores (oldest → newest); gaps for unscored matches. */
export function FormLine({ scores, width = 96, height = 28 }: { scores: (number | null)[]; width?: number; height?: number }) {
  const pts = scores.map((s, i) => (s == null ? null : [scores.length === 1 ? width / 2 : (i / (scores.length - 1)) * (width - 6) + 3, height - 3 - (s / 100) * (height - 6)]));
  const shown = pts.filter((p): p is number[] => p != null);
  if (shown.length === 0) return <span className="text-xs text-muted">No scored matches</span>;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Form: ${scores.filter((s) => s != null).join(", ")}`}>
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="var(--pitchline)" strokeDasharray="2 3" />
      <polyline points={shown.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--mindaro)" strokeWidth="1.8" strokeLinejoin="round" />
      {shown.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === shown.length - 1 ? 3 : 2} fill="var(--mindaro)" />
      ))}
    </svg>
  );
}

export const POSITION_LABEL = { goalkeeper: "Goalkeeper", defender: "Defender", midfielder: "Midfielder", forward: "Forward" } as const;
export const FOOT_LABEL = { left: "Left-footed", right: "Right-footed", both: "Two-footed" } as const;

export function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-border bg-bg/60 px-3 py-1 text-xs text-fg/90">{children}</span>;
}

/** Profile | Development tabs for one player. */
export function ProfileTabs({ base, playerId, active, showDevelopment }: { base: string; playerId: string; active: "profile" | "development"; showDevelopment: boolean }) {
  if (!showDevelopment) return null;
  const tabs = [
    { key: "profile", label: "Profile", href: `${base}/players/${playerId}` },
    { key: "development", label: "Development", href: `${base}/players/${playerId}/development` },
  ] as const;
  return (
    <nav aria-label="Player sections" className="flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${active === t.key ? "border-mindaro text-fg" : "border-transparent text-muted hover:text-fg"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
