import type { DbOrTx } from "./db/client";
import { auditEvents } from "./db/schema";

export type AuditAction =
  | "org.created"
  | "org.renamed"
  | "org.deleted"
  | "member.invited"
  | "member.invitation_revoked"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "member.left"
  | "match.deleted"
  | "player.created"
  | "player.updated"
  | "player.archived"
  | "billing.plan_changed"
  | "account.deleted";

/**
 * Records a security-relevant action. Call inside the same transaction as the change, so the log
 * and the change commit together. Metadata must not contain secrets or tokens.
 */
export async function recordAudit(
  db: DbOrTx,
  event: {
    orgId: string | null;
    actorUserId: string | null;
    action: AuditAction;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(auditEvents).values({
    orgId: event.orgId,
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? {},
  });
}
