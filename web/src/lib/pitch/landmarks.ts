/**
 * Pitch landmarks in metres. Coordinate system (shared with the worker and every chart):
 *   x: 0 at the left goal line → pitchLength at the right goal line (as seen from the camera)
 *   y: 0 at the far touchline → pitchWidth at the near touchline (closest to the camera)
 * Box and circle sizes are fixed by the Laws of the Game; length and width vary by pitch.
 */
export type PitchSize = { length: number; width: number };
export const STANDARD_PITCH: PitchSize = { length: 105, width: 68 };

export type Landmark = { id: string; label: string; group: string; at: (p: PitchSize) => [number, number] };

const PEN_DEPTH = 16.5;
const PEN_HALF = 20.16; // 40.32 / 2
const GOAL_AREA_DEPTH = 5.5;
const GOAL_AREA_HALF = 9.16; // 18.32 / 2
const PEN_SPOT = 11;
const CIRCLE_R = 9.15;

function sided(side: "left" | "right") {
  const L = side === "left" ? "Left" : "Right";
  const x = (p: PitchSize, d: number) => (side === "left" ? d : p.length - d);
  const group = `${L} half`;
  return [
    { id: `${side}_corner_far`, label: `${L} corner, far side`, group, at: (p: PitchSize) => [x(p, 0), 0] },
    { id: `${side}_corner_near`, label: `${L} corner, near side`, group, at: (p: PitchSize) => [x(p, 0), p.width] },
    { id: `${side}_box_goalline_far`, label: `${L} penalty box meets goal line, far`, group, at: (p: PitchSize) => [x(p, 0), p.width / 2 - PEN_HALF] },
    { id: `${side}_box_goalline_near`, label: `${L} penalty box meets goal line, near`, group, at: (p: PitchSize) => [x(p, 0), p.width / 2 + PEN_HALF] },
    { id: `${side}_box_far`, label: `${L} penalty box corner, far`, group, at: (p: PitchSize) => [x(p, PEN_DEPTH), p.width / 2 - PEN_HALF] },
    { id: `${side}_box_near`, label: `${L} penalty box corner, near`, group, at: (p: PitchSize) => [x(p, PEN_DEPTH), p.width / 2 + PEN_HALF] },
    { id: `${side}_six_goalline_far`, label: `${L} goal area meets goal line, far`, group, at: (p: PitchSize) => [x(p, 0), p.width / 2 - GOAL_AREA_HALF] },
    { id: `${side}_six_goalline_near`, label: `${L} goal area meets goal line, near`, group, at: (p: PitchSize) => [x(p, 0), p.width / 2 + GOAL_AREA_HALF] },
    { id: `${side}_six_far`, label: `${L} goal area corner, far`, group, at: (p: PitchSize) => [x(p, GOAL_AREA_DEPTH), p.width / 2 - GOAL_AREA_HALF] },
    { id: `${side}_six_near`, label: `${L} goal area corner, near`, group, at: (p: PitchSize) => [x(p, GOAL_AREA_DEPTH), p.width / 2 + GOAL_AREA_HALF] },
    { id: `${side}_penalty_spot`, label: `${L} penalty spot`, group, at: (p: PitchSize) => [x(p, PEN_SPOT), p.width / 2] },
  ] satisfies Landmark[];
}

export const LANDMARKS: Landmark[] = [
  { id: "halfway_far", label: "Halfway line meets far touchline", group: "Centre", at: (p) => [p.length / 2, 0] },
  { id: "halfway_near", label: "Halfway line meets near touchline", group: "Centre", at: (p) => [p.length / 2, p.width] },
  { id: "centre_spot", label: "Centre spot", group: "Centre", at: (p) => [p.length / 2, p.width / 2] },
  { id: "circle_far", label: "Centre circle crosses halfway line, far", group: "Centre", at: (p) => [p.length / 2, p.width / 2 - CIRCLE_R] },
  { id: "circle_near", label: "Centre circle crosses halfway line, near", group: "Centre", at: (p) => [p.length / 2, p.width / 2 + CIRCLE_R] },
  ...sided("left"),
  ...sided("right"),
];

export const LANDMARK_BY_ID = new Map(LANDMARKS.map((l) => [l.id, l]));

/** Straight pitch markings as segments, used to draw the calibrated overlay on the video frame. */
export function pitchSegments(p: PitchSize): [[number, number], [number, number]][] {
  const { length: L, width: W } = p;
  const segs: [[number, number], [number, number]][] = [
    [[0, 0], [L, 0]],
    [[0, W], [L, W]],
    [[0, 0], [0, W]],
    [[L, 0], [L, W]],
    [[L / 2, 0], [L / 2, W]],
  ];
  for (const s of [0, 1]) {
    const x = (d: number) => (s === 0 ? d : L - d);
    const y1 = W / 2 - PEN_HALF;
    const y2 = W / 2 + PEN_HALF;
    segs.push([[x(0), y1], [x(PEN_DEPTH), y1]], [[x(PEN_DEPTH), y1], [x(PEN_DEPTH), y2]], [[x(PEN_DEPTH), y2], [x(0), y2]]);
    const g1 = W / 2 - GOAL_AREA_HALF;
    const g2 = W / 2 + GOAL_AREA_HALF;
    segs.push([[x(0), g1], [x(GOAL_AREA_DEPTH), g1]], [[x(GOAL_AREA_DEPTH), g1], [x(GOAL_AREA_DEPTH), g2]], [[x(GOAL_AREA_DEPTH), g2], [x(0), g2]]);
  }
  return segs;
}
