import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contactInput, ipKey, submitContact } from "../../src/server/contact/service";
import { contactMessages } from "../../src/server/db/schema";
import { testDb } from "../helpers";

const db = testDb();
const valid = {
  name: "Coach Salma",
  email: "Salma@Example.com",
  organization: "Cairo Youth FC",
  topic: "sales" as const,
  message: "We have three U-age teams and would like a demo.",
};

describe("contact form", () => {
  it("stores a valid message with a normalised email", async () => {
    const email = `${randomUUID()}@example.com`;
    expect(await submitContact(db, contactInput.parse({ ...valid, email }), ipKey(randomUUID(), "salt"))).toBe(true);
    const [row] = await db.select().from(contactMessages).where(eq(contactMessages.email, email));
    expect(row).toMatchObject({ name: "Coach Salma", topic: "sales" });
  });

  it("silently drops honeypot submissions", async () => {
    const email = `${randomUUID()}@example.com`;
    const stored = await submitContact(db, contactInput.parse({ ...valid, email, website: "http://spam" }), ipKey(randomUUID(), "salt"));
    expect(stored).toBe(false);
    expect(await db.select().from(contactMessages).where(eq(contactMessages.email, email))).toHaveLength(0);
  });

  it("rate limits per (hashed) IP address", async () => {
    const ip = ipKey(randomUUID(), "salt");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => submitContact(db, contactInput.parse(valid), ip)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 429 } });
  });

  it("rejects invalid input", () => {
    expect(contactInput.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
    expect(contactInput.safeParse({ ...valid, message: "hi" }).success).toBe(false);
    expect(contactInput.safeParse({ ...valid, topic: "hacking" }).success).toBe(false);
  });

  it("never keeps the raw IP: the key is a one-way hash", () => {
    const key = ipKey("203.0.113.7", "salt");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("203");
  });
});
