import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { env } from "../env";
import { log } from "../log";
import { resolveActor, type UserRow } from "../orgs/service";
import { AppError, invalidInput, payloadTooLarge, uuidParam } from "./errors";

const DEFAULT_MAX_BODY = 32 * 1024;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Handler<P, B> = (args: {
  req: NextRequest;
  params: P;
  body: B;
  user: UserRow;
  requestId: string;
}) => Promise<unknown>;

/** The caller's Actor in the organization named by a path parameter (404 for non-members). */
export function actorFor(user: UserRow, orgIdParam: string) {
  return resolveActor(getDb(), user.id, uuidParam(orgIdParam, "Workspace"));
}

type Options<S extends ZodType | undefined> = {
  body?: S;
  maxBodyBytes?: number;
  /** HTTP status for a successful response. */
  status?: number;
};

function errorResponse(err: unknown, requestId: string) {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details }, requestId },
      { status: err.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (err instanceof ZodError) {
    // Field paths and messages only; never echo received values.
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json(
      { error: { code: "invalid_input", message: "The request is invalid.", details }, requestId },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  log.error({ err, requestId }, "unhandled API error");
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong. Please try again." }, requestId },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the browser-supplied Origin
 * must be our own, and the body must be JSON (which cross-site forms cannot send without a
 * CORS preflight that we never approve).
 */
function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(env().APP_ORIGIN).origin) {
    throw new AppError(403, "bad_origin", "Cross-origin request refused.");
  }
}

async function readJson(req: NextRequest, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw payloadTooLarge("Request body is too large.");
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw invalidInput("Expected a JSON body.");
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw payloadTooLarge("Request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw invalidInput("Malformed JSON.");
  }
}

/**
 * Wraps an authenticated route handler. Order matters: origin check, then authentication, then
 * body parsing and validation, so anonymous callers learn nothing about the API's input rules.
 */
export function route<P, S extends ZodType | undefined = undefined>(
  options: Options<S>,
  handler: Handler<P, S extends ZodType ? z.infer<S> : undefined>,
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    const requestId = randomUUID();
    try {
      if (!SAFE_METHODS.has(req.method)) assertSameOrigin(req);
      const user = await requireUser();
      const params = await ctx.params;
      const body = options.body
        ? options.body.parse(await readJson(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY))
        : undefined;
      const result = await handler({ req, params, body: body as never, user, requestId });
      if (result === undefined) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      return NextResponse.json(result, { status: options.status ?? 200, headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
