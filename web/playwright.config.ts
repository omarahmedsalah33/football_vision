import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the real app (dev server, local Postgres + storage, real worker) with a
// real Clerk development instance. Run with `npm run e2e` after `docker compose up -d`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // One retry: these tests depend on the identity provider's network services, which time out
  // occasionally. Playwright reports a pass-on-retry as "flaky", so it stays visible.
  retries: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A stuck click fails with a clear message instead of using up the whole test timeout.
    actionTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
