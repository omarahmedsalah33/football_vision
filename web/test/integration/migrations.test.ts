import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationState } from "../../src/server/db/migration-check";
import { testDb } from "../helpers";

const db = testDb();

async function journalWith(entries: number) {
  const dir = await mkdtemp(join(tmpdir(), "fv-journal-"));
  await mkdir(join(dir, "meta"));
  await writeFile(join(dir, "meta", "_journal.json"), JSON.stringify({ entries: Array.from({ length: entries }, (_, i) => ({ idx: i })) }));
  return dir;
}

describe("startup migration check", () => {
  it("reports up to date when every shipped migration is applied", async () => {
    const state = await migrationState(db); // test DB is migrated by global setup
    expect(state.expected).toBeGreaterThan(0);
    expect(state).toMatchObject({ upToDate: true, applied: state.expected });
  });

  it("detects a database that is behind the build", async () => {
    const state = await migrationState(db, await journalWith(999));
    expect(state).toMatchObject({ expected: 999, upToDate: false });
  });
});
