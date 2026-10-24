import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apply, fitHomography, invert, type Mat3 } from "../../src/lib/pitch/homography";
import { LANDMARK_BY_ID, STANDARD_PITCH, type PitchSize } from "../../src/lib/pitch/landmarks";
import type { Actor } from "../../src/server/authz/permissions";
import { calibrationContext, saveCalibration } from "../../src/server/calibration/service";
import { matches, videos } from "../../src/server/db/schema";
import type { ObjectStorage } from "../../src/server/storage/s3";
import { enqueueAnalysis } from "../../src/server/jobs/service";
import { createMatch, getMatch } from "../../src/server/matches/service";
import { eq } from "drizzle-orm";
import { makeActor, testDb } from "../helpers";

const db = testDb();
// A raised camera on the halfway line: the far touchline looks shorter than the near one.
const PITCH_TO_IMAGE: Mat3 = fitHomography([
  { image: [0, 0], pitch: [400, 150] },
  { image: [105, 0], pitch: [1520, 150] },
  { image: [105, 68], pitch: [1880, 1000] },
  { image: [0, 68], pitch: [40, 1000] },
]);

async function validatedMatch(actor: Actor) {
  const match = await createMatch(db, actor, { title: "Calibration" });
  await db.insert(videos).values({
    orgId: actor.orgId,
    matchId: match.id,
    storageKey: `t/${randomUUID()}`,
    declaredSizeBytes: 10,
    sizeBytes: 10,
    partSizeBytes: 10,
    partCount: 1,
    status: "validated",
    width: 1920,
    height: 1080,
  });
  return match;
}

function click(id: string, nudge: [number, number] = [0, 0], size: PitchSize = STANDARD_PITCH) {
  // The test camera sees a 105 × 68 pitch; smaller pitches are drawn into the same image area.
  const [px, py] = LANDMARK_BY_ID.get(id)!.at(size);
  const [x, y] = apply(PITCH_TO_IMAGE, [(px / size.length) * 105, (py / size.width) * 68]);
  return { landmark: id, x: x + nudge[0], y: y + nudge[1] };
}

const storage = { presignGet: async (key: string) => `https://storage.test/${key}` } as unknown as ObjectStorage;
const GOOD = ["left_corner_far", "left_corner_near", "halfway_far", "halfway_near", "left_box_near", "centre_spot"];

describe("pitch calibration", () => {
  it("analysis can't start until the pitch is calibrated; after calibrating it can", async () => {
    const actor = await makeActor(db, "owner");
    const match = await validatedMatch(actor);
    await expect(enqueueAnalysis(db, actor, match.id)).rejects.toMatchObject({ status: 409 });
    expect((await getMatch(db, actor, match.id)).status).toBe("needs_calibration");

    const saved = await saveCalibration(db, actor, match.id, { pitchLength: 105, pitchWidth: 68, points: GOOD.map((id) => click(id)) });
    expect(saved.rmsErrorM).toBeLessThan(0.01);
    expect((await getMatch(db, actor, match.id)).status).toBe("ready");

    const job = await enqueueAnalysis(db, actor, match.id);
    const cfg = job.config as { calibration: { homography: { matrix: Mat3 } } };
    // The worker receives a mapping that puts the centre spot at the centre of the pitch.
    const centre = apply(cfg.calibration.homography.matrix, apply(PITCH_TO_IMAGE, [52.5, 34]));
    expect(centre[0]).toBeCloseTo(52.5, 3);
    expect(centre[1]).toBeCloseTo(34, 3);
    expect(invert(cfg.calibration.homography.matrix)).toBeTruthy();
  });

  it("rejects a misplaced click and names the landmark to check", async () => {
    const actor = await makeActor(db, "owner");
    const match = await validatedMatch(actor);
    const points = GOOD.map((id) => click(id, id === "halfway_far" ? [140, 60] : [0, 0]));
    await expect(saveCalibration(db, actor, match.id, { pitchLength: 105, pitchWidth: 68, points })).rejects.toMatchObject({
      status: 422,
      code: "calibration_inconsistent",
    });
  });

  it("rejects unknown, duplicated and out-of-frame landmarks, and collinear sets", async () => {
    const actor = await makeActor(db, "owner");
    const match = await validatedMatch(actor);
    const base = { pitchLength: 105, pitchWidth: 68 };
    const five = GOOD.slice(0, 5).map((id) => click(id));
    await expect(saveCalibration(db, actor, match.id, { ...base, points: [...five, { landmark: "moon", x: 1, y: 1 }] })).rejects.toMatchObject({ status: 422 });
    await expect(saveCalibration(db, actor, match.id, { ...base, points: [...five, five[0]] })).rejects.toMatchObject({ status: 422 });
    await expect(saveCalibration(db, actor, match.id, { ...base, points: [...five.slice(1), { ...five[0], x: 5000 }] })).rejects.toMatchObject({ status: 422 });
    const line = ["halfway_far", "circle_far", "centre_spot", "circle_near", "halfway_near"].map((id) => click(id));
    await expect(saveCalibration(db, actor, match.id, { ...base, points: line })).rejects.toMatchObject({ status: 422 });
  });

  it("respects permissions and tenancy", async () => {
    const owner = await makeActor(db, "owner");
    const match = await validatedMatch(owner);
    const scout = await makeActor(db, "scout", owner.orgId);
    const other = await makeActor(db, "owner");
    const input = { pitchLength: 105, pitchWidth: 68, points: GOOD.map((id) => click(id)) };
    await expect(saveCalibration(db, scout, match.id, input)).rejects.toMatchObject({ status: 403 });
    await expect(saveCalibration(db, other, match.id, input)).rejects.toMatchObject({ status: 404 });
  });

  it("needs at least 5 points, because 4 always fit exactly and can't reveal a wrong click", async () => {
    const actor = await makeActor(db, "owner");
    const match = await validatedMatch(actor);
    // The same kind of 4-point set that let a wrong click through before.
    const four = ["right_six_near", "halfway_far", "right_six_goalline_near", "right_box_goalline_near"].map((id) => click(id));
    await expect(saveCalibration(db, actor, match.id, { pitchLength: 105, pitchWidth: 68, points: four })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("at least 5"),
    });
  });

  it("rejects mirrored pitches (left and right swapped)", async () => {
    const actor = await makeActor(db, "owner");
    const match = await validatedMatch(actor);
    const swap = (id: string) => (id.startsWith("left_") ? id.replace("left_", "right_") : id.startsWith("right_") ? id.replace("right_", "left_") : id);
    // Click the real spots but label them with left and right swapped.
    const ids = ["left_corner_far", "left_corner_near", "right_corner_far", "right_corner_near", "centre_spot", "left_box_near"];
    const points = ids.map((id) => ({ ...click(id), landmark: swap(id) }));
    await expect(saveCalibration(db, actor, match.id, { pitchLength: 105, pitchWidth: 68, points })).rejects.toMatchObject({ status: 422 });
  });

  it("small-sided pitches: corners and halfway only, and the worker learns the format", async () => {
    const actor = await makeActor(db, "owner");
    const match = await validatedMatch(actor);
    const size = { length: 40, width: 20 };
    const ids = ["left_corner_far", "halfway_far", "right_corner_far", "right_corner_near", "halfway_near", "centre_spot"];
    const base = { pitchLength: 40, pitchWidth: 20, playersPerSide: 5 as const };
    const withBox = [...ids.slice(0, 5).map((id) => click(id, [0, 0], size)), click("left_penalty_spot", [0, 0], size)];
    await expect(saveCalibration(db, actor, match.id, { ...base, points: withBox })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("full-size"),
    });
    // A full-size pitch played as 5-a-side has no 11-a-side boxes either.
    await expect(
      saveCalibration(db, actor, match.id, { pitchLength: 105, pitchWidth: 68, playersPerSide: 5, points: GOOD.map((id) => click(id)) }),
    ).rejects.toMatchObject({ status: 422 });

    const saved = await saveCalibration(db, actor, match.id, { ...base, points: ids.map((id) => click(id, [0, 0], size)) });
    expect(saved.looErrorM).toBeLessThan(0.05);
    const job = await enqueueAnalysis(db, actor, match.id);
    const cfg = job.config as { calibration: { homography: { pitch: { length: number; width: number; playersPerSide: number } } } };
    expect(cfg.calibration.homography.pitch).toEqual({ length: 40, width: 20, playersPerSide: 5 });
  });

  it("offers earlier calibrations of the same workspace and resolution for reuse, never other clubs' or deleted ones", async () => {
    const owner = await makeActor(db, "owner");
    const earlier = await validatedMatch(owner);
    await saveCalibration(db, owner, earlier.id, { pitchLength: 105, pitchWidth: 68, points: GOOD.map((id) => click(id)) });
    const gone = await validatedMatch(owner);
    await saveCalibration(db, owner, gone.id, { pitchLength: 105, pitchWidth: 68, points: GOOD.map((id) => click(id)) });
    await db.update(matches).set({ deletedAt: new Date() }).where(eq(matches.id, gone.id));
    const other = await makeActor(db, "owner");
    const theirs = await validatedMatch(other);
    await saveCalibration(db, other, theirs.id, { pitchLength: 105, pitchWidth: 68, points: GOOD.map((id) => click(id)) });

    const current = await validatedMatch(owner);
    const ctx = await calibrationContext(db, storage, owner, current.id);
    expect(ctx.reusable.map((r) => r.matchTitle)).toEqual(["Calibration"]);
    expect(ctx.reusable[0]).toMatchObject({ pitchLength: 105, pitchWidth: 68, playersPerSide: 11 });
    expect(ctx.reusable[0].points).toHaveLength(GOOD.length);
    // A match's own calibration is not offered as "another match".
    const own = await calibrationContext(db, storage, owner, earlier.id);
    expect(own.reusable).toHaveLength(0);
  });
});
