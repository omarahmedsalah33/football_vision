import { expect, it } from "vitest";
import { validatePlayerPhotos, WorkerConflict } from "@/server/jobs/worker-service";

const root = "orgs/test/matches/test/analysis/job/";
const slots = [1, 2].map(i => `${root}players/${i}.jpg`);
const catalog = [{ id: "Unknown1", photoKey: slots[0] }, { id: "Unknown2", photoKey: null }];

it("accepts mixed, entirely missing, and empty player photos with registered slots", () => {
  expect(() => validatePlayerPhotos(catalog, root, slots)).not.toThrow();
  expect(() => validatePlayerPhotos(catalog.map(p => ({ ...p, photoKey: null })), root, slots)).not.toThrow();
  expect(() => validatePlayerPhotos([], root, [])).not.toThrow();
});

it("still rejects foreign paths, swapped slots, wrong player IDs and unregistered outputs", () => {
  const cases = [
    () => validatePlayerPhotos([{ ...catalog[0], photoKey: "orgs/other/private.jpg" }, catalog[1]], root, slots),
    () => validatePlayerPhotos([{ ...catalog[0], photoKey: slots[1] }, catalog[1]], root, slots),
    () => validatePlayerPhotos([{ ...catalog[0], id: "Unknown2" }, catalog[1]], root, slots),
    () => validatePlayerPhotos(catalog, root, undefined),
    () => validatePlayerPhotos(catalog, root, slots.slice(0, 1)),
    () => validatePlayerPhotos(catalog, root, [...slots].reverse()),
  ];
  for (const run of cases) {
    expect(run).toThrow(WorkerConflict);
    try { run(); } catch (error) {
      expect((error as WorkerConflict).code).toBe("worker_result_invalid");
    }
  }
});
