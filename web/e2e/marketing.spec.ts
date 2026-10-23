import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { trackBrowserErrors } from "./browser-errors";

const PAGES = ["/", "/solutions", "/pricing", "/docs", "/faq", "/about", "/contact", "/ai-limitations", "/legal/privacy", "/legal/terms", "/sign-in"];

for (const path of PAGES) {
  test(`${path} loads cleanly and passes WCAG 2.1 AA checks`, async ({ page }) => {
    const errors = trackBrowserErrors(page);

    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/Football Vision/);
    if (path !== "/sign-in") await expect(page.locator("h1")).toHaveCount(1);
    await page.waitForLoadState("load");

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      // Third-party sign-in widget is rendered and audited by its vendor.
      .exclude(".cl-rootBox")
      .analyze();
    const serious = axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
    expect(serious, serious.join("\n")).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("every footer link leads to a working page", async ({ page, request }) => {
  await page.goto("/");
  const hrefs = await page.locator("footer a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  expect(hrefs.length).toBeGreaterThan(8);
  for (const href of new Set(hrefs.map((h) => h.split("#")[0] || "/"))) {
    expect((await request.get(href)).status(), href).toBe(200);
  }
});

test("pricing shows the limits the server enforces", async ({ page }) => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query("select limits from plans where id = 'free'");
  await db.end();
  await page.goto("/pricing");
  const free = page.locator("li", { has: page.getByRole("heading", { name: "Free trial" }) });
  await expect(free.getByText("Match analyses / month").locator("..")).toContainText(String(rows[0].limits.monthlyAnalyses));
});

test("contact form submits and stores the message", async ({ page }) => {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.com`;
  await page.goto("/contact");
  await page.getByLabel("Your name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Topic").selectOption("support");
  await page.getByLabel("Message").fill("Testing the contact form end to end.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Message received")).toBeVisible();

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query("select topic from contact_messages where email = $1", [email]);
  await db.end();
  expect(rows).toEqual([{ topic: "support" }]);
});
