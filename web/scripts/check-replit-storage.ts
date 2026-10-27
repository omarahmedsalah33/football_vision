/**
 * Explicit, opt-in smoke check against the configured development App Storage.
 * Creates only tiny uniquely named objects and removes them in finally.
 * Never prints signed URLs, private directory configuration, or credentials.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ReplitStorage } from "../src/server/storage/replit";

async function main() {
if (process.env.NODE_ENV === "production") throw new Error("Run this check in development, not production.");
const storage = new ReplitStorage();
const key = `_checks/${randomUUID()}/source`;
const count = process.argv.includes("--compose-tree") ? 33 : 2;
const chunks = Array.from({ length: count }, (_, index) =>
  index === 0 ? Buffer.from("\x00\x00\x00\x18ftypisom") : Buffer.from(`football-vision-private-storage-${index}`));
const expected = Buffer.concat(chunks);
let uploadId: string | undefined;
try {
  uploadId = await storage.createMultipartUpload(key);
  const parts = [];
  for (let index = 0; index < chunks.length; index++) {
    const url = await storage.presignUploadPart(key, uploadId, index + 1, chunks[index].length);
    const origin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://localhost";
    const preflight = await fetch(url, {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
    });
    // These requests use signed URLs, not cookies/credentialed CORS.
    assert(["*", origin].includes(preflight.headers.get("access-control-allow-origin") ?? ""), "Browser PUT CORS must allow this app origin");
    const response = await fetch(url, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream", Origin: origin }, body: chunks[index],
    });
    assert(response.ok, "Direct signed chunk PUT failed");
    // Exercise the server receipt path used when browser CORS does not expose ETag.
    const etag = await storage.uploadPartReceipt(key, uploadId, index + 1, chunks[index].length);
    parts.push({ partNumber: index + 1, etag, sizeBytes: chunks[index].length });
  }
  await assert.rejects(
    storage.completeMultipartUpload(key, uploadId, parts.map((part, i) => i ? part : { ...part, sizeBytes: part.sizeBytes + 1 })),
    /incorrect size/,
  );
  assert.equal(await storage.headObjectSize(key), null, "Rejected chunks must not create a source object");
  await storage.completeMultipartUpload(key, uploadId, parts);
  assert.equal(await storage.headObjectSize(key), expected.length);
  assert.deepEqual(Buffer.from(await storage.readRange(key, 0, 7)), expected.subarray(0, 8));
  const readUrl = await storage.presignGet(key, "application/octet-stream", 60);
  const response = await fetch(readUrl);
  assert(response.ok, "Signed download failed");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  const anonymous = new URL(readUrl);
  anonymous.search = "";
  const privateResponse = await fetch(anonymous);
  assert([401, 403].includes(privateResponse.status), "Private footage must not be anonymously readable");
  console.log("PASS: browser CORS, verified part receipts, direct chunk PUT, size rejection, composition, range read, signed read, anonymous denial.");
} finally {
  if (uploadId) await storage.abortMultipartUpload(key, uploadId).catch(() => {});
  await storage.deleteObject(key);
}
}

main().catch((error: unknown) => {
  if (error instanceof assert.AssertionError) console.error(error.message);
  else console.error("Storage smoke check failed:", (error as { code?: string }).code ?? "storage operation error");
  process.exitCode = 1;
});
