// Errors whose `message` is safe to return to the client. Anything else is logged and
// reported as a generic 500 so internals never leak.
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = () => new AppError(401, "unauthenticated", "Sign in to continue.");
export const forbidden = () => new AppError(403, "forbidden", "You do not have permission to do this.");
// Used for both missing and other-tenant resources so existence is never revealed.
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found.`);
export const conflict = (message: string) => new AppError(409, "conflict", message);
export const invalidInput = (message: string, details?: unknown) =>
  new AppError(422, "invalid_input", message, details);
export const quotaExceeded = (message: string) => new AppError(402, "quota_exceeded", message);
export const payloadTooLarge = (message: string) => new AppError(413, "payload_too_large", message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids that are not UUIDs cannot exist; answer 404 instead of letting the database error. */
export function uuidParam(value: string, what = "Resource"): string {
  if (!UUID_RE.test(value)) throw notFound(what);
  return value.toLowerCase();
}
