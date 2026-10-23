import { describe, expect, it } from "vitest";
import { deriveMatchStatus } from "./service";

describe("deriveMatchStatus", () => {
  it("follows the upload → check → calibrate → analyse lifecycle", () => {
    expect(deriveMatchStatus(undefined, undefined, undefined, false)).toBe("awaiting_upload");
    expect(deriveMatchStatus({ status: "uploading" }, undefined, undefined, false)).toBe("uploading");
    expect(deriveMatchStatus({ status: "uploaded" }, { status: "queued" }, undefined, false)).toBe("checking");
    expect(deriveMatchStatus({ status: "uploaded" }, { status: "running" }, undefined, false)).toBe("checking");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, undefined, false)).toBe("needs_calibration");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, undefined, true)).toBe("ready");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, { status: "queued" }, true)).toBe("queued");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, { status: "running" }, true)).toBe("processing");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, { status: "succeeded" }, true)).toBe("analyzed");
  });

  it("surfaces rejections and failures", () => {
    expect(deriveMatchStatus({ status: "rejected" }, { status: "failed" }, undefined, false)).toBe("upload_rejected");
    expect(deriveMatchStatus({ status: "uploaded" }, { status: "failed" }, undefined, false)).toBe("failed");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, { status: "failed" }, true)).toBe("failed");
    expect(deriveMatchStatus({ status: "validated" }, { status: "succeeded" }, { status: "cancelled" }, true)).toBe("cancelled");
  });

  it("treats aborted or purged footage as needing a new upload, but keeps finished analyses", () => {
    expect(deriveMatchStatus({ status: "aborted" }, undefined, undefined, false)).toBe("awaiting_upload");
    expect(deriveMatchStatus({ status: "purged" }, { status: "succeeded" }, undefined, true)).toBe("awaiting_upload");
    expect(deriveMatchStatus({ status: "purged" }, { status: "succeeded" }, { status: "succeeded" }, true)).toBe("analyzed");
  });
});
