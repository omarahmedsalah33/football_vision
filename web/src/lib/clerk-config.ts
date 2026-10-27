import { publishableKeyFromHost } from "@clerk/shared/keys";

/** Same public host/key selection as Replit's Express Clerk proxy. No secret is returned. */
export function clerkPublicConfig(headers: Pick<Headers, "get">) {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim();
  return {
    publishableKey: publishableKeyFromHost(
      host,
      process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    ),
    proxyUrl: process.env.CLERK_PROXY_URL || undefined,
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
    signInFallbackRedirectUrl: "/app",
    signUpFallbackRedirectUrl: "/app",
    afterSignOutUrl: "/",
  };
}
