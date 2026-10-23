import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// Rebuilds the test database schema from the migrations before every run, so tests exercise the
// exact SQL that production applies.
export default async function setup() {
  config({ path: ".env", quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/_test(\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must point at a *_test database");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();
}
