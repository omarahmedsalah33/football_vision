import type { ReactNode } from "react";

/** Pitch dimensions in metres. Overlays are drawn in this coordinate system (x: 0–105, y: 0–68). */
export const PITCH = { length: 105, width: 68 } as const;

const PAD = 3;

/**
 * Football pitch with FIFA-standard markings. Children are SVG elements positioned in pitch
 * metres, so analytics overlays share one documented coordinate system with the worker output.
 */
export function Pitch({ children, title, className }: { children?: ReactNode; title: string; className?: string }) {
  const { length: L, width: W } = PITCH;
  const line = { fill: "none", stroke: "var(--pitch-line)", strokeWidth: 0.3 } as const;
  const penW = 40.32;
  const goalAreaW = 18.32;
  return (
    <svg
      viewBox={`${-PAD} ${-PAD} ${L + PAD * 2} ${W + PAD * 2}`}
      role="img"
      aria-label={title}
      className={className}
    >
      <title>{title}</title>
      <defs>
        <pattern id="pitch-stripes" width="10.5" height={W} patternUnits="userSpaceOnUse">
          <rect width="5.25" height={W} fill="#0f3b26" />
          <rect x="5.25" width="5.25" height={W} fill="#0d3421" />
        </pattern>
      </defs>
      <rect x={-PAD} y={-PAD} width={L + PAD * 2} height={W + PAD * 2} rx="2" fill="#0b2c1c" />
      <rect width={L} height={W} fill="url(#pitch-stripes)" />
      <rect width={L} height={W} {...line} />
      <line x1={L / 2} y1={0} x2={L / 2} y2={W} {...line} />
      <circle cx={L / 2} cy={W / 2} r={9.15} {...line} />
      <circle cx={L / 2} cy={W / 2} r={0.4} fill="var(--pitch-line)" />
      {[0, 1].map((side) => {
        const x = side === 0 ? 0 : L;
        const dir = side === 0 ? 1 : -1;
        const penX = side === 0 ? 0 : L - 16.5;
        const gaX = side === 0 ? 0 : L - 5.5;
        const spotX = x + dir * 11;
        // Penalty arc: the part of the 9.15 m circle around the spot outside the penalty area.
        const dx = 16.5 - 11;
        const dy = Math.sqrt(9.15 ** 2 - dx ** 2);
        const arcX = x + dir * 16.5;
        return (
          <g key={side}>
            <rect x={penX} y={(W - penW) / 2} width={16.5} height={penW} {...line} />
            <rect x={gaX} y={(W - goalAreaW) / 2} width={5.5} height={goalAreaW} {...line} />
            <circle cx={spotX} cy={W / 2} r={0.4} fill="var(--pitch-line)" />
            <path
              d={`M ${arcX} ${W / 2 - dy} A 9.15 9.15 0 0 ${side === 0 ? 1 : 0} ${arcX} ${W / 2 + dy}`}
              {...line}
            />
            <rect x={side === 0 ? -2 : L} y={W / 2 - 3.66} width={2} height={7.32} {...line} />
          </g>
        );
      })}
      {children}
    </svg>
  );
}
