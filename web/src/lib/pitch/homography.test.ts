import { describe, expect, it } from "vitest";
import { apply, CalibrationError, fitHomography, invert, leaveOneOutError, rmsError, type Correspondence, type Mat3 } from "./homography";
import { LANDMARKS, STANDARD_PITCH } from "./landmarks";

// A plausible camera: pitch metres → 1920×1080 pixels, with perspective (far side smaller).
const PITCH_TO_IMAGE: Mat3 = [15.2, -6.1, 160, 0.4, 4.2, 210, 0.0004, -0.0061, 1];
const IMAGE_TO_PITCH = invert(PITCH_TO_IMAGE);

function correspondences(ids: string[], noisePx = 0, seed = 1): Correspondence[] {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  return ids.map((id) => {
    const pitch = LANDMARKS.find((l) => l.id === id)!.at(STANDARD_PITCH);
    const [x, y] = apply(PITCH_TO_IMAGE, pitch);
    return { pitch, image: [x + rand() * noisePx, y + rand() * noisePx] };
  });
}

const SIX = ["left_corner_far", "left_corner_near", "halfway_far", "halfway_near", "right_box_far", "centre_spot"];

describe("homography fitting", () => {
  it("recovers the true camera mapping exactly from 4 clean landmarks", () => {
    const H = fitHomography(correspondences(SIX.slice(0, 4)));
    for (const probe of [[300, 400], [1500, 900], [960, 540]] as const) {
      const got = apply(H, [...probe]);
      const want = apply(IMAGE_TO_PITCH, [...probe]);
      expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(1e-6);
    }
  });

  it("stays accurate with realistic click noise (±2 px)", () => {
    const pts = correspondences([...SIX, "left_box_near", "right_corner_near"], 2);
    const H = fitHomography(pts);
    expect(rmsError(H, pts)).toBeLessThan(0.5);
    const loo = leaveOneOutError(pts)!;
    expect(loo).toBeGreaterThan(0);
    expect(loo).toBeLessThan(1);
  });

  it("reports a large error when a landmark is clicked in the wrong place", () => {
    const pts = correspondences(SIX);
    pts[2] = { ...pts[2], image: [pts[2].image[0] + 120, pts[2].image[1] + 40] }; // wrong click
    expect(leaveOneOutError(pts)!).toBeGreaterThan(3);
  });

  it("refuses fewer than 4 points and points along a single line", () => {
    expect(() => fitHomography(correspondences(SIX.slice(0, 3)))).toThrow(CalibrationError);
    const collinear = correspondences(["halfway_far", "circle_far", "centre_spot", "circle_near", "halfway_near"]);
    expect(() => fitHomography(collinear)).toThrow(/one line/);
  });

  it("needs 5 points for a leave-one-out estimate", () => {
    expect(leaveOneOutError(correspondences(SIX.slice(0, 4)))).toBeNull();
  });

  it("every landmark lies on the pitch, and they are unique", () => {
    const ids = new Set<string>();
    for (const l of LANDMARKS) {
      const [x, y] = l.at(STANDARD_PITCH);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(105);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(68);
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
    }
  });
});
