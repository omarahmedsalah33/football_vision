import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbOrTx } from "../db/client";
import { contactMessages } from "../db/schema";
import { enforceRateLimit, type Limit } from "../http/rate-limit";

export const contactInput = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(200),
  organization: z.string().trim().max(120).optional(),
  topic: z.enum(["sales", "support", "partnership", "privacy", "other"]),
  message: z.string().trim().min(10).max(4000),
  // Honeypot: hidden from people, filled in by naive bots.
  website: z.string().max(200).optional(),
});

export const CONTACT_LIMIT: Limit = { name: "contact", perMinute: 3 };

/** One-way hash so rate limiting never stores a raw IP address. */
export function ipKey(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * Stores a contact message. Bot submissions (honeypot filled) are accepted silently but not
 * stored, so bots learn nothing. Returns whether a message was stored.
 */
export async function submitContact(db: DbOrTx, input: z.infer<typeof contactInput>, ipHash: string): Promise<boolean> {
  await enforceRateLimit(db, CONTACT_LIMIT, ipHash);
  if (input.website) return false;
  await db.insert(contactMessages).values({
    name: input.name,
    email: input.email.toLowerCase(),
    organization: input.organization || null,
    topic: input.topic,
    message: input.message,
  });
  return true;
}
