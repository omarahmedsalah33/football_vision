import Link from "next/link";
import type { ReactNode } from "react";
import type { MatchStatus } from "@/server/matches/service";
import { ButtonLink } from "./ui";

/* ------------------------------------------------------------------------------------------------
 * Icons: simple line icons in the brand's geometric style (24 px grid, 1.7 stroke).
 * --------------------------------------------------------------------------------------------- */
const paths = {
  home: <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z" strokeLinejoin="round" />,
  matches: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M12 5v14" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M3 9.5h2.5v5H3M21 9.5h-2.5v5H21" />
    </>
  ),
  members: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" strokeLinecap="round" />
      <circle cx="17" cy="9.5" r="2.3" />
      <path d="M15.8 14.4c2.2.1 3.9 1.6 4.4 4.1" strokeLinecap="round" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" strokeLinecap="round" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" strokeLinecap="round" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.7 3.6-6 7-6s6.2 2.3 7 6" strokeLinecap="round" />
    </>
  ),
  club: <path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3Z" strokeLinejoin="round" />,
  upload: <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />,
  calibrate: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <circle cx="3" cy="5" r="1.4" fill="currentColor" />
      <circle cx="21" cy="5" r="1.4" fill="currentColor" />
      <circle cx="3" cy="19" r="1.4" fill="currentColor" />
      <circle cx="21" cy="19" r="1.4" fill="currentColor" />
    </>
  ),
  analyse: (
    <>
      <circle cx="5" cy="17" r="2" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="19" cy="14" r="2" />
      <path d="M6.3 15.4 10.7 8.6M13.7 8.3l3.9 4.2" />
    </>
  ),
  results: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" />,
  docs: (
    <>
      <path d="M6 3h9l4 4v14H6z" strokeLinejoin="round" />
      <path d="M15 3v4h4M9 12h7M9 16h5" strokeLinecap="round" />
    </>
  ),
  arrow: <path d="M5 12h14m0 0-5-5m5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />,
  shirt: <path d="M8.5 3.5 4 6l1.8 4.2L8 9.4V20.5h8V9.4l2.2.8L20 6l-4.5-2.5c-.4 1.6-1.8 2.7-3.5 2.7s-3.1-1.1-3.5-2.7Z" strokeLinejoin="round" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" strokeLinecap="round" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" strokeLinejoin="round" />,
  alert: (
    <>
      <path d="M12 4 2.5 20h19L12 4Z" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2v.3" strokeLinecap="round" />
    </>
  ),
  // Training cone
  training: (
    <>
      <path d="M9.5 5h5l3.5 13h-12L9.5 5Z" strokeLinejoin="round" />
      <path d="M8.4 10h7.2M7.3 14h9.4M3 18.5h18" strokeLinecap="round" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  chat: <path d="M4 5.5h16v10H10l-4.5 3.5v-3.5H4z" strokeLinejoin="round" />,
  trend: <path d="M3 17l6-6 4 4 8-8m0 0h-5m5 0v5" strokeLinecap="round" strokeLinejoin="round" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Page header with breadcrumbs.
 * --------------------------------------------------------------------------------------------- */
export function PageHeader({
  crumbs = [],
  title,
  description,
  actions,
}: {
  crumbs?: { label: string; href?: string }[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1.5 font-data text-[11px] uppercase tracking-[0.18em] text-muted">
              {crumbs.map((c, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true" className="text-pitchline">/</span>}
                  {c.href ? (
                    <Link href={c.href} className="hover:text-mindaro">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current="page" className="text-fg/80">
                      {c.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="font-display text-4xl font-extrabold uppercase leading-none tracking-tight sm:text-5xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Match pipeline: where a match is on the way from footage to results.
 * --------------------------------------------------------------------------------------------- */
export const PIPELINE: { key: string; label: string; icon: IconName }[] = [
  { key: "upload", label: "Upload", icon: "upload" },
  { key: "check", label: "Check", icon: "check" },
  { key: "calibrate", label: "Calibrate", icon: "calibrate" },
  { key: "analyse", label: "Analyse", icon: "analyse" },
  { key: "results", label: "Results", icon: "results" },
];

type StepState = "done" | "current" | "active" | "error" | "todo";

/** Current step index and its state for a match status. */
export function pipelinePosition(status: MatchStatus): { index: number; state: StepState } {
  switch (status) {
    case "awaiting_upload":
    case "uploading":
      return { index: 0, state: "current" };
    case "upload_rejected":
      return { index: 0, state: "error" };
    case "checking":
      return { index: 1, state: "active" };
    case "needs_calibration":
      return { index: 2, state: "current" };
    case "ready":
      return { index: 3, state: "current" };
    case "queued":
    case "processing":
      return { index: 3, state: "active" };
    case "failed":
    case "cancelled":
      return { index: 3, state: "error" };
    case "analyzed":
      return { index: 4, state: "done" };
  }
}

/** What the user should do next, in their words, and where. */
export function nextAction(status: MatchStatus, matchHref: string): { label: string; href?: string; waiting?: boolean } {
  switch (status) {
    case "awaiting_upload":
      return { label: "Upload the video", href: matchHref };
    case "uploading":
      return { label: "Finish the upload", href: matchHref };
    case "upload_rejected":
      return { label: "Upload another file", href: matchHref };
    case "checking":
      return { label: "Checking the video…", waiting: true };
    case "needs_calibration":
      return { label: "Calibrate the pitch", href: `${matchHref}/calibrate` };
    case "ready":
      return { label: "Start the analysis", href: matchHref };
    case "queued":
      return { label: "Waiting to start…", waiting: true };
    case "processing":
      return { label: "Analysing…", waiting: true };
    case "failed":
      return { label: "Try again", href: matchHref };
    case "cancelled":
      return { label: "Start again", href: matchHref };
    case "analyzed":
      return { label: "View results", href: `${matchHref}#results-heading` };
  }
}

export const NEEDS_ACTION: MatchStatus[] = ["awaiting_upload", "uploading", "upload_rejected", "needs_calibration", "ready", "failed", "cancelled"];
export const IN_PROGRESS: MatchStatus[] = ["checking", "queued", "processing"];

export function Pipeline({ status, compact = false }: { status: MatchStatus; compact?: boolean }) {
  const { index, state } = pipelinePosition(status);
  return (
    <ol className="flex items-center" aria-label={`Progress: ${PIPELINE[index].label}${state === "done" ? ", finished" : state === "error" ? ", needs attention" : ""}`}>
      {PIPELINE.map((step, i) => {
        const s: StepState = i < index || state === "done" ? "done" : i === index ? state : "todo";
        const dot =
          s === "done"
            ? "border-mindaro bg-mindaro text-accent-fg"
            : s === "error"
              ? "border-danger bg-danger/15 text-danger"
              : s === "active"
                ? "border-gold bg-gold/15 text-gold"
                : s === "current"
                  ? "border-mindaro bg-accent-soft text-mindaro"
                  : "border-pitchline bg-bg text-cascade/60";
        return (
          <li key={step.key} className="flex flex-1 items-center last:flex-none" aria-current={i === index ? "step" : undefined}>
            <span className="flex flex-col items-center gap-1">
              <span className={`relative grid place-items-center rounded-full border ${compact ? "h-6 w-6" : "h-9 w-9"} ${dot}`}>
                {s === "done" ? <Icon name="check" className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} /> : <Icon name={step.icon} className={compact ? "h-3.5 w-3.5" : "h-4.5 w-4.5"} />}
                {s === "active" && <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full border border-gold/60 motion-reduce:hidden" />}
              </span>
              {!compact && <span className={`text-[11px] font-medium ${s === "todo" ? "text-muted/70" : "text-fg"}`}>{step.label}</span>}
            </span>
            {i < PIPELINE.length - 1 && (
              <span aria-hidden="true" className={`mx-1 h-px flex-1 ${compact ? "" : "-mt-5"} ${i < index || state === "done" ? "bg-mindaro" : "bg-pitchline"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Tiles, thumbnails and empty states.
 * --------------------------------------------------------------------------------------------- */
export function StatTile({ label, value, note, tone = "mindaro" }: { label: string; value: ReactNode; note?: ReactNode; tone?: "mindaro" | "gold" | "fg" }) {
  const colour = { mindaro: "text-mindaro", gold: "text-gold", fg: "text-fg" }[tone];
  return (
    <div className="rounded-xl border border-border bg-surface/80 p-4">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`font-data mt-2 text-3xl font-bold ${colour}`}>{value}</dd>
      {note && <dd className="mt-1 text-xs text-muted">{note}</dd>}
    </div>
  );
}

/** A frame from the match video, or pitch line art when there is no frame yet. */
export function MatchThumb({ url, title, className = "" }: { url?: string | null; title: string; className?: string }) {
  return (
    <div className={`relative aspect-video overflow-hidden bg-forest ${className}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
        <img src={url} alt={`Frame from ${title}`} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <PitchArt />
      )}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg/80 via-transparent to-transparent" />
    </div>
  );
}

export function PitchArt({ className = "h-full w-full" }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 90" className={`fv-stripes ${className}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="160" height="90" style={{ fill: "color-mix(in srgb, var(--forest) 85%, var(--lush))" }} />
      <g fill="none" style={{ stroke: "color-mix(in srgb, var(--white) 22%, transparent)" }} strokeWidth="0.8">
        <path d="M30 18h100l18 56H12z" />
        <path d="M80 18v56" />
        <ellipse cx="80" cy="44" rx="13" ry="7.5" />
        <path d="M24.5 32h15l-4 26h-17.5M135.5 32h-15l4 26h17.5" />
      </g>
      <circle cx="80" cy="44" r="1.3" fill="var(--gold)" />
    </svg>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border-strong bg-surface/50 px-6 py-12 text-center">
      <div className="mx-auto w-48 overflow-hidden rounded-xl border border-border">
        <PitchArt className="block h-auto w-full" />
      </div>
      <h2 className="mt-6 font-display text-2xl font-bold uppercase">{title}</h2>
      <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

export function NextActionLink({ status, matchHref, canAct }: { status: MatchStatus; matchHref: string; canAct: boolean }) {
  const a = nextAction(status, matchHref);
  if (a.waiting)
    return (
      <span className="inline-flex items-center gap-2 text-sm text-gold">
        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-gold motion-reduce:animate-none" />
        {a.label}
      </span>
    );
  if (!canAct && status !== "analyzed") return <span className="text-sm text-muted">Waiting for staff</span>;
  return (
    <ButtonLink href={a.href!} variant={status === "analyzed" ? "secondary" : "primary"} className="!px-3 !py-1.5 text-xs">
      {a.label}
      <Icon name="arrow" className="h-3.5 w-3.5" />
    </ButtonLink>
  );
}
