import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { openApp, seedAnalysis } from "./app";
import { trackBrowserErrors } from "./browser-errors";
import { E2E_EMAIL } from "./global-setup";

const SHOTS = resolve(__dirname, "../test-results/screenshots");

test("a coach reads player reports and links a tracked player to a squad profile", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackBrowserErrors(page);
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: E2E_EMAIL });

  await openApp(page);
  await page.getByRole("link", { name: "New match", exact: true }).first().click();
  await page.getByLabel("Match title").fill(`E2E Players ${Date.now()}`);
  await page.getByRole("button", { name: "Create match" }).click();
  await expect(page.getByRole("article").getByText("Awaiting video")).toBeVisible();
  const matchId = page.url().split("/").pop()!;
  await seedAnalysis(matchId);
  await page.reload();

  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Results" }) });
  await expect(page.getByRole("heading", { name: "Players", exact: true })).toBeVisible();
  // 12 outfield and goalkeeper players; the referee is left out of the cards.
  const cards = page.getByRole("button", { name: /Open report$/ });
  await expect(cards).toHaveCount(12);
  // Sorted by score: the hardest-running player first, with a score out of 100.
  await expect(cards.first()).toHaveAccessibleName(/Player 2, Team A, score (9\d|100)\. Open report/);
  await expect(page.getByText("Goalkeepers aren't compared with outfield running numbers.").first()).toBeVisible();
  await expect(page.getByText(/Not measured yet:/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/14-players.png`, fullPage: true });

  await cards.first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "How the score is built" })).toBeVisible();
  await expect(dialog.getByText(/Covers a lot of ground: 128 m\/min/)).toBeVisible();
  await expect(dialog.getByText(/Kept up the work rate to the end: 99%/)).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/15-player-report.png` });

  // Link the tracked player to a new squad profile; the match then counts on that profile.
  const name = `Omar Hassan ${Date.now() % 100000}`;
  await dialog.getByLabel("Link to a player").selectOption("new");
  await dialog.getByLabel("New player's name").fill(name);
  await dialog.getByRole("button", { name: "Add and link" }).click();
  await expect(dialog).toBeHidden();
  await expect(cards.first()).toHaveAccessibleName(new RegExp(`${name}, Team A`));

  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Players" }).click();
  await page.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name: "Player profile" })).toBeVisible();
  await expect(page.getByText("1 match analysed")).toBeVisible();
  await expect(page.getByRole("img", { name: /Average score (9\d|100) out of 100/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /E2E Players/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/16-player-profile.png`, fullPage: true });
  void panel;

  expect(errors).toEqual([]);
});
