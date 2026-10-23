import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import type { Actor, Role } from "../src/server/authz/permissions";
import { createDb } from "../src/server/db/client";
import { calibrations, memberships, organizations, users } from "../src/server/db/schema";

export function testDb() {
  const { db, pool } = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => pool.end());
  return db;
}

type Db = ReturnType<typeof testDb>;

export async function makeUser(db: Db, name = "user") {
  const [user] = await db
    .insert(users)
    .values({ authSubject: `test_${randomUUID()}`, displayName: name })
    .returning();
  return user;
}

export async function makeOrg(db: Db, name = "Club") {
  const [org] = await db
    .insert(organizations)
    .values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, kind: "club" })
    .returning();
  return org;
}

/** A user who is a member of a fresh organization with the given role. */
export async function makeActor(db: Db, role: Role = "owner", orgId?: string): Promise<Actor> {
  const user = await makeUser(db, role);
  const org = orgId ?? (await makeOrg(db)).id;
  await db.insert(memberships).values({ orgId: org, userId: user.id, role });
  return { userId: user.id, orgId: org, role };
}

/** Inserts a minimal valid calibration so analysis can be queued (identity-like mapping). */
export async function calibrate(db: Db, actor: Actor, matchId: string, videoId: string) {
  await db.insert(calibrations).values({
    orgId: actor.orgId,
    matchId,
    videoId,
    points: [],
    homography: { matrix: [0.05, 0, 0, 0, 0.05, 0, 0, 0, 1], pitch: { length: 105, width: 68 } },
    imageWidth: 1920,
    imageHeight: 1080,
    rmsErrorM: 0.3,
    looErrorM: 0.5,
    createdBy: actor.userId,
  });
}
