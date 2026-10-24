/**
 * One animated diagram per starter drill, keyed by the drill's slug. Each follows the drill's
 * written steps (drills.ts). Coordinates in metres from the top-left of the area.
 */
import type { Diagram, Item, Pt } from "./diagram";

const cone = (x: number, y: number): Item => ({ kind: "cone", at: [x, y] });
const gate = (x1: number, y1: number, x2: number, y2: number): Item => ({ kind: "gate", a: [x1, y1], b: [x2, y2] });
const goal = (x: number, y: number, facing: "left" | "right", width = 3): Item => ({ kind: "goal", at: [x, y], facing, width });
const line = (x1: number, y1: number, x2: number, y2: number): Item => ({ kind: "line", a: [x1, y1], b: [x2, y2] });
const p = (x: number, y: number, label?: string) => ({ team: "p" as const, at: [x, y] as Pt, label });
const o = (x: number, y: number, label?: string) => ({ team: "o" as const, at: [x, y] as Pt, label });
const n = (x: number, y: number, label?: string) => ({ team: "n" as const, at: [x, y] as Pt, label });

export const DIAGRAMS: Record<string, Diagram> = {
  // ------------------------------------------------------------------ physical
  "repeated-sprints": {
    w: 40,
    h: 12,
    items: [cone(5, 3), cone(5, 9), cone(35, 3), cone(35, 9), { kind: "zone", at: [5, 3], w: 30, h: 6, label: "30 m" }],
    actors: { a: p(5, 6) },
    frames: [
      { caption: "Sprint flat out to the finish line, 30 m away.", seconds: 1.8, moves: [{ who: "a", to: [35, 6], style: "sprint" }] },
      { caption: "Walk back to the start. The next sprint goes after 25 seconds.", seconds: 3, moves: [{ who: "a", to: [5, 6], via: [[37, 7.5], [20, 8]], style: "walk" }] },
      { caption: "Six sprints, rest 4 minutes, then a second set if you still feel sharp.", seconds: 1.8, moves: [{ who: "a", to: [35, 6], style: "sprint" }] },
    ],
  },
  "acceleration-starts": {
    w: 22,
    h: 12,
    items: [cone(5, 6), cone(15, 6), { kind: "zone", at: [5, 3.5], w: 10, h: 5, label: "10 m" }],
    actors: { a: p(1, 6) },
    frames: [
      { caption: "Jog towards the first cone.", seconds: 1.4, moves: [{ who: "a", to: [5, 6], style: "jog" }] },
      { caption: "Explode for 10 m to the second cone: lean forward, push the ground away.", seconds: 1.1, moves: [{ who: "a", to: [15, 6], style: "sprint" }] },
      { caption: "Walk back past the first cone.", seconds: 2.4, moves: [{ who: "a", to: [8, 6], via: [[16, 8.5], [9, 8.5]], style: "walk" }] },
      { caption: "Next rep: backpedal to the cone, turn the hips…", seconds: 1.2, moves: [{ who: "a", to: [5, 6], style: "jog" }] },
      { caption: "…and explode again. Mix jogging, backpedalling, side-on and facing-backwards starts.", seconds: 1.1, moves: [{ who: "a", to: [15, 6], style: "sprint" }] },
    ],
  },
  "flying-sprints": {
    w: 60,
    h: 12,
    items: [cone(5, 4), cone(25, 4), cone(45, 4), cone(5, 8), cone(25, 8), cone(45, 8), { kind: "zone", at: [25, 4], w: 20, h: 4, label: "flat out" }],
    actors: { a: p(5, 6) },
    frames: [
      { caption: "Build up speed over the first 20 m.", seconds: 2.4, moves: [{ who: "a", to: [25, 6], style: "run" }] },
      { caption: "Flat out from 20 m to 40 m: tall posture, relaxed shoulders.", seconds: 1.2, moves: [{ who: "a", to: [45, 6], style: "sprint" }] },
      { caption: "Slow down gradually, then walk back: a full 3 minutes between reps.", seconds: 3.2, moves: [{ who: "a", to: [5, 6], via: [[56, 6], [56, 10], [8, 10]], style: "walk" }] },
    ],
  },
  "box-to-box": {
    w: 105,
    h: 68,
    items: [{ kind: "pitch" }],
    actors: { a: p(16.5, 34) },
    frames: [
      { caption: "Run from the edge of one penalty box to the other in about 15 seconds.", seconds: 2.6, moves: [{ who: "a", to: [88.5, 34], style: "sprint" }] },
      { caption: "Walk back in about 45 seconds.", seconds: 3.6, moves: [{ who: "a", to: [16.5, 34], via: [[88.5, 40], [16.5, 40]], style: "walk" }] },
      { caption: "Repeat 8 to 12 times at an even pace: the last run as fast as the first.", seconds: 2.6, moves: [{ who: "a", to: [88.5, 34], style: "sprint" }] },
    ],
  },
  "tempo-runs": {
    w: 105,
    h: 68,
    items: [{ kind: "pitch" }],
    actors: { a: p(2, 66) },
    frames: [
      { caption: "Run a touchline at about 70% of your top speed.", seconds: 3, moves: [{ who: "a", to: [103, 66], style: "run" }] },
      { caption: "Walk the goal line.", seconds: 2.4, moves: [{ who: "a", to: [103, 2], style: "walk" }] },
      { caption: "Run the other touchline at the same pace.", seconds: 3, moves: [{ who: "a", to: [2, 2], style: "run" }] },
      { caption: "Walk the other goal line. Keep going for 10 to 16 runs.", seconds: 2.4, moves: [{ who: "a", to: [2, 66], style: "walk" }] },
    ],
  },
  "small-sided-4v4": {
    w: 30,
    h: 20,
    items: [goal(0, 10, "right"), goal(30, 10, "left")],
    actors: { a1: p(6, 10), a2: p(12, 4), a3: p(12, 16), a4: p(18, 10), b1: o(24, 10), b2: o(19, 5), b3: o(19, 15), b4: o(14, 10) },
    ball: [6.7, 10],
    frames: [
      { caption: "4v4 on a small pitch: pass, then move straight away.", seconds: 1.4, moves: [{ ball: [12.5, 4.6] }, { who: "a1", to: [10, 11], style: "jog" }, { who: "a4", to: [20, 7], style: "run" }, { who: "b4", to: [13, 7], style: "run" }] },
      { caption: "Look forward: play into the runner.", seconds: 1.2, moves: [{ ball: [19.6, 7.4] }, { who: "b2", to: [19, 9], style: "run" }, { who: "a2", to: [16, 4], style: "run" }] },
      { caption: "Ball lost: the nearest players press at once.", seconds: 1.5, moves: [{ ball: [19.2, 9.3] }, { who: "a4", to: [18.6, 8.2], style: "sprint" }, { who: "a2", to: [18, 6.6], style: "sprint" }, { who: "a3", to: [17, 13], style: "run" }] },
      { caption: "Win it back and finish. Four rounds of 4 minutes, 2 minutes' rest.", seconds: 1.4, moves: [{ ball: [29.6, 10.5], kick: "shot" }, { who: "a4", to: [21, 9], style: "run" }, { who: "b1", to: [27, 11], style: "jog" }] },
    ],
  },
  "fartlek-match": {
    w: 60,
    h: 40,
    items: [cone(5, 35), cone(55, 35), cone(55, 12), cone(45, 5), cone(5, 5)],
    actors: { a: p(5, 35) },
    frames: [
      { caption: "Jog for 60 seconds.", seconds: 3, moves: [{ who: "a", to: [55, 35], style: "jog" }] },
      { caption: "Stride for 20 seconds: fast but relaxed.", seconds: 1.6, moves: [{ who: "a", to: [55, 12], style: "run" }] },
      { caption: "Sprint for 5 seconds.", seconds: 0.8, moves: [{ who: "a", to: [45, 5], style: "sprint" }] },
      { caption: "Walk for 35 seconds. Repeat the two-minute block 10 times.", seconds: 2.6, moves: [{ who: "a", to: [5, 5], style: "walk" }] },
    ],
  },
  // ------------------------------------------------------------------ technical
  "wall-passing": {
    w: 10,
    h: 8,
    items: [{ kind: "wall", a: [9.5, 0.5], b: [9.5, 7.5] }, cone(4, 2), cone(4, 6)],
    actors: { a: p(4, 4) },
    ball: [4.5, 4.2],
    frames: [
      { caption: "From 5 m, pass against the wall with the inside of your foot.", seconds: 0.8, moves: [{ ball: [9.2, 4.6] }] },
      { caption: "Control the rebound into space for the next pass, not under your feet.", seconds: 1, moves: [{ ball: [4.7, 5.1] }, { who: "a", to: [4.1, 4.7], style: "walk" }] },
      { caption: "Pass again: 2 minutes with the right foot, 2 with the left.", seconds: 0.8, moves: [{ ball: [9.2, 4.2] }] },
      { caption: "Then one touch, moving 2 m left and right between passes.", seconds: 1, moves: [{ ball: [4.6, 2.9] }, { who: "a", to: [4, 2.6], style: "jog" }] },
    ],
  },
  "half-turn": {
    w: 20,
    h: 15,
    items: [gate(18, 2.5, 18, 5.5), gate(18, 9.5, 18, 12.5)],
    actors: { n: n(3, 7.5, "P"), a: p(11, 7.5) },
    ball: [3.7, 7.5],
    frames: [
      { caption: "Before the pass, check over your shoulder.", seconds: 1.1, moves: [{ look: "a", at: [17, 11] }] },
      { caption: "Partner passes. Open your body side-on as it travels.", seconds: 1, moves: [{ ball: [10.4, 7.6] }, { who: "a", to: [11, 7.7], style: "walk" }] },
      { caption: "Receive with your back foot: the first touch goes forward.", seconds: 1, moves: [{ ball: [13.6, 9.6] }, { who: "a", to: [13, 9], style: "jog" }] },
      { caption: "Take it through the gate your partner points to.", seconds: 1.2, moves: [{ who: "a", to: [19, 11], style: "run" }, { carry: "a" }] },
    ],
  },
  "cone-slalom": {
    w: 12,
    h: 6,
    items: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5].map((x) => cone(x, 3)),
    actors: { a: p(0.3, 3) },
    ball: [0.74, 3],
    frames: [
      {
        caption: "Weave through with the inside and outside of one foot.",
        seconds: 3,
        moves: [{ who: "a", to: [10.4, 3], via: [[1, 2.2], [2, 3.8], [3, 2.2], [4, 3.8], [5, 2.2], [6, 3.8], [7, 2.2], [8, 3.8], [9, 2.2]], style: "jog" }, { carry: "a" }],
      },
      {
        caption: "Back the other way with the other foot. Glance up between cones.",
        seconds: 3,
        moves: [{ who: "a", to: [0.3, 3], via: [[9, 3.8], [8, 2.2], [7, 3.8], [6, 2.2], [5, 3.8], [4, 2.2], [3, 3.8], [2, 2.2], [1, 3.8]], style: "jog" }, { carry: "a" }],
      },
      { caption: "Then sole only. Time three runs and keep your best.", seconds: 2.4, moves: [{ who: "a", to: [10.4, 3], via: [[2, 2.3], [4, 3.7], [6, 2.3], [8, 3.7]], style: "walk" }, { carry: "a" }] },
    ],
  },
  "one-v-one-gates": {
    w: 15,
    h: 12,
    items: [gate(15, 1.5, 15, 4.5), gate(15, 7.5, 15, 10.5), line(0, 0.2, 0, 11.8)],
    actors: { a: p(1.5, 6, "A"), d: o(12, 6, "D") },
    ball: [11.3, 6],
    frames: [
      { caption: "The defender passes to the attacker and closes them down.", seconds: 1.3, moves: [{ ball: [2.2, 6] }, { who: "d", to: [8, 6], style: "sprint" }] },
      { caption: "Attacker: run at the defender, change pace and direction.", seconds: 1.4, moves: [{ who: "a", to: [6, 7.5], via: [[4, 5.5]], style: "run" }, { carry: "a" }, { who: "d", to: [8.5, 7], style: "jog" }] },
      { caption: "Beat them and dribble through either gate on the far line.", seconds: 1.4, moves: [{ who: "a", to: [15.4, 3], via: [[9, 3.5]], style: "sprint" }, { carry: "a" }, { who: "d", to: [11.5, 5], style: "run" }] },
      { caption: "Defender scores by winning it and passing through the near line. Swap every rep.", seconds: 1.4, moves: [{ who: "a", to: [1.5, 6], via: [[13, 1]], style: "walk" }, { who: "d", to: [12, 6], style: "walk" }, { ball: [11.3, 6] }] },
    ],
  },
  "finishing-first-touch": {
    w: 22,
    h: 30,
    items: [line(4, 0, 4, 30), line(16.5, 5.8, 22, 5.8), line(16.5, 24.2, 22, 24.2), line(16.5, 5.8, 16.5, 24.2), goal(22, 15, "left", 7.3)],
    actors: { n: n(2, 15, "P"), a: p(10, 18.5) },
    ball: [2.8, 15],
    frames: [
      { caption: "A partner passes from the edge of the box.", seconds: 1, moves: [{ ball: [9.4, 18.2] }] },
      { caption: "One touch out of your feet, to the side.", seconds: 0.9, moves: [{ ball: [12, 20.4] }, { who: "a", to: [11.3, 19.8], style: "jog" }] },
      { caption: "Shoot low across the keeper, into the far corner.", seconds: 0.8, moves: [{ ball: [22, 12], kick: "shot" }] },
      { caption: "Alternate sides: 10 shots with each foot.", seconds: 1.4, moves: [{ who: "a", to: [10, 11.5], style: "jog" }, { ball: [2.8, 15] }] },
    ],
  },
  "crossing-zones": {
    w: 40,
    h: 50,
    items: [
      line(23.5, 4.8, 40, 4.8),
      line(23.5, 45.2, 40, 45.2),
      line(23.5, 4.8, 23.5, 45.2),
      goal(40, 25, "left", 7.3),
      { kind: "zone", at: [34, 16], w: 4.5, h: 5, label: "near" },
      { kind: "zone", at: [27, 22.5], w: 5, h: 5, label: "spot" },
      { kind: "zone", at: [34, 29], w: 4.5, h: 5, label: "far" },
    ],
    actors: { a: p(6, 47) },
    ball: [7.4, 47],
    frames: [
      { caption: "Dribble down the wide channel.", seconds: 1.8, moves: [{ who: "a", to: [30, 47], style: "run" }, { carry: "a" }] },
      { caption: "Look up before the cross.", seconds: 0.8, moves: [{ look: "a", at: [36, 31] }, { carry: "a" }] },
      { caption: "Cross into the zone you choose or your partner calls: here the far post.", seconds: 1.2, moves: [{ ball: [36, 31.5], via: [[37, 40]], kick: "cross" }] },
      { caption: "Next one to the near post. 10 crosses from each side.", seconds: 2.4, moves: [{ who: "a", to: [30, 47], via: [[6, 48], [12, 47]], style: "run" }, { carry: "a" }] },
    ],
  },
  "juggling-ladder": {
    w: 6,
    h: 6,
    items: [],
    actors: { a: p(3, 3.4) },
    ball: [3, 2.6],
    frames: [
      { caption: "Juggle with your stronger foot; note your best run (top-down view).", seconds: 1.6, moves: [{ ball: [3, 2.6], via: [[3, 1.4], [3, 2.6], [3, 1.4]], kick: "touch" }] },
      { caption: "Then alternate feet.", seconds: 1.6, moves: [{ ball: [3.4, 2.7], via: [[2.6, 2.7], [3, 1.4], [3.4, 2.7], [3, 1.4]], kick: "touch" }] },
      { caption: "Then thigh, foot, thigh, foot.", seconds: 1.6, moves: [{ ball: [2.8, 2.9], via: [[2.8, 1.8], [3.3, 2.7], [3, 1.6]], kick: "touch" }] },
      { caption: "Finish with 2 minutes of sole rolls and toe taps.", seconds: 1.6, moves: [{ ball: [3.8, 2.7], via: [[2.2, 2.7], [3.8, 2.7], [2.2, 2.7]], kick: "touch" }] },
    ],
  },
  // ------------------------------------------------------------------ tactical
  "scan-cue": {
    w: 15,
    h: 15,
    items: [{ kind: "zone", at: [11.5, 10], w: 3, h: 3, label: "cue" }],
    actors: { pa: n(2, 7.5, "A"), a: p(8, 7.5), pb: n(13, 7.5, "B") },
    ball: [2.7, 7.5],
    frames: [
      { caption: "B stands behind you and holds up a colour or a number of fingers.", seconds: 1, moves: [{ who: "pb", to: [13, 11.5], style: "walk" }] },
      { caption: "Check over your shoulder and call out the cue before the ball arrives.", seconds: 1.2, moves: [{ look: "a", at: [13, 11.5] }] },
      { caption: "A passes. Receive and play to the side B points to.", seconds: 1.2, moves: [{ ball: [7.4, 7.6] }] },
      { caption: "20 receptions, then swap roles.", seconds: 1.2, moves: [{ ball: [12, 12.5] }] },
    ],
  },
  "rondo-5v2": {
    w: 12,
    h: 12,
    items: [cone(0, 0), cone(12, 0), cone(0, 12), cone(12, 12)],
    actors: { a1: p(0.8, 4), a2: p(4, 11.2), a3: p(9.5, 11.2), a4: p(11.2, 4.5), a5: p(6, 0.8), d1: o(5, 6), d2: o(7, 6.8) },
    ball: [1.4, 4.2],
    frames: [
      { caption: "Keep the ball against the two in the middle: 10 passes is a point.", seconds: 1, moves: [{ ball: [4.2, 10.5] }, { who: "d1", to: [4.6, 8.2], style: "run" }, { who: "d2", to: [6.4, 8], style: "jog" }] },
      { caption: "Play the split pass between the defenders when it's on.", seconds: 1, moves: [{ ball: [10.6, 4.7] }, { who: "a3", to: [10.2, 10.6], style: "jog" }, { who: "a5", to: [7.5, 0.8], style: "jog" }] },
      { caption: "Outside players move to give an angle; defenders press together.", seconds: 1.1, moves: [{ ball: [7.6, 1.4] }, { who: "d1", to: [8.2, 4.2], style: "run" }, { who: "d2", to: [9.6, 5.4], style: "run" }] },
      { caption: "Lose the ball and swap into the middle with the defender who won it.", seconds: 1.3, moves: [{ ball: [8.4, 3.6] }, { who: "d1", to: [7.8, 2.6], style: "sprint" }] },
    ],
  },
  "shadow-shape": {
    w: 60,
    h: 68,
    items: [line(0, 0, 0, 68), line(0, 13.8, 16.5, 13.8), line(0, 54.2, 16.5, 54.2), line(16.5, 13.8, 16.5, 54.2), line(60, 0, 60, 68)],
    actors: {
      d1: p(14, 12), d2: p(13, 27), d3: p(13, 41), d4: p(14, 56),
      m1: p(28, 15), m2: p(26, 29), m3: p(26, 39), m4: p(28, 53),
      c: n(45, 34, "C"),
    },
    ball: [46.9, 34],
    frames: [
      { caption: "The team sets up in its shape. The coach has the ball.", seconds: 1.2, moves: [{ carry: "c" }] },
      {
        caption: "Coach moves the ball wide: the whole unit shifts across together.",
        seconds: 2,
        moves: [
          { who: "c", to: [42, 58], style: "walk" }, { carry: "c" },
          { who: "d1", to: [15, 24] }, { who: "d2", to: [14, 36] }, { who: "d3", to: [14, 47] }, { who: "d4", to: [17, 60] },
          { who: "m1", to: [28, 28] }, { who: "m2", to: [27, 40] }, { who: "m3", to: [28, 50] }, { who: "m4", to: [33, 59] },
        ],
      },
      {
        caption: "Ball to the other side: shift again and keep the distances between the lines.",
        seconds: 2.4,
        moves: [
          { who: "c", to: [42, 10], style: "walk" }, { carry: "c" },
          { who: "d1", to: [17, 8] }, { who: "d2", to: [14, 20] }, { who: "d3", to: [14, 32] }, { who: "d4", to: [15, 44] },
          { who: "m1", to: [33, 9] }, { who: "m2", to: [28, 19] }, { who: "m3", to: [27, 29] }, { who: "m4", to: [28, 41] },
        ],
      },
      {
        caption: "Coach freezes play and checks: can everyone say where they should be?",
        seconds: 2,
        moves: [
          { who: "c", to: [45, 34], style: "walk" }, { carry: "c" },
          { who: "d1", to: [14, 22] }, { who: "d2", to: [13, 30] }, { who: "d3", to: [13, 38] }, { who: "d4", to: [14, 46] },
          { who: "m1", to: [29, 22] }, { who: "m2", to: [28, 30] }, { who: "m3", to: [28, 38] }, { who: "m4", to: [29, 46] },
        ],
      },
    ],
  },
  "third-man-runs": {
    w: 30,
    h: 20,
    items: [cone(5, 10), cone(14, 14), cone(10, 5)],
    actors: { a: p(5, 10, "A"), b: p(14, 14, "B"), c: p(10, 5, "C") },
    ball: [5.7, 10.3],
    frames: [
      { caption: "A passes to B.", seconds: 1, moves: [{ ball: [13.4, 13.6] }] },
      { caption: "B sets the ball back to C; as B receives, A runs beyond.", seconds: 1.3, moves: [{ ball: [10.5, 5.6] }, { who: "a", to: [16, 8], via: [[9, 9.5]], style: "run" }] },
      { caption: "C plays A in behind, timed for the run.", seconds: 1.2, moves: [{ ball: [24.4, 7.2] }, { who: "a", to: [24, 7], style: "sprint" }] },
      { caption: "Rotate positions; then add a passive defender.", seconds: 1.6, moves: [{ who: "a", to: [14, 14], style: "walk" }, { who: "b", to: [10, 5], style: "walk" }, { who: "c", to: [5, 10], style: "walk" }, { ball: [5.7, 10.3] }] },
    ],
  },
  "pressing-triggers": {
    w: 40,
    h: 30,
    items: [line(0, 0, 0, 30), line(40, 0, 40, 30)],
    actors: {
      a1: o(5, 15), a2: o(12, 5), a3: o(12, 25), a4: o(22, 7), a5: o(22, 23), a6: o(30, 15),
      d1: p(16, 11), d2: p(16, 19), d3: p(25, 12), d4: p(25, 18),
    },
    ball: [12.6, 5.4],
    frames: [
      { caption: "Six attackers pass it around; the four defenders hold their shape.", seconds: 1.2, moves: [{ ball: [21.4, 7.3] }, { who: "d1", to: [17, 10] }, { who: "d3", to: [24, 10] }] },
      { caption: "Trigger: a back pass.", seconds: 1.3, moves: [{ ball: [5.7, 14.7] }] },
      {
        caption: "Press together: the nearest player goes, curving the run to cut the easy pass; others shift and cover.",
        seconds: 1.4,
        moves: [{ who: "d1", to: [7, 13], via: [[11, 9]], style: "sprint" }, { who: "d2", to: [11, 19], style: "run" }, { who: "d3", to: [17, 8], style: "run" }, { who: "d4", to: [19, 16], style: "run" }],
      },
      { caption: "Win the ball and dribble over the attackers' line.", seconds: 1.3, moves: [{ ball: [6.2, 13.7] }, { who: "a1", to: [4, 17], style: "jog" }] },
      { caption: "Rounds of 3 minutes.", seconds: 1.2, moves: [{ who: "d1", to: [0.6, 12], style: "run" }, { carry: "d1" }] },
    ],
  },
  "five-second-transition": {
    w: 40,
    h: 30,
    items: [goal(0, 15, "right"), goal(40, 15, "left")],
    actors: { a1: p(10, 15), a2: p(17, 7), a3: p(17, 23), a4: p(25, 14), b1: o(30, 15), b2: o(23, 8), b3: o(22, 21), b4: o(14, 15) },
    ball: [17.6, 7.4],
    frames: [
      { caption: "Normal small-sided game.", seconds: 1, moves: [{ ball: [24.4, 13.7] }, { who: "a2", to: [21, 6], style: "jog" }] },
      { caption: "Ball lost: the clock starts.", seconds: 1, moves: [{ ball: [22.6, 9.4] }, { who: "b2", to: [22.5, 9], style: "jog" }] },
      { caption: "Win it back within 5 seconds: the player who lost it presses first.", seconds: 1.3, moves: [{ who: "a4", to: [23.4, 10.2], style: "sprint" }, { who: "a2", to: [21.6, 8.3], style: "sprint" }, { who: "a3", to: [20, 17], style: "run" }] },
      { caption: "Then shoot within 5 seconds of winning it: a bonus point each time.", seconds: 1.2, moves: [{ ball: [23.6, 10.8] }, { who: "b1", to: [34, 14], style: "jog" }] },
      { caption: "Rounds of 5 minutes.", seconds: 0.9, moves: [{ ball: [39.6, 15.6], kick: "shot" }] },
    ],
  },
  // ------------------------------------------------------------------ defensive
  jockeying: {
    w: 20,
    h: 10,
    items: [line(0, 0.2, 20, 0.2), line(0, 9.8, 20, 9.8), cone(0, 0.2), cone(20, 0.2), cone(0, 9.8), cone(20, 9.8)],
    actors: { att: o(2, 5, "A"), def: p(17, 5) },
    frames: [
      { caption: "The attacker dribbles down the channel; the defender closes down quickly.", seconds: 1.3, moves: [{ who: "att", to: [6, 5], style: "jog" }, { carry: "att" }, { who: "def", to: [10.5, 5], style: "sprint" }] },
      { caption: "Then slow down: side-on, knees bent, arm's length away.", seconds: 1.6, moves: [{ who: "att", to: [9, 6.5], style: "walk" }, { carry: "att" }, { who: "def", to: [11.2, 5.6], style: "walk" }] },
      { caption: "Show the attacker towards the touchline, away from goal.", seconds: 1.6, moves: [{ who: "att", to: [13, 8.4], style: "jog" }, { carry: "att" }, { who: "def", to: [14.4, 6.8], style: "jog" }] },
      { caption: "Tackle only when the touch goes too far from their foot.", seconds: 1.1, moves: [{ who: "att", to: [14.6, 8.9], style: "jog" }, { ball: [16.6, 8.6] }, { who: "def", to: [16.4, 7.8], style: "run" }] },
    ],
    ball: [2.6, 5],
  },
  "cover-balance": {
    w: 25,
    h: 20,
    items: [goal(0, 10, "right"), goal(25, 10, "left")],
    actors: { a1: o(19, 6), a2: o(19, 14), d1: p(10, 7), d2: p(10, 13) },
    ball: [18.4, 6.3],
    frames: [
      { caption: "The defender nearest the ball presses.", seconds: 1.3, moves: [{ who: "d1", to: [16.2, 6.6], style: "sprint" }] },
      { caption: "The second covers at an angle behind: close enough to help, not beaten by one pass.", seconds: 1.3, moves: [{ who: "d2", to: [12.6, 9.6], style: "run" }] },
      { caption: "Ball switched: roles swap. The new nearest defender presses…", seconds: 1.3, moves: [{ ball: [18.4, 13.7] }, { who: "d2", to: [16.2, 13.2], style: "sprint" }] },
      { caption: "…and the other drops in to cover. Talk: “I've got the ball”, “covering”.", seconds: 1.3, moves: [{ who: "d1", to: [12.6, 10.4], style: "run" }] },
    ],
  },
  "recovery-race": {
    w: 40,
    h: 20,
    items: [goal(0, 10, "right", 5), line(16.5, 2, 16.5, 18)],
    actors: { def: p(22, 9), att: o(25, 12, "A"), c: n(37, 10, "C") },
    ball: [36.3, 10],
    frames: [
      { caption: "The defender starts 2 m ahead of the attacker, facing the wrong way.", seconds: 1, moves: [{ look: "def", at: [36, 10] }] },
      { caption: "Coach passes to the attacker: the defender turns and sprints back.", seconds: 1.2, moves: [{ ball: [25.6, 12.2] }, { who: "def", to: [17, 9.5], via: [[21, 8]], style: "sprint" }] },
      { caption: "Run straight towards your own goal first, to get goal-side.", seconds: 1.3, moves: [{ who: "att", to: [17, 12], style: "sprint" }, { carry: "att" }, { who: "def", to: [10, 10.6], style: "sprint" }] },
      { caption: "Then turn towards the ball and block or tackle before the box.", seconds: 1.1, moves: [{ who: "att", to: [13, 12], style: "run" }, { ball: [11.6, 11.9] }, { who: "def", to: [11.2, 11.4], style: "run" }] },
    ],
  },
};

export function diagramFor(drillKey: string): Diagram | null {
  return drillKey.startsWith("starter:") ? (DIAGRAMS[drillKey.slice("starter:".length)] ?? null) : null;
}
