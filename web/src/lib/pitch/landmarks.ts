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

/** Players per side. Small-sided pitches have no standard boxes, so only shape-free landmarks apply. */
export const PLAYERS_PER_SIDE = [5, 6, 7, 8, 9, 11] as const;
export type PlayersPerSide = (typeof PLAYERS_PER_SIDE)[number];

export type PitchFormat = { id: string; label: string; help: string; playersPerSide: PlayersPerSide; size: PitchSize };

/** Typical sizes, used as defaults. Users should enter their real size: distances scale with it. */
export const PITCH_FORMATS: PitchFormat[] = [
  { id: "11", label: "Full size", help: "11-a-side, with penalty boxes", playersPerSide: 11, size: STANDARD_PITCH },
  { id: "9", label: "9-a-side", help: "Youth or small full pitch", playersPerSide: 9, size: { length: 73, width: 46 } },
  { id: "7", label: "7- or 8-a-side", help: "Half pitch or 7s pitch", playersPerSide: 7, size: { length: 55, width: 37 } },
  { id: "5", label: "5- or 6-a-side", help: "Small artificial pitch", playersPerSide: 5, size: { length: 40, width: 20 } },
];

/**
 * Box, goal-area and penalty-spot landmarks assume Laws of the Game markings, which only exist on
 * 11-a-side pitches (90–120 m × 45–90 m). Elsewhere, only corners and halfway landmarks are valid.
 */
export function hasStandardBoxes(size: PitchSize, playersPerSide: number): boolean {
  return playersPerSide === 11 && size.length >= 90 && size.width >= 45;
}

const SHAPE_FREE = new Set(["halfway_far", "halfway_near", "centre_spot", "left_corner_far", "left_corner_near", "right_corner_far", "right_corner_near"]);

export function landmarksFor(size: PitchSize, playersPerSide: number): Landmark[] {
  return hasStandardBoxes(size, playersPerSide) ? LANDMARKS : LANDMARKS.filter((l) => SHAPE_FREE.has(l.id));
}

/**
 * The order the guided calibration asks for points: well spread first (corners and halfway line), then
 * points that are usually visible when corners are not. Users skip points they can't see.
 */
const GUIDED_ORDER = [
  "left_corner_far",
  "halfway_far",
  "right_corner_far",
  "right_corner_near",
  "halfway_near",
  "left_corner_near",
  "centre_spot",
  "left_box_far",
  "left_box_near",
  "right_box_far",
  "right_box_near",
  "left_penalty_spot",
  "right_penalty_spot",
  "circle_far",
  "circle_near",
  "left_six_far",
  "left_six_near",
  "right_six_far",
  "right_six_near",
  "left_box_goalline_far",
  "left_box_goalline_near",
  "right_box_goalline_far",
  "right_box_goalline_near",
  "left_six_goalline_far",
  "left_six_goalline_near",
  "right_six_goalline_far",
  "right_six_goalline_near",
];

export function guidedOrder(size: PitchSize, playersPerSide: number): Landmark[] {
  const allowed = new Set(landmarksFor(size, playersPerSide).map((l) => l.id));
  return GUIDED_ORDER.filter((id) => allowed.has(id)).map((id) => LANDMARK_BY_ID.get(id)!);
}

/** Short, plain instructions for the guided calibration ("far" = the side away from the camera). */
export const LANDMARK_HINT: Record<string, string> = {
  left_corner_far: "the far-left corner",
  left_corner_near: "the near-left corner",
  right_corner_far: "the far-right corner",
  right_corner_near: "the near-right corner",
  halfway_far: "where the halfway line meets the far touchline",
  halfway_near: "where the halfway line meets the near touchline",
  centre_spot: "the centre spot",
  circle_far: "where the centre circle crosses the halfway line, far side",
  circle_near: "where the centre circle crosses the halfway line, near side",
  left_box_far: "the far corner of the left penalty box",
  left_box_near: "the near corner of the left penalty box",
  right_box_far: "the far corner of the right penalty box",
  right_box_near: "the near corner of the right penalty box",
  left_penalty_spot: "the left penalty spot",
  right_penalty_spot: "the right penalty spot",
  left_six_far: "the far corner of the left goal area",
  left_six_near: "the near corner of the left goal area",
  right_six_far: "the far corner of the right goal area",
  right_six_near: "the near corner of the right goal area",
  left_box_goalline_far: "where the left penalty box meets the goal line, far side",
  left_box_goalline_near: "where the left penalty box meets the goal line, near side",
  right_box_goalline_far: "where the right penalty box meets the goal line, far side",
  right_box_goalline_near: "where the right penalty box meets the goal line, near side",
  left_six_goalline_far: "where the left goal area meets the goal line, far side",
  left_six_goalline_near: "where the left goal area meets the goal line, near side",
  right_six_goalline_far: "where the right goal area meets the goal line, far side",
  right_six_goalline_near: "where the right goal area meets the goal line, near side",
};

/** Straight pitch markings as segments, used to draw the calibrated overlay on the video frame. */
export function pitchSegments(p: PitchSize, boxes = true): [[number, number], [number, number]][] {
  const { length: L, width: W } = p;
  const segs: [[number, number], [number, number]][] = [
    [[0, 0], [L, 0]],
    [[0, W], [L, W]],
    [[0, 0], [0, W]],
    [[L, 0], [L, W]],
    [[L / 2, 0], [L / 2, W]],
  ];
  if (!boxes) return segs;
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
