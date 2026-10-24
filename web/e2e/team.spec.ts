import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { trackBrowserErrors } from "./browser-errors";
import { E2E_EMAIL, E2E_EMAIL_2 } from "./global-setup";

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
  return page;
}

test("owner creates a club, invites a coach who joins, then manages and removes them", async ({ browser }) => {
  const owner = await signedIn(browser, E2E_EMAIL);
  const ownerErrors = trackBrowserErrors(owner);
  const clubName = `E2E Club ${randomUUID().slice(0, 6)}`;

  await owner.goto("/app/new");
  await owner.getByLabel("Club or academy name").fill(clubName);
  await owner.getByRole("button", { name: "Create workspace" }).click();
  await expect(owner).toHaveURL(/\/members$/);

  await owner.getByLabel("Email").fill(E2E_EMAIL_2);
  await owner.getByRole("combobox", { name: "Role", exact: true }).selectOption("coach");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  const link = await owner.locator("code").filter({ hasText: "/invite/" }).innerText();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
  await expect(owner.getByText("Pending invitations")).toBeVisible();

  // The invited person, in a separate browser session.
  const coach = await signedIn(browser, E2E_EMAIL_2);
  const coachErrors = trackBrowserErrors(coach);
  await coach.goto(new URL(link).pathname);
  await expect(coach.getByRole("heading", { name: `Join ${clubName}` })).toBeVisible();
  await coach.getByRole("button", { name: "Accept invitation" }).click();
  await expect(coach).toHaveURL(/\/app\/[^/]+$/);
  await expect(coach.getByText("Club · Coach")).toBeVisible();

  // The same link can't be used twice.
  await coach.goto(new URL(link).pathname);
  await expect(coach.getByRole("heading", { name: "Invitation not valid" })).toBeVisible();

  // Owner sees the new member, changes the role, checks usage and the activity log, then removes them.
  await owner.reload();
  const row = owner.getByRole("row", { name: /Second Coach/ });
  await expect(row).toBeVisible();
  await row.getByRole("combobox").selectOption("analyst");
  await expect(row.getByRole("combobox")).toHaveValue("analyst");

  await owner.getByRole("link", { name: "Settings" }).click();
  await expect(owner.getByText("Plan & usage")).toBeVisible();
  await expect(owner.getByRole("meter", { name: "Members" })).toHaveAttribute("aria-valuenow", "2");
  for (const entry of ["Workspace created", "Invitation sent", "Member joined", "Role changed"]) {
    await expect(owner.getByText(entry).first()).toBeVisible();
  }

  await owner.getByRole("link", { name: "Members" }).click();
  owner.once("dialog", (d) => d.accept());
  await owner.getByRole("row", { name: /Second Coach/ }).getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("row", { name: /Second Coach/ })).toHaveCount(0);

  // The removed coach has lost access.
  await coach.goto(new URL(owner.url()).pathname.replace(/\/members$/, "/matches"));
  await expect(coach.getByText("This page could not be found.")).toBeVisible();

  expect(ownerErrors).toEqual([]);
  expect(coachErrors).toEqual([]);
});

test("a user can delete their account, which also removes it from the identity provider", async ({ browser }) => {
  const secretKey = process.env.CLERK_SECRET_KEY!;
  const backend = createClerkClient({ secretKey });
  const email = `delete-${randomUUID().slice(0, 8)}+clerk_test@example.com`;
  await backend.users.createUser({ emailAddress: [email], firstName: "Temp", lastName: "User", skipPasswordRequirement: true });

  const page = await signedIn(browser, email);
  const errors = trackBrowserErrors(page);
  await page.goto("/app"); // first visit creates the local account and personal workspace
  await expect(page).toHaveURL(/\/app\/[^/]+$/);

  await page.goto("/app/account");
  await expect(page.getByText("These workspaces will be deleted")).toBeVisible();
  await page.getByLabel(/Type DELETE to confirm/).fill("DELETE");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page).toHaveURL("http://localhost:3000/");

  await expect.poll(async () => (await backend.users.getUserList({ emailAddress: [email] })).data.length).toBe(0);
  expect(errors).toEqual([]);
});
