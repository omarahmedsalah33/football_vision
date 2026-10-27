import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { DbOrTx } from "./client";
import * as schema from "./schema";

export type MigrationState = { expected: number; applied: number; upToDate: boolean };

/**
 * Compares the migrations shipped with this build (drizzle/meta/_journal.json) with the ones the
 * database has applied. Running new code against an older schema fails in confusing ways (a 500
 * on the first query touching a new table), so the server checks this at startup.
 */
export async function migrationState(db: DbOrTx, migrationsDir?: string): Promise<MigrationState> {
  // Replit Publish applies a schema diff, not Drizzle's migration-history rows.
  // Check the actual required columns, read-only; never run DDL at production startup.
  if (process.env.DATABASE_SCHEMA_MANAGEMENT === "replit" && migrationsDir === undefined) {
    const expectedColumns = new Set<string>();
    const tableNames: string[] = [];
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      tableNames.push(config.name);
      for (const column of config.columns) expectedColumns.add(`${config.name}.${column.name}`);
    }
    const result = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in (${sql.join(tableNames.map((name) => sql`${name}`), sql`, `)})
    `);
    const actual = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const applied = [...expectedColumns].filter((column) => actual.has(column)).length;
    return { expected: expectedColumns.size, applied, upToDate: applied === expectedColumns.size };
  }
  const journal = JSON.parse(await readFile(join(migrationsDir ?? join(process.cwd(), "drizzle"), "meta", "_journal.json"), "utf8")) as {
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
