import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk's proxy makes the session available to auth() and sets the CSP. It deliberately does not
// gate routes by path: every page and API handler checks identity and membership itself
// (src/server/auth), so authorization never depends on URL matching.

// Browsers upload video parts straight to object storage, so its origin must be allowed.
const storageOrigin = process.env.S3_PUBLIC_ENDPOINT ? new URL(process.env.S3_PUBLIC_ENDPOINT).origin : undefined;

export default clerkMiddleware({
  contentSecurityPolicy: {
    // Strict CSP: per-request nonce + 'strict-dynamic'. Modern browsers then ignore host
    // allowlists and 'unsafe-inline' for scripts; 'unsafe-eval' is only added in development.
    strict: true,
    directives: {
      "connect-src": storageOrigin ? [storageOrigin] : [],
      "img-src": ["data:", "blob:"],
      "media-src": ["blob:", ...(storageOrigin ? [storageOrigin] : [])],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
    },
  },
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
