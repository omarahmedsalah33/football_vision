import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { apply, fitHomography } from "../src/lib/pitch/homography";
import { LANDMARK_BY_ID, STANDARD_PITCH } from "../src/lib/pitch/landmarks";
import { trackBrowserErrors } from "./browser-errors";
import { E2E_EMAIL, FIXTURE_VIDEO, WORKER_PYTHON } from "./global-setup";

const SHOTS = resolve(__dirname, "../test-results/screenshots");

async function jobStatus(matchId: string, kind: "prepare" | "analyze"): Promise<string | undefined> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      "select status from analysis_jobs where match_id = $1 and kind = $2 order by created_at desc limit 1",
      [matchId, kind],
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

// A camera on the halfway line: where the pitch corners appear in a 1280×720 frame.
const PITCH_TO_IMAGE = fitHomography([
  { image: [0, 0], pitch: [260, 110] },
  { image: [105, 0], pitch: [1020, 110] },
  { image: [105, 68], pitch: [1255, 700] },
  { image: [0, 68], pitch: [25, 700] },
]);
async function clickOnFrame(page: import("@playwright/test").Page, id: string) {
  const box = (await page.getByRole("application").boundingBox())!;
  const [px, py] = apply(PITCH_TO_IMAGE, LANDMARK_BY_ID.get(id)!.at(STANDARD_PITCH));
  await page.mouse.click(box.x + (px / 1280) * box.width, box.y + (py / 720) * box.height);
}

function runWorker(timeout: number) {
  execFileSync(WORKER_PYTHON, ["-m", "fa_worker.main", "--once"], { cwd: resolve(__dirname, "../../worker"), stdio: "inherit", timeout });
}

test("coach signs in, uploads footage, calibrates the pitch and gets an analysis", async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors = trackBrowserErrors(page);
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: E2E_EMAIL });

  await page.goto("/app");
  // Signing in lands on the workspace home.
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await expect(page.getByRole("heading", { name: /^Welcome back/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Matches" }).click();
  await expect(page.getByRole("heading", { name: "Matches", exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-matches.png`, fullPage: true });

  await page.getByRole("link", { name: "New match", exact: true }).first().click();
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
  await expect(matchPage.getByText("Checking video", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/06-match-checking.png`, fullPage: true });

  const matchId = page.url().split("/").pop()!;
  expect(await jobStatus(matchId, "prepare"), "prepare job is committed before the worker runs").toBe("queued");
  runWorker(120_000);
  expect(await jobStatus(matchId, "prepare")).toBe("succeeded");

  // The page refreshes itself while work is in progress.
  await expect(matchPage.getByText("Needs calibration", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(matchPage.getByText("1280×720 @ 25.0 fps")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/07-match-needs-calibration.png`, fullPage: true });

  // Calibrate with the guided flow: pick the pitch type, then click the points it asks for, where a
  // known camera would see them. One point is skipped and one is chosen on the pitch drawing.
  await matchPage.getByRole("link", { name: "Calibrate pitch" }).click();
  await expect(page.getByRole("heading", { name: "Calibrate pitch" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Full size/ })).toHaveAttribute("aria-checked", "true");
  // A small-sided pitch asks only for corners and halfway points; switching back restores full size.
  await page.getByRole("radio", { name: /5- or 6-a-side/ }).click();
  await expect(page.getByLabel("Length, goal to goal (m)")).toHaveValue("40");
  await page.screenshot({ path: `${SHOTS}/08a-pitch-type.png`, fullPage: true });
  await page.getByRole("button", { name: "Next: mark the pitch" }).click();
  await expect(page.getByRole("button", { name: /^Select / })).toHaveCount(7);
  await page.screenshot({ path: `${SHOTS}/08b-calibration-small-sided.png`, fullPage: true });
  await page.getByRole("button", { name: "Change pitch" }).click();
  await page.getByRole("radio", { name: /Full size/ }).click();
  await page.getByRole("button", { name: "Next: mark the pitch" }).click();
  await expect(page.getByRole("button", { name: /^Select / })).toHaveCount(27);
  await expect(page.getByRole("application")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Click the far-left corner" })).toBeVisible();
  for (const id of ["left_corner_far", "halfway_far", "right_corner_far"]) await clickOnFrame(page, id);
  await expect(page.getByRole("heading", { name: "Click the near-right corner" })).toBeVisible();
  await page.getByRole("button", { name: "I can't see this point" }).click();
  await page.getByRole("button", { name: /^Select the near corner of the right penalty box/ }).click();
  await clickOnFrame(page, "right_box_near");
  await expect(page.getByRole("heading", { name: "Click where the halfway line meets the near touchline" })).toBeVisible();
  await expect(page.getByText("4 placed")).toBeVisible();
  for (const id of ["halfway_near", "left_corner_near"]) await clickOnFrame(page, id);
  await expect(page.getByRole("heading", { name: /^Great: accurate to about 0\.\d m$/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/08-calibration.png`, fullPage: true });
  await page.getByRole("button", { name: "Yes, save calibration" }).click();

  // Analyse with the real detector (RF-DETR) and tracker.
  await expect(matchPage.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  await matchPage.getByRole("button", { name: "Start analysis" }).click();
  await expect(matchPage.getByText("Queued", { exact: true })).toBeVisible({ timeout: 30_000 });
  runWorker(900_000);
  expect(await jobStatus(matchId, "analyze"), "worker finished the analysis").toBe("succeeded");
  await expect(matchPage.getByText("Analysed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(page.getByText("How reliable is this?")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/09-results.png`, fullPage: true });

  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Matches" }).click();
  await expect(page.getByRole("link", { name: /E2E League: Matchday 1/ }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-matches-list.png`, fullPage: true });
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome back/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Latest results" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11-home.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // On phones the navigation is a drawer, hidden until the menu button opens it.
  await expect(page.locator("#app-sidebar")).not.toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/12-home-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(page.locator("#app-sidebar")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `${SHOTS}/13-menu-mobile.png` });
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Matches" }).click();
  await expect(page.getByRole("heading", { name: "Matches", exact: true })).toBeVisible();
  await expect(page.locator("#app-sidebar")).not.toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 900 });

  expect(errors).toEqual([]);
});

test("an owner deletes a match after confirming", async ({ page }) => {
  const errors = trackBrowserErrors(page);
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: E2E_EMAIL });

  const title = `E2E Delete me ${Date.now()}`;
  await page.goto("/app");
  await page.getByRole("link", { name: "New match", exact: true }).first().click();
  await page.getByLabel("Match title").fill(title);
  await page.getByRole("button", { name: "Create match" }).click();
  const matchPage = page.getByRole("article");
  await expect(matchPage.getByRole("heading", { name: title })).toBeVisible();
  const matchUrl = page.url();

  // Cancelling the confirmation keeps the match.
  await matchPage.getByRole("button", { name: "Delete match" }).click();
  await matchPage.getByRole("button", { name: "Cancel" }).click();
  await expect(matchPage.getByRole("heading", { name: title })).toBeVisible();

  await matchPage.getByRole("button", { name: "Delete match" }).click();
  await expect(matchPage.getByRole("alertdialog")).toContainText(title);
  await matchPage.getByRole("button", { name: "Yes, delete match" }).click();
  await expect(page).toHaveURL(/\/app\/[^/]+\/matches$/);
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // The old address no longer shows the match. (The page streams, so the 404 is rendered in the
  // body after a 200 status line has already been sent.)
  await page.goto(matchUrl);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toHaveCount(0);

  expect(errors).toEqual([]);
});
