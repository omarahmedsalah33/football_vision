import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createClerkClient } from "@clerk/backend";
import { clerkSetup } from "@clerk/testing/playwright";
import { config } from "dotenv";
import { Client } from "pg";

export const E2E_EMAIL = "e2e+clerk_test@example.com";
export const WORKER_PYTHON = resolve(__dirname, "../../worker/.venv/Scripts/python.exe");
export const FIXTURE_VIDEO = resolve(__dirname, "../test-results/fixtures/e2e-match.mp4");

export default async function globalSetup() {
  config({ path: ".env.local", quiet: true });
  process.env.CLERK_PUBLISHABLE_KEY ??= process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!process.env.CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY missing from .env.local");

  // Testing token lets automated browsers pass Clerk's bot protection on development instances.
  await clerkSetup();

  // Ensure the test user exists in the Clerk development instance.
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const existing = await clerk.users.getUserList({ emailAddress: [E2E_EMAIL] });
  if (existing.data.length === 0) {
    await clerk.users.createUser({
      emailAddress: [E2E_EMAIL],
      firstName: "E2E",
      lastName: "Coach",
      skipPasswordRequirement: true,
    });
  }

  // The free plan allows one analysis a month; give each run a fresh allowance (dev database only).
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(
    `delete from usage_periods where org_id in (
       select m.org_id from memberships m join users u on u.id = m.user_id where u.email = $1)`,
    [E2E_EMAIL],
  );
  await db.end();

  // A synthetic 70 s 720p video (two upload parts), generated with the worker's own helper.
  if (!existsSync(FIXTURE_VIDEO)) {
    await mkdir(resolve(FIXTURE_VIDEO, ".."), { recursive: true });
    execFileSync(
      WORKER_PYTHON,
      [
        "-c",
        "import sys; from pathlib import Path; from tests.conftest import write_video; " +
          "write_video(Path(sys.argv[1]), seconds=70, fps=25, width=1280, height=720)",
        FIXTURE_VIDEO,
      ],
      { cwd: resolve(__dirname, "../../worker"), stdio: "inherit" },
    );
  }
}
