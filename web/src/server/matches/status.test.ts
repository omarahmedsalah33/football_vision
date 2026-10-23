import { describe, expect, it } from "vitest";
import { deriveMatchStatus } from "./service";

describe("deriveMatchStatus", () => {
  it("prefers the latest job over the video", () => {
    expect(deriveMatchStatus({ status: "uploaded" }, { status: "running" })).toBe("processing");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" })).toBe("analyzed");
    expect(deriveMatchStatus({ status: "rejected" }, { status: "failed" })).toBe("failed");
  });
  it("falls back to the video state", () => {
    expect(deriveMatchStatus(undefined, undefined)).toBe("awaiting_upload");
    expect(deriveMatchStatus({ status: "aborted" }, undefined)).toBe("awaiting_upload");
    expect(deriveMatchStatus({ status: "uploading" }, undefined)).toBe("uploading");
    expect(deriveMatchStatus({ status: "rejected" }, undefined)).toBe("upload_rejected");
    expect(deriveMatchStatus({ status: "uploaded" }, undefined)).toBe("ready");
  });
});
