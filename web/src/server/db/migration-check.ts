import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "./client";

export type MigrationState = { expected: number; applied: number; upToDate: boolean };

/**
 * Compares the migrations shipped with this build (drizzle/meta/_journal.json) with the ones the
 * database has applied. Running new code against an older schema fails in confusing ways (a 500
 * on the first query touching a new table), so the server checks this at startup.
 */
export async function migrationState(db: DbOrTx, migrationsDir = join(process.cwd(), "drizzle")): Promise<MigrationState> {
  const journal = JSON.parse(await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  const expected = journal.entries.length;
  let applied = 0;
  try {
    const result = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    applied = Number(result.rows[0]?.n ?? 0);
  } catch {
    applied = 0; // migrations table missing: nothing applied
  }
  return { expected, applied, upToDate: applied >= expected };
}
