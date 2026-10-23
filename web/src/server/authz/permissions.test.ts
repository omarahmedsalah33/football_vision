import { describe, expect, it } from "vitest";
import { assertCan, can, ROLES, type Permission, type Role } from "./permissions";

const ALLOWED: Record<Role, Permission[]> = {
  owner: ["org.delete", "billing.manage", "members.manage", "match.delete", "video.upload", "match.read"],
  admin: ["billing.manage", "members.manage", "match.delete", "video.upload", "match.read"],
  coach: ["match.create", "video.upload", "analysis.run", "match.delete", "report.share"],
  analyst: ["match.create", "video.upload", "analysis.run", "report.share"],
  scout: ["match.read", "report.read"],
  player: ["match.read", "report.read"],
};

const DENIED: Record<Role, Permission[]> = {
  owner: [],
  admin: ["org.delete"],
  coach: ["org.manage", "members.manage", "billing.manage", "org.delete"],
  analyst: ["match.delete", "members.manage", "billing.manage", "org.delete"],
  scout: ["match.create", "video.upload", "analysis.run", "match.delete", "report.share", "billing.manage"],
  player: ["match.create", "video.upload", "analysis.run", "match.delete", "report.share", "members.manage"],
};

describe("permission matrix", () => {
  for (const role of ROLES) {
    it(`${role}: grants expected permissions`, () => {
      for (const p of ALLOWED[role]) expect(can(role, p), `${role} ${p}`).toBe(true);
    });
    it(`${role}: denies everything outside its role`, () => {
      for (const p of DENIED[role]) expect(can(role, p), `${role} ${p}`).toBe(false);
    });
  }

  it("denies unknown roles (e.g. tampered data)", () => {
    expect(can("superuser" as Role, "match.read")).toBe(false);
  });

  it("assertCan throws a 403 AppError", () => {
    expect(() => assertCan({ userId: "u", orgId: "o", role: "scout" }, "video.upload")).toThrowError(
      expect.objectContaining({ status: 403, code: "forbidden" }),
    );
  });
});
