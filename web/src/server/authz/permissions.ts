import { forbidden } from "../http/errors";

export const ROLES = ["owner", "admin", "coach", "analyst", "scout", "player"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "org.manage"
  | "org.delete"
  | "members.manage"
  | "billing.manage"
  | "match.create"
  | "match.read"
  | "match.update"
  | "match.delete"
  | "video.upload"
  | "analysis.run"
  | "report.read"
  | "report.share";

const READ: Permission[] = ["match.read", "report.read"];
const ANALYST: Permission[] = [
  ...READ,
  "match.create",
  "match.update",
  "video.upload",
  "analysis.run",
  "report.share",
];

// The single source of truth for role capabilities. Least privilege: anything not listed is denied.
const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    ...ANALYST,
    "match.delete",
    "org.manage",
    "members.manage",
    "billing.manage",
    "org.delete",
  ]),
  admin: new Set<Permission>([...ANALYST, "match.delete", "org.manage", "members.manage", "billing.manage"]),
  coach: new Set<Permission>([...ANALYST, "match.delete"]),
  analyst: new Set<Permission>(ANALYST),
  scout: new Set<Permission>(READ),
  // TODO(phase 4): restrict players to matches of their own teams.
  player: new Set<Permission>(READ),
};

/** Who is acting, in which organization, with which role. Always built on the server. */
export type Actor = {
  userId: string;
  orgId: string;
  role: Role;
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false;
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) throw forbidden();
}
