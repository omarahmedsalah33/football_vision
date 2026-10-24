/**
 * The performance framework: every dimension we talk about, what it means, where its evidence comes
 * from and what it can't tell you.
 *
 * Two kinds of evidence, never mixed:
 * - "measured": computed from tracked movement in analysed video (estimated, relative to the
 *   players in the same match);
 * - "observed": rated 1–5 by a coach or by the player. The video can't judge these yet (no ball
 *   or event detection), so we don't pretend it can.
 */

export type Category = "physical" | "technical" | "tactical" | "defensive";

/** Per-match values a measured dimension is tracked with; computed from MatchPerformance. */
export type MetricKey = "metresPerMinute" | "hiMetresPerMinute" | "topSpeedKmh" | "sprintsPerHour" | "staminaPercent";

export type Dimension = {
  key: string;
  category: Category;
  label: string;
  /** What it means, in one sentence. */
  meaning: string;
  source: "measured" | "observed";
  /** How it is evaluated. */
  method: string;
  limitations: string;
  /** Measured only: the profile score component it feeds and the metric goals use. */
  component?: "workRate" | "intensity" | "speed" | "sprints" | "stamina";
  metric?: MetricKey;
};

export const METRICS: Record<MetricKey, { label: string; unit: string; digits: number; higherIsBetter: true }> = {
  metresPerMinute: { label: "Distance per minute", unit: "m/min", digits: 0, higherIsBetter: true },
  hiMetresPerMinute: { label: "High-intensity running", unit: "m/min", digits: 1, higherIsBetter: true },
  topSpeedKmh: { label: "Top speed", unit: "km/h", digits: 1, higherIsBetter: true },
  sprintsPerHour: { label: "Sprints per hour on camera", unit: "per hour", digits: 1, higherIsBetter: true },
  staminaPercent: { label: "Late-game work rate", unit: "% of early pace", digits: 0, higherIsBetter: true },
};

const OBSERVED_LIMIT = "Not measured from video yet: it needs ball and event detection. Rated by a coach or by the player, so it is an opinion, not a measurement.";
const MEASURED_LIMIT =
  "Estimated from tracked foot positions. Depends on calibration accuracy and how long the player is visible; compared with the other players in the same match, so the level of the match matters.";

export const DIMENSIONS: Dimension[] = [
  // Physical: measured
  {
    key: "workRate",
    category: "physical",
    label: "Work rate",
    meaning: "How much ground the player covers for the time they are on camera.",
    source: "measured",
    method: "Distance covered per minute tracked, ranked against comparable outfield players in the match.",
    limitations: MEASURED_LIMIT,
    component: "workRate",
    metric: "metresPerMinute",
  },
  {
    key: "intensity",
    category: "physical",
    label: "High-intensity running",
    meaning: "How much of the running is done fast (above about 20 km/h).",
    source: "measured",
    method: "Metres per minute above 5.5 m/s, ranked against comparable players in the match.",
    limitations: MEASURED_LIMIT,
    component: "intensity",
    metric: "hiMetresPerMinute",
  },
  {
    key: "speed",
    category: "physical",
    label: "Top speed",
    meaning: "The fastest the player ran, averaged over a full second so one noisy step can't set it.",
    source: "measured",
    method: "Best one-second average speed in the match.",
    limitations: `${MEASURED_LIMIT} A player who never needs to sprint flat out in a match won't show their real top speed.`,
    component: "speed",
    metric: "topSpeedKmh",
  },
  {
    key: "sprints",
    category: "physical",
    label: "Sprinting",
    meaning: "How often the player sprints (above about 25 km/h for at least a second).",
    source: "measured",
    method: "Sprints per hour on camera, ranked against comparable players in the match.",
    limitations: MEASURED_LIMIT,
    component: "sprints",
    metric: "sprintsPerHour",
  },
  {
    key: "stamina",
    category: "physical",
    label: "Stamina",
    meaning: "Whether the work rate holds up late on.",
    source: "measured",
    method: "Work rate in the last third of the time tracked as a share of the first third. Needs at least six minutes tracked.",
    limitations: `${MEASURED_LIMIT} Game state (a team sitting on a lead) also changes how much players run late on.`,
    component: "stamina",
    metric: "staminaPercent",
  },
  // Technical: observed
  { key: "firstTouch", category: "technical", label: "First touch", meaning: "Controlling the ball into space with the first touch, with either foot.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "passing", category: "technical", label: "Passing and receiving", meaning: "Accurate, well-weighted passes and clean receiving.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "ballControl", category: "technical", label: "Ball control", meaning: "Keeping the ball close and protected in tight spaces.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "dribbling", category: "technical", label: "Dribbling", meaning: "Beating an opponent or carrying the ball forward at speed.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "finishing", category: "technical", label: "Shooting and finishing", meaning: "Hitting the target and scoring from the chances the player gets.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "crossing", category: "technical", label: "Crossing", meaning: "Delivering the ball into the box to the right area.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "underPressure", category: "technical", label: "Decisions under pressure", meaning: "Choosing and executing the right action when an opponent is close.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  // Tactical: observed
  { key: "scanning", category: "tactical", label: "Scanning and awareness", meaning: "Checking around before receiving so the next action is already planned.", source: "observed", method: "Coach or self rating, 1–5. Head movement can't yet be measured from wide match footage.", limitations: OBSERVED_LIMIT },
  { key: "positioning", category: "tactical", label: "Positional discipline", meaning: "Holding the position the team's shape needs.", source: "observed", method: "Coach or self rating, 1–5. The heatmap on the profile is supporting context, not a verdict.", limitations: OBSERVED_LIMIT },
  { key: "movementOffBall", category: "tactical", label: "Movement off the ball", meaning: "Runs and movements that create space or a passing option.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "supportPlay", category: "tactical", label: "Support positioning", meaning: "Being at the right angle and distance to help the player on the ball.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "pressing", category: "tactical", label: "Pressing decisions", meaning: "Knowing when to press, how to angle it and when to hold.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "transitions", category: "tactical", label: "Transitions", meaning: "Reacting quickly when the ball is won or lost.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  // Defensive: observed
  { key: "defensivePositioning", category: "defensive", label: "Defensive positioning", meaning: "Body shape and position between the ball, the opponent and the goal.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "marking", category: "defensive", label: "Marking", meaning: "Staying tight to an opponent and denying them the ball.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "oneVOneDefending", category: "defensive", label: "1v1 defending and tackling", meaning: "Delaying, jockeying and winning the ball cleanly.", source: "observed", method: "Coach or self rating, 1–5.", limitations: OBSERVED_LIMIT },
  { key: "recoveryRuns", category: "defensive", label: "Recovery runs", meaning: "Getting back goal-side quickly after the ball is lost.", source: "observed", method: "Coach or self rating, 1–5. Sprint counts on the profile are supporting context.", limitations: OBSERVED_LIMIT },
];

export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key) as [string, ...string[]];
export const dimensionByKey = new Map(DIMENSIONS.map((d) => [d.key, d]));

export const CATEGORY_LABEL: Record<Category, string> = { physical: "Physical", technical: "Technical", tactical: "Tactical", defensive: "Defensive" };

/** Anchors for 1–5 ratings, so different coaches mean the same thing. */
export const RATING_LABEL: Record<number, string> = {
  1: "A clear weakness",
  2: "Below what the role needs",
  3: "Solid",
  4: "A strength",
  5: "Outstanding for their level",
};

/**
 * Possible reasons a dimension is low: hypotheses for the coach and player to check, never stated
 * as fact. The measurement-related ones come first, because they are the cheapest to rule out.
 */
export const POSSIBLE_CAUSES: Record<string, string[]> = {
  workRate: ["Few minutes on camera, or a role with less ground to cover (check position before concluding)", "General aerobic fitness", "Positioning: standing still instead of adjusting to the ball"],
  intensity: ["Role or game state that rarely demands fast running", "Limited high-speed running in training", "Tiredness or a minor injury on the day"],
  speed: ["No flat-out sprint needed in these matches (top speed only shows when the game asks for it)", "Little maximum-speed exposure in training", "Running technique (arm action, posture)"],
  sprints: ["Role or tactics that rarely ask for sprints", "Reacting late to triggers such as a loose ball or a run in behind", "Fitness to repeat sprints"],
  stamina: ["Game state late on (a team protecting a lead runs less)", "Aerobic fitness and repeat-effort capacity", "Pacing: going too hard early"],
  firstTouch: ["Body shape when receiving (closed to the field)", "Touch weight and surface choice", "Not knowing the next action before the ball arrives"],
  passing: ["Technique on the weaker foot", "Weight and timing of the pass", "Picking the pass late because of limited scanning"],
  ballControl: ["Touches too far from the body", "Using too few surfaces of the foot", "Head down for too long"],
  dribbling: ["Few changes of pace or direction", "Starting the dribble too close to the defender", "Confidence"],
  finishing: ["Shooting technique and body over the ball", "Shot selection (low-percentage chances)", "Getting into the box at the right moment"],
  crossing: ["Delivery technique", "Looking up before crossing", "Timing with the runners"],
  underPressure: ["Not checking for pressure before receiving", "Body shape that only allows one option", "Technique under time pressure"],
  scanning: ["Habit: looking only at the ball", "Not knowing what to look for (pressure, space, teammates)", "Ball arriving too quickly to check"],
  positioning: ["Unclear role in the team's shape", "Being drawn to the ball", "Fatigue late in the game"],
  movementOffBall: ["Timing of runs", "Standing in the opponent's cover shadow", "Not reading when the passer is ready"],
  supportPlay: ["Distance and angle of support", "Reacting late after passing", "Unclear team structure"],
  pressing: ["Pressing without a trigger", "Curving the run poorly so the pass is easy", "Team not pressing together"],
  transitions: ["Reacting late after the ball changes hands", "Switching off after losing the ball", "Fitness to repeat efforts"],
  defensivePositioning: ["Body shape (square instead of side-on)", "Losing sight of ball and opponent at the same time", "Communication with teammates"],
  marking: ["Distance to the opponent", "Watching the ball and losing the runner", "Concentration late on"],
  oneVOneDefending: ["Diving in instead of delaying", "Footwork and body shape", "Approach speed"],
  recoveryRuns: ["Reaction after losing the ball", "Repeat-sprint fitness", "Running line (not goal-side)"],
};
