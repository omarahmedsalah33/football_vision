import { describe, expect, it } from "vitest";
import {
  checkDeclaredFile,
  MAX_PARTS,
  MIN_PART_BYTES,
  partLength,
  planParts,
  sanitizeFilename,
  sniffContainer,
} from "./validation";

describe("checkDeclaredFile", () => {
  it.each([
    ["match.mp4", "video/mp4"],
    ["MATCH.MOV", "video/quicktime"],
    ["a.mkv", "video/x-matroska"],
    ["a.mkv", ""],
    ["a.webm", "video/webm"],
  ])("accepts %s (%s)", (name, type) => expect(checkDeclaredFile(name, type)).toBeNull());

  it.each([
    ["payload.exe", "video/mp4"],
    ["match.mp4.exe", "video/mp4"],
    ["noextension", "video/mp4"],
    ["clip.gif", "image/gif"],
    ["match.mp4", "text/html"],
    ["match.mp4", ""],
  ])("rejects %s (%s)", (name, type) => expect(checkDeclaredFile(name, type)).not.toBeNull());
});

describe("sanitizeFilename", () => {
  it("strips paths and control characters", () => {
    expect(sanitizeFilename("../../etc/passwd\u0000.mp4")).toBe("passwd.mp4");
    expect(sanitizeFilename(String.raw`C:\Users\x\<script>.mp4`)).toBe("script.mp4");
    expect(sanitizeFilename("a".repeat(300) + ".mp4")).toHaveLength(120);
    expect(sanitizeFilename("///")).toBe("video");
  });
});

describe("planParts", () => {
  it.each([1, MIN_PART_BYTES, MIN_PART_BYTES + 1, 6 * 1024 ** 3, 500 * 1024 ** 3])("covers %d bytes exactly", (size) => {
    const { partSize, partCount } = planParts(size);
    expect(partCount).toBeLessThanOrEqual(MAX_PARTS);
    expect(partSize).toBeGreaterThanOrEqual(MIN_PART_BYTES);
    const total = Array.from({ length: partCount }, (_, i) => partLength(size, partSize, partCount, i + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(size);
    expect(partLength(size, partSize, partCount, partCount)).toBeGreaterThan(0);
  });
});

describe("sniffContainer", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it("recognizes MP4/MOV and Matroska/WebM headers", () => {
    expect(sniffContainer(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70))).toBe("isobmff");
    expect(sniffContainer(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0))).toBe("matroska");
  });
  it("rejects other content", () => {
    expect(sniffContainer(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffContainer(bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0))).toBeNull(); // Windows executable
    expect(sniffContainer(bytes())).toBeNull();
  });
});
