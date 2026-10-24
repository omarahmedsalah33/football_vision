import type { ReactNode } from "react";
import { dimensionByKey } from "@/lib/development/framework";
import { DIFFICULTY_LABEL, type DrillContent } from "@/lib/development/drills";
import { Badge } from "./ui";

const DIFFICULTY_TONE = { beginner: "lush", intermediate: "info", advanced: "gold" } as const;

export function DrillMeta({ drill }: { drill: DrillContent }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <Badge tone={DIFFICULTY_TONE[drill.difficulty]}>{DIFFICULTY_LABEL[drill.difficulty]}</Badge>
      <span className="font-data">{drill.durationMinutes} min</span>
      <span>{drill.players}</span>
      <span>{drill.space}</span>
    </span>
  );
}

/** Everything needed to run a drill: steps, coaching points, progressions, success, safety. */
export function DrillBody({ drill }: { drill: DrillContent }) {
  return (
    <div className="space-y-4 text-sm">
      {drill.equipment.length > 0 && (
        <p>
          <span className="font-medium">Equipment: </span>
          <span className="text-muted">{drill.equipment.join(", ")}</span>
        </p>
      )}
      <section>
        <h4 className="font-medium">How to do it</h4>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-fg/90">
          {drill.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </section>
      {drill.coachingPoints.length > 0 && (
        <section>
          <h4 className="font-medium">Coaching points</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-fg/90">
            {drill.coachingPoints.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}
      {drill.progressions.length > 0 && (
        <section>
          <h4 className="font-medium">Make it easier or harder</h4>
          <ul className="mt-1 space-y-1">
            {drill.progressions.map((p) => (
              <li key={p.level} className="flex gap-2">
                <span className="w-24 shrink-0 font-data text-xs uppercase tracking-wider text-muted">{DIFFICULTY_LABEL[p.level]}</span>
                <span className="text-fg/90">{p.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="rounded-lg border border-mindaro/30 bg-accent-soft px-3 py-2">
        <span className="font-medium text-mindaro">Success looks like: </span>
        {drill.successCriteria}
      </p>
      {drill.safety && <p className="text-xs text-muted">⚠ {drill.safety}</p>}
    </div>
  );
}

export function DimensionChips({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {keys.map((k) => (
        <span key={k} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-fg/80">
          {dimensionByKey.get(k)?.label ?? k}
        </span>
      ))}
    </span>
  );
}

/** A drill with its details folded away; `footer` (e.g. logging a session) always stays visible. */
export function DrillCard({ drill, badge, actions, footer, open = false }: { drill: DrillContent & { source?: "starter" | "custom" }; badge?: ReactNode; actions?: ReactNode; footer?: ReactNode; open?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-bg/40 has-[details[open]]:bg-bg/70">
      <details open={open} className="group p-4">
        <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 space-y-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{drill.title}</span>
              {badge}
              {drill.source === "custom" && <Badge tone="gold">Your club</Badge>}
            </span>
            <span className="block text-sm text-muted">{drill.summary}</span>
            <DrillMeta drill={drill} />
          </span>
          <span aria-hidden="true" className="mt-1 text-xs text-mindaro group-open:hidden">
            Show drill ▾
          </span>
          <span aria-hidden="true" className="mt-1 hidden text-xs text-mindaro group-open:inline">
            Hide ▴
          </span>
        </summary>
        <div className="mt-4 border-t border-border pt-4">
          <DrillBody drill={drill} />
          {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </details>
      {footer && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">{footer}</div>}
    </div>
  );
}
