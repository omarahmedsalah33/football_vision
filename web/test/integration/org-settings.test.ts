import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organizations, videos } from "../../src/server/db/schema";
import { createMatch } from "../../src/server/matches/service";
import { auditLog, deleteOrg, renameOrg, usageSummary } from "../../src/server/orgs/settings";
import { resolveActor } from "../../src/server/orgs/service";
import { makeActor, testDb } from "../helpers";

const db = testDb();
const FORBIDDEN = expect.objectContaining({ status: 403 });

describe("workspace settings", () => {
  it("owners and admins rename; coaches can't; renames are audited", async () => {
    const owner = await makeActor(db, "owner");
    const admin = await makeActor(db, "admin", owner.orgId);
    const coach = await makeActor(db, "coach", owner.orgId);
    await renameOrg(db, admin, { name: "Nile Stars FC" });
    await expect(renameOrg(db, coach, { name: "Hijack" })).rejects.toThrowError(FORBIDDEN);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, owner.orgId));
    expect(org.name).toBe("Nile Stars FC");
    expect((await auditLog(db, owner)).map((e) => e.action)).toContain("org.renamed");
    await expect(auditLog(db, coach)).rejects.toThrowError(FORBIDDEN);
  });

  it("only owners delete, only club workspaces, only with the exact name", async () => {
    const owner = await makeActor(db, "owner");
    const admin = await makeActor(db, "admin", owner.orgId);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, owner.orgId));

    await expect(deleteOrg(db, admin, { confirmName: org.name })).rejects.toThrowError(FORBIDDEN);
    await expect(deleteOrg(db, owner, { confirmName: "wrong" })).rejects.toMatchObject({ status: 422 });
    await deleteOrg(db, owner, { confirmName: org.name });
    await expect(resolveActor(db, owner.userId, owner.orgId)).rejects.toMatchObject({ status: 404 });

    const personal = await makeActor(db, "owner");
    await db.update(organizations).set({ kind: "personal" }).where(eq(organizations.id, personal.orgId));
    const [p] = await db.select().from(organizations).where(eq(organizations.id, personal.orgId));
    await expect(deleteOrg(db, personal, { confirmName: p.name })).rejects.toMatchObject({ status: 409 });
  });

  it("usage summary reports plan limits, analyses and stored footage", async () => {
    const owner = await makeActor(db, "owner");
    const match = await createMatch(db, owner, { title: "Usage" });
    await db.insert(videos).values({
      orgId: owner.orgId,
      matchId: match.id,
      storageKey: `t/${match.id}`,
      declaredSizeBytes: 5_000,
      sizeBytes: 5_000,
      partSizeBytes: 5_000,
      partCount: 1,
      status: "validated",
    });
    const s = await usageSummary(db, owner);
    expect(s).toMatchObject({
      planId: "free",
      analyses: { used: 0, inProgress: 0, limit: 1 },
      storage: { bytes: 5_000, videos: 1 },
      members: { count: 1, limit: 3 },
    });
    const coach = await makeActor(db, "coach", owner.orgId);
    await expect(usageSummary(db, coach)).rejects.toThrowError(FORBIDDEN);
  });
});
