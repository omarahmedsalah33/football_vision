import { Pitch } from "../pitch";
import { Badge, CornerMarks } from "../ui";

// Illustrative average positions (metres). Not from a real match.
const SHAPE: [number, number][] = [
  [24, 10], [21, 26], [21, 42], [24, 58], [39, 22], [37, 34], [39, 46], [55, 14], [58, 34], [55, 54],
];
const OPP_LINE_X = 71;

function hull(points: [number, number][]) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const ROWS: { label: string; value: string; tag: "Measured" | "Estimated" | "Inferred" | "Not available"; at?: string }[] = [
  { label: "Team width", value: "44.0 m", tag: "Measured", at: "47:10" },
  { label: "Back-line height", value: "21.5 m", tag: "Measured", at: "52:14" },
  { label: "Distance covered, #10", value: "≈ 5.8 km", tag: "Estimated" },
  { label: "Shape", value: "4-3-3 in possession", tag: "Inferred", at: "58:40" },
  { label: "Expected goals (xG)", value: "-", tag: "Not available" },
];

const TAG_TONE = { Measured: "accent", Estimated: "info", Inferred: "gold", "Not available": "neutral" } as const;

export function SampleReport() {
  const h = hull(SHAPE);
  return (
    <figure className="relative">
      <div className="relative rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <CornerMarks tone="mindaro" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-data text-[11px] uppercase tracking-widest text-muted">Match report · Team shape</p>
            <p className="mt-1 font-display text-2xl font-bold uppercase">2nd half, in possession</p>
          </div>
          <Badge tone="gold">Sample</Badge>
        </div>

        <Pitch title="Illustrative team shape: average positions and the area the team covers" className="mt-4 w-full">
          <polygon
            points={h.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="var(--mindaro)"
            fillOpacity={0.12}
            stroke="var(--mindaro)"
            strokeWidth={0.35}
          />
          <line x1={OPP_LINE_X} y1={2} x2={OPP_LINE_X} y2={66} stroke="var(--gold)" strokeWidth={0.4} strokeDasharray="1.5 1.2" />
          {SHAPE.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={1.5} fill="var(--mindaro)" stroke="var(--bg-brand)" strokeWidth={0.3} />
          ))}
        </Pitch>
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span aria-hidden="true" className="inline-block w-5 border-t-2 border-dashed border-gold" />
          Opponent defensive line (secondary data)
        </p>

        <dl className="mt-5 divide-y divide-border">
          {ROWS.map((r) => (
            <div key={r.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
              <dt className="text-sm text-muted">{r.label}</dt>
              <dd className="flex items-center gap-2.5">
                <span className="font-data text-sm text-fg">{r.value}</span>
                <Badge tone={TAG_TONE[r.tag]}>{r.tag}</Badge>
                {r.at && (
                  <span className="font-data rounded border border-border px-1.5 py-0.5 text-[11px] text-mindaro">
                    ▶ {r.at}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <figcaption className="mt-3 text-xs text-muted">
        Illustrative report, not from a real match. ▶ marks the video moment each finding links to.
      </figcaption>
    </figure>
  );
}
