import { newId } from "../lib/ids.js";
import type { Queryable } from "../db/index.js";
import type { EventType } from "../domain/types.js";
import { auditMetadata } from "../lib/redact.js";

interface AuditInput {
  workspaceId: string;
  leaseId: string | null;
  actorRef: string;
  action: string;
  at: Date;
  metadata?: Record<string, unknown>;
}

/** Append an audit event. Metadata is allow-listed to scalars and redacted before storage (AC-09). */
export async function audit(tx: Queryable, event: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (id, workspace_id, lease_id, actor_ref, action, occurred_at, redacted_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId(), event.workspaceId, event.leaseId, event.actorRef, event.action, event.at, JSON.stringify(auditMetadata(event.metadata))],
  );
}

interface EventInput {
  workspaceId: string;
  leaseId: string;
  type: EventType;
  at: Date;
  revision: number;
  correlationId?: string;
}

/**
 * Transactional outbox: insert the event in the same transaction as the state change. The per-workspace
 * sequence is bumped on the workspace row, so the pull cursor is monotonic in commit order.
 */
export async function emitEvent(tx: Queryable, event: EventInput): Promise<void> {
  await auditAndEmit(tx, undefined, event);
}

/**
 * One statement for the audit row and the outbox event of a state change (fewer round trips on the hot path). With no audit
 * input only the event is written.
 */
export async function auditAndEmit(tx: Queryable, auditInput: AuditInput | undefined, event: EventInput): Promise<void> {
  const params: unknown[] = [
    event.workspaceId,
    newId(),
    event.leaseId,
    event.type,
    event.at,
    event.revision,
    `lease:${event.leaseId}@${event.revision}`,
    event.correlationId ?? null,
  ];
  let auditCte = "";
  if (auditInput) {
    params.push(newId(), auditInput.actorRef, auditInput.action, JSON.stringify(auditMetadata(auditInput.metadata)));
    // The composite foreign key on the lease guarantees the workspace row exists, so the bump always yields a row.
    auditCte = `, aud AS (
      INSERT INTO audit_events (id, workspace_id, lease_id, actor_ref, action, occurred_at, redacted_metadata)
      VALUES ($9, $1, $3, $10, $11, $5, $12))`;
  }
  await tx.query(
    `WITH bump AS (UPDATE workspaces SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq)${auditCte}
     INSERT INTO events (workspace_id, seq, event_id, lease_id, event_type, occurred_at, revision, evidence_ref, correlation_id, schema_version)
     SELECT $1, bump.event_seq, $2, $3, $4, $5, $6, $7, $8, 1 FROM bump`,
    params,
  );
}
