import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { log } from "@/server/log";
import { handleClerkEvent, type ClerkEvent } from "@/server/webhooks/clerk";

// Server-to-server: no browser origin or session. Authenticity comes only from the signature.
export async function POST(req: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "not_configured", message: "Webhook not configured." } }, { status: 503 });
  }
  const deliveryId = req.headers.get("svix-id");
  let event: ClerkEvent;
  try {
    event = (await verifyWebhook(req, { signingSecret: secret })) as ClerkEvent;
  } catch {
    // Forged, tampered or stale (replayed outside the tolerance window) deliveries end here.
    return NextResponse.json({ error: { code: "invalid_signature", message: "Invalid signature." } }, { status: 400 });
  }
  if (!deliveryId) return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400 });

  try {
    const result = await handleClerkEvent(getDb(), deliveryId, event);
    return NextResponse.json({ result });
  } catch (err) {
    log.error({ err, type: event.type }, "clerk webhook processing failed");
    return NextResponse.json({ error: { code: "internal" } }, { status: 500 });
  }
}
