import type { Page } from "@playwright/test";

/**
 * Collects browser problems that indicate a bug in our app: script errors, CSP violations and
 * failed requests to our own origin. Network failures of third-party hosts (e.g. the identity
 * provider's CDN having a DNS hiccup) are logged but not counted, because they are outside our
 * control and would make the suite flaky without telling us anything about our code.
 */
export function trackBrowserErrors(page: Page, origin = "http://localhost:3000") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Resource load failures are judged by URL in the requestfailed/response handlers below.
    if (text.startsWith("Failed to load resource")) return;
    errors.push(`console: ${text}`);
  });
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "failed";
    // Cancellation, not failure: Next.js aborts prefetches and refreshes superseded by navigation.
    if (reason === "net::ERR_ABORTED") return;
    const msg = `${reason} ${req.url()}`;
    if (req.url().startsWith(origin)) errors.push(`request: ${msg}`);
    else console.warn(`[third-party network failure, not counted] ${msg}`);
  });
  page.on("response", (res) => {
    if (res.url().startsWith(origin) && res.status() >= 500) errors.push(`response ${res.status()}: ${res.url()}`);
  });
  return errors;
}
