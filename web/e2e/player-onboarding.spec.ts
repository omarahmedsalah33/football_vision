import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClerkClient } from "@clerk/backend";
import AxeBuilder from "@axe-core/playwright";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { seedAnalysis } from "./app";
import { trackBrowserErrors } from "./browser-errors";

const SHOTS = resolve(__dirname, "../test-results/screenshots");

test("a new player signs up, creates their profile, taps “This is me” and their profile fills in", async ({ browser }) => {
  test.setTimeout(240_000);
  const backend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const email = `player-${randomUUID().slice(0, 8)}+clerk_test@example.com`;
  const clerkUser = await backend.users.createUser({ emailAddress: [email], firstName: "Youssef", lastName: "Ali", skipPasswordRequirement: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = trackBrowserErrors(page);
  try {
    await setupClerkTestingToken({ page });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: email });

    // First visit: how will you use Football Vision?
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app\/welcome$/);
    await expect(page.getByRole("heading", { name: /Welcome, Youssef/ })).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/17-welcome.png`, fullPage: true });
    await page.getByRole("radio", { name: /I'm a player/ }).click();

    await expect(page.getByRole("heading", { name: "Your player profile" })).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("Youssef Ali");
    await page.getByRole("radio", { name: "Midfielder" }).click();
    await page.getByRole("radio", { name: "Right" }).click();
    await page.getByLabel(/Shirt number/).fill("8");
    await page.getByLabel(/Birth year/).fill("2009");
    await page.getByLabel(/Club or team/).fill("Nile Stars");
    await page.getByRole("button", { name: "Create my profile" }).click();

    // Their own profile, empty until a match is linked.
    await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
    await expect(page.getByText("Build your profile")).toBeVisible();
    await expect(page.getByRole("heading", { name: /8 Youssef Ali/ })).toBeVisible();

    // Upload → analysis (seeded) → "This is me".
    await page.getByRole("link", { name: "New match", exact: true }).first().click();
    await page.getByLabel("Match title").fill("Sunday league");
    await page.getByRole("button", { name: "Create match" }).click();
    await expect(page.getByRole("article").getByText("Awaiting video")).toBeVisible();
    await seedAnalysis(page.url().split("/").pop()!);
    await page.reload();
    const cards = page.getByRole("button", { name: /Open report$/ });
    await cards.first().click();
    await page.getByRole("dialog").getByRole("button", { name: "This is me" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(cards.first()).toHaveAccessibleName(/Youssef Ali, Team A/);

    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "My profile" }).click();
    await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
    await expect(page.getByText("1 match analysed")).toBeVisible();
    await expect(page.getByRole("img", { name: /Average score \d+ out of 100/ })).toBeVisible();
    await expect(page.getByText("Top speed").first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Sunday league" })).toBeVisible();
    await expect(page.getByText(/analyses this month/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/18-my-profile.png`, fullPage: true });

    // Home shows their profile card.
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Home" }).click();
    await expect(page.getByRole("link", { name: /My profile Youssef Ali/ })).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await backend.users.deleteUser(clerkUser.id);
  }
});
