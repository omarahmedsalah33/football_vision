import { eq } from "drizzle-orm";
import { deleteAccountBySubject } from "../account/service";
import type { DbOrTx } from "../db/client";
import { processedWebhooks, users } from "../db/schema";

/** The subset of Clerk's webhook events we act on. Everything else is acknowledged and ignored. */
export type ClerkEvent =
  | { type: "user.deleted"; data: { id?: string } }
  | {
      type: "user.updated";
      data: {
        id: string;
        first_name?: string | null;
        last_name?: string | null;
        primary_email_address_id?: string | null;
        email_addresses?: { id: string; email_address: string }[];
      };
    }
  | { type: string; data: unknown };

/**
 * Applies a verified Clerk event exactly once. `deliveryId` is the provider's message id; a
 * delivery seen before is acknowledged without being processed again.
 */
export async function handleClerkEvent(db: DbOrTx, deliveryId: string, event: ClerkEvent): Promise<"processed" | "duplicate" | "ignored"> {
  const inserted = await db
    .insert(processedWebhooks)
    .values({ id: `clerk:${deliveryId}`, type: event.type })
    .onConflictDoNothing()
    .returning({ id: processedWebhooks.id });
  if (inserted.length === 0) return "duplicate";

  try {
    if (event.type === "user.deleted") {
      const id = (event.data as { id?: string }).id;
      if (id) await deleteAccountBySubject(db, id);
      return "processed";
    }
    if (event.type === "user.updated") {
      const d = (event as Extract<ClerkEvent, { type: "user.updated" }>).data;
      const primary = d.email_addresses?.find((e) => e.id === d.primary_email_address_id)?.email_address ?? null;
      const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || null;
      await db.update(users).set({ email: primary?.toLowerCase() ?? null, displayName: name }).where(eq(users.authSubject, d.id));
      return "processed";
    }
    return "ignored";
  } catch (err) {
    // Let the provider retry: forget this delivery so the retry is processed.
    await db.delete(processedWebhooks).where(eq(processedWebhooks.id, `clerk:${deliveryId}`));
    throw err;
  }
}
