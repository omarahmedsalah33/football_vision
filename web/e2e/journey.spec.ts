import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { trackBrowserErrors } from "./browser-errors";
import { E2E_EMAIL, FIXTURE_VIDEO, WORKER_PYTHON } from "./global-setup";

const SHOTS = resolve(__dirname, "../test-results/screenshots");

async function jobStatus(matchId: string): Promise<string | undefined> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      "select status from analysis_jobs where match_id = $1 order by created_at desc limit 1",
      [matchId],
    );
    return rows[0]?.status;
  } finally {
    await db.end();
  }
}

test("landing page renders and labels sample data honestly", async ({ page }) => {
  const errors = trackBrowserErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Professional-grade analysis");
  await expect(page.getByText("Illustrative data, not from a real match")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-landing-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Get started" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-landing-mobile.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("pages are served with a strict, per-request nonce CSP", async ({ request }) => {
  const nonces = new Set<string>();
  for (const path of ["/", "/", "/sign-in"]) {
    const res = await request.get(path);
    const csp = res.headers()["content-security-policy"] ?? "";
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toMatch(/\shttps?:(\s|$)/); // no scheme-wide script allowance
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");

    const nonce = scriptSrc.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce, `nonce on ${path}`).toBeTruthy();
    nonces.add(nonce!);
    // Every <script> Next.js renders must carry that nonce, or the browser would block it.
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, tag).toContain(`nonce="${nonce}"`);
  }
  expect(nonces.size, "a fresh nonce for every response").toBe(3);
});

test("anonymous visitors are sent to sign-in and cannot use the API", async ({ page, request }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await request.get("/api/orgs")).status()).toBe(401);
});

test("coach signs in, creates a match, uploads footage and sees it processed", async ({ page }) => {
  const errors = trackBrowserErrors(page);
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: E2E_EMAIL });

  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/[^/]+\/matches$/);
  await expect(page.getByRole("heading", { name: "Matches", exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-matches.png`, fullPage: true });

  await page.getByRole("link", { name: "New match", exact: true }).click();
  await page.getByLabel("Match title").fill("E2E League: Matchday 1");
  await page.getByLabel(/Opponent/).fill("Riverside FC");
  await page.screenshot({ path: `${SHOTS}/04-new-match.png`, fullPage: true });
  await page.getByRole("button", { name: "Create match" }).click();

  // Next keeps previously visited pages mounted (hidden), so scope assertions to this page.
  const matchPage = page.getByRole("article");
  await expect(matchPage.getByRole("heading", { name: "E2E League: Matchday 1" })).toBeVisible();
  await expect(matchPage.getByText("Awaiting video")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-match-awaiting-video.png`, fullPage: true });

  await page.locator('input[type="file"]').setInputFiles(FIXTURE_VIDEO);
  await expect(matchPage.getByText("Queued", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/06-match-queued.png`, fullPage: true });

  const matchId = page.url().split("/").pop()!;
  expect(await jobStatus(matchId), "job is committed before the worker runs").toBe("queued");

  // Process the queue with the real worker against the same database and storage.
  execFileSync(WORKER_PYTHON, ["-m", "fa_worker.main", "--once"], {
    cwd: resolve(__dirname, "../../worker"),
    stdio: "inherit",
    timeout: 90_000,
  });
  expect(await jobStatus(matchId), "worker finished the job").toBe("succeeded");

  // The page refreshes itself while work is in progress.
  await expect(matchPage.getByText("Analysed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(matchPage.getByText("1280×720 @ 25.0 fps")).toBeVisible();
  await expect(matchPage.getByText("The video passed validation.", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/07-match-analysed.png`, fullPage: true });

  await page.getByRole("link", { name: "Matches", exact: true }).click();
  await expect(page.getByRole("link", { name: /E2E League: Matchday 1/ }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/08-matches-list.png`, fullPage: true });

  expect(errors).toEqual([]);
});
