import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClerkClient } from "@clerk/backend";
import AxeBuilder from "@axe-core/playwright";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedAnalysis } from "./app";
import { trackBrowserErrors } from "./browser-errors";

const SHOTS = resolve(__dirname, "../test-results/screenshots");

async function noSeriousA11yIssues(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
}

test("a player goes from match evidence to a training plan, logs a session and reflects", async ({ browser }) => {
  test.setTimeout(240_000);
  const backend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const email = `dev-${randomUUID().slice(0, 8)}+clerk_test@example.com`;
  const clerkUser = await backend.users.createUser({ emailAddress: [email], firstName: "Salma", lastName: "Nabil", skipPasswordRequirement: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = trackBrowserErrors(page);
  try {
    await setupClerkTestingToken({ page });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: email });
    await page.goto("/app");
    // Retry until the page is interactive: a click before hydration does nothing.
    await expect(async () => {
      await page.getByRole("radio", { name: /I'm a player/ }).click();
      await expect(page.getByRole("heading", { name: "Your player profile" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole("radio", { name: "Midfielder" }).click();
    await page.getByRole("button", { name: "Create my profile" }).click();
    await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();

    // One analysed match; Salma is the player who ran least.
    await page.getByRole("link", { name: "New match", exact: true }).first().click();
    await page.getByLabel("Match title").fill("Saturday league");
    await page.getByRole("button", { name: "Create match" }).click();
    await expect(page.getByRole("article").getByText("Awaiting video")).toBeVisible();
    await seedAnalysis(page.url().split("/").pop()!);
    await page.reload();
    await page.getByRole("button", { name: /score (\d|1\d|2\d)\. Open report$/ }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "This is me" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Development: priorities with evidence, one match = limited evidence.
    const nav = page.getByRole("navigation", { name: "Sections" });
    await nav.getByRole("link", { name: "My development" }).click();
    await expect(page.getByRole("heading", { name: "My development" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Development priorities" })).toBeVisible();
    await expect(page.getByText(/Limited evidence/).first()).toBeVisible();
    await expect(page.getByText(/How we.ll measure it:/).first()).toBeVisible();
    await noSeriousA11yIssues(page);
    await page.screenshot({ path: `${SHOTS}/19-development-priorities.png`, fullPage: true });

    // Build the plan with the suggested priorities and drills.
    await page.getByRole("button", { name: "Build a plan" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Plan for you" })).toBeVisible();
    await expect(dialog.getByText(/sessions a week, about/)).toBeVisible();
    await dialog.getByRole("button", { name: "Start the plan" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Active plan", { exact: true })).toBeVisible();
    await expect(page.getByText("Training done", { exact: true })).toBeVisible();
    await expect(page.getByText("Waiting for evidence").first()).toBeVisible();

    // Log a session and reflect.
    await page.getByRole("button", { name: /^Log session:/ }).first().click();
    await dialog.getByLabel(/How did it go/).fill("Last sprints were slower than the first.");
    await dialog.getByRole("button", { name: "Save session" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/This week 1 of \d+/)).toBeVisible();
    await expect(page.getByText("“Last sprints were slower than the first.”")).toBeVisible();
    await page.getByLabel("Add a reflection").fill("Felt sharper by the end of the week.");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.getByText("Felt sharper by the end of the week.")).toBeVisible();

    // A self rating for something the video can't measure.
    await page.getByRole("button", { name: "Rate yourself" }).click();
    await dialog.getByLabel("Area").selectOption("scanning");
    await dialog.getByRole("radio", { name: /^2/ }).click();
    await dialog.getByRole("button", { name: "Save rating" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Self 2/5")).toBeVisible();
    await noSeriousA11yIssues(page);
    await page.screenshot({ path: `${SHOTS}/20-development-plan.png`, fullPage: true });

    // Home shows this week's training; the library is browsable.
    await nav.getByRole("link", { name: "Home" }).click();
    await expect(page.getByRole("link", { name: /This week’s training/ })).toBeVisible();
    await nav.getByRole("link", { name: "Training" }).click();
    await expect(page.getByRole("heading", { name: "Training library" })).toBeVisible();
    await page.getByRole("link", { name: "Tactical" }).click();
    const drill = page.getByRole("listitem").filter({ hasText: "Scan before you receive" });
    await drill.getByText("Scan before you receive").click();
    await expect(drill.getByText("Success looks like:")).toBeVisible();
    // The animated diagram: plays by itself, steps can be picked, captions follow the drill.
    await expect(drill.getByRole("img", { name: /^Diagram of Scan before you receive/ })).toBeVisible();
    await expect(drill.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await drill.getByRole("button", { name: /^Step 2:/ }).click();
    await expect(drill.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await expect(drill.getByText("Check over your shoulder and call out the cue before the ball arrives.")).toBeVisible();
    await drill.locator("figure").screenshot({ path: `${SHOTS}/21-drill-diagram.png` });
    await noSeriousA11yIssues(page);

    // Still signed in on the public site: the header offers the app, sign-in pages send you back to it.
    await page.goto("/");
    const header = page.getByRole("navigation", { name: "Main" });
    await expect(header.getByRole("link", { name: "Open app" })).toBeVisible();
    await expect(header.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open your workspace" }).first()).toBeVisible();
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/app\/[^/]+$/);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await backend.users.deleteUser(clerkUser.id);
  }
});
