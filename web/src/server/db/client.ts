import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

let pool: Pool | undefined;
let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    pool = new Pool({ connectionString: env().DATABASE_URL, max: 10, statement_timeout: 15_000 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const p = new Pool({ connectionString, max: 10 });
  return { db: drizzle(p, { schema }), pool: p };
}
