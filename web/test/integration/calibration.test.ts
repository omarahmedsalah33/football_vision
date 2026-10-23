import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apply, fitHomography, invert, type Mat3 } from "../../src/lib/pitch/homography";
import { LANDMARK_BY_ID, STANDARD_PITCH } from "../../src/lib/pitch/landmarks";
import type { Actor } from "../../src/server/authz/permissions";
import { saveCalibration } from "../../src/server/calibration/service";
import { videos } from "../../src/server/db/schema";
import { enqueueAnalysis } from "../../src/server/jobs/service";
import { createMatch, getMatch } from "../../src/server/matches/service";
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

function click(id: string, nudge: [number, number] = [0, 0]) {
  const [x, y] = apply(PITCH_TO_IMAGE, LANDMARK_BY_ID.get(id)!.at(STANDARD_PITCH));
  return { landmark: id, x: x + nudge[0], y: y + nudge[1] };
}
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
    const four = GOOD.slice(0, 4).map((id) => click(id));
    await expect(saveCalibration(db, actor, match.id, { ...base, points: [...four, { landmark: "moon", x: 1, y: 1 }] })).rejects.toMatchObject({ status: 422 });
    await expect(saveCalibration(db, actor, match.id, { ...base, points: [...four, four[0]] })).rejects.toMatchObject({ status: 422 });
    await expect(saveCalibration(db, actor, match.id, { ...base, points: [...four.slice(1), { ...four[0], x: 5000 }] })).rejects.toMatchObject({ status: 422 });
    const line = ["halfway_far", "circle_far", "centre_spot", "circle_near"].map((id) => click(id));
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
});
