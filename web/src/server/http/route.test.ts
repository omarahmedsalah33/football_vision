import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { unauthenticated } from "./errors";

const requireUser = vi.fn();
vi.mock("../auth/session", () => ({ requireUser: () => requireUser() }));

const { route } = await import("./route");

const ORIGIN = process.env.APP_ORIGIN!;
const ctx = { params: Promise.resolve({}) };
const handler = vi.fn(async () => ({ ok: true }));
const post = route({ body: z.object({ name: z.string().min(2) }), maxBodyBytes: 200 }, handler);

function req(init: { origin?: string | null; body?: string; type?: string; method?: string } = {}) {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("content-type", init.type ?? "application/json");
  const method = init.method ?? "POST";
  const body = method === "GET" ? undefined : (init.body ?? '{"name":"ok"}');
  return new NextRequest(`${ORIGIN}/api/test`, { method, headers, body });
}

beforeEach(() => {
  handler.mockClear();
  requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "user-1" });
});

describe("route wrapper", () => {
  it("rejects cross-origin and origin-less state changes before doing anything else", async () => {
    for (const origin of ["https://evil.example", null]) {
      const res = await post(req({ origin }), ctx);
      expect(res.status).toBe(403);
    }
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("authenticates before validating, so anonymous callers learn nothing about inputs", async () => {
    requireUser.mockRejectedValue(unauthenticated());
    const res = await post(req({ body: '{"name":"x"}' }), ctx);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/name|details/);
  });

  it("validates input and reports field paths without echoing values", async () => {
    const res = await post(req({ body: '{"name":"z"}' }), ctx);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.details[0].path).toBe("name");
    expect(JSON.stringify(json)).not.toContain('"z"');
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses non-JSON bodies, malformed JSON and oversized bodies", async () => {
    expect((await post(req({ type: "application/x-www-form-urlencoded", body: "name=ok" }), ctx)).status).toBe(422);
    expect((await post(req({ body: "{not json" }), ctx)).status).toBe(422);
    expect((await post(req({ body: JSON.stringify({ name: "a".repeat(500) }) }), ctx)).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const failing = route({}, async () => {
      throw new Error("connection to db-internal.example:5432 refused, password=hunter2");
    });
    const res = await failing(req({ method: "GET", body: undefined }), ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/hunter2|db-internal|refused/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("passes the authenticated user and parsed body to the handler", async () => {
    const res = await post(req(), ctx);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ user: { id: "user-1" }, body: { name: "ok" } }));
  });
});
