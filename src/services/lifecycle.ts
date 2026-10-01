import type { Queryable } from "../db/index.js";
import { assertTransition } from "../domain/state-machine.js";
import { type CloseReason, type EventType, type LeaseState, toWireState } from "../domain/types.js";
import { audit, auditAndEmit } from "./audit.js";
import { enqueueJob } from "./jobs.js";
import type { LeaseRow } from "./rows.js";

/** Columns a transition may change besides state/version/updated_at. `undefined` = unchanged, `null` = clear. */
export interface LeasePatch {
  close_reason?: CloseReason | null;
  close_detail?: string | null;
  close_requested_at?: Date | null;
  issued_at?: Date | null;
  revoked_at?: Date | null;
  last_verified_at?: Date | null;
  next_retry_at?: Date | null;
}

const PATCH_COLUMNS: (keyof LeasePatch)[] = ["close_reason", "close_detail", "close_requested_at", "issued_at", "revoked_at", "last_verified_at", "next_retry_at"];

const EVENT_FOR_STATE: Partial<Record<LeaseState, EventType>> = {
  REQUESTED: "lease.requested",
  APPROVED: "lease.approved",
  ISSUING: "lease.issuing",
  ACTIVE: "lease.active",
  ISSUE_UNKNOWN: "lease.issue_unknown",
  REVOKING: "lease.revoking",
  REVOKED_VERIFIED: "lease.revoked_verified",
  REVOCATION_UNCONFIRMED: "lease.revocation_unconfirmed",
};
export const eventTypeForState = (state: LeaseState): EventType => EVENT_FOR_STATE[state] as EventType;

/** Lock a lease row (workspace-scoped when a workspace is given). Returns null when absent or foreign. */
export async function lockLease(tx: Queryable, id: string, workspaceId?: string): Promise<LeaseRow | null> {
  const result = workspaceId
    ? await tx.query<LeaseRow>("SELECT * FROM leases WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [id, workspaceId])
    : await tx.query<LeaseRow>("SELECT * FROM leases WHERE id = $1 FOR UPDATE", [id]);
  return result.rows[0] ?? null;
}

export interface TransitionOptions {
  at: Date;
  actorRef: string;
  action: string;
  patch?: LeasePatch;
  metadata?: Record<string, unknown>;
  /** Emit an outbox event for the new state (default true). A repeat of the same state (retry) passes false. */
  emit?: boolean;
}

/**
 * The single place a lease changes state. Validates the transition against the PRD state machine, bumps the version,
 * and writes the audit event and the outbox event in the same transaction. The database trigger enforces the
 * same table as a second line of defense.
 */
export async function transition(tx: Queryable, lease: LeaseRow, to: LeaseState, options: TransitionOptions): Promise<LeaseRow> {
  assertTransition(lease.state, to);
  const sets: string[] = ["state = $3", "version = version + 1", "updated_at = $4"];
  const params: unknown[] = [lease.id, lease.state, to, options.at];
  for (const column of PATCH_COLUMNS) {
    const value = options.patch?.[column];
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  const result = await tx.query<LeaseRow>(`UPDATE leases SET ${sets.join(", ")} WHERE id = $1 AND state = $2 RETURNING *`, params);
  const updated = result.rows[0];
  if (!updated) throw new Error(`lease ${lease.id} changed concurrently (expected ${lease.state})`);
  const auditInput = {
    workspaceId: lease.workspace_id,
    leaseId: lease.id,
    actorRef: options.actorRef,
    action: options.action,
    at: options.at,
    metadata: { from: toWireState(lease.state), to: toWireState(to), version: updated.version, ...options.metadata },
  };
  if (options.emit === false) await audit(tx, auditInput);
  else await auditAndEmit(tx, auditInput, { workspaceId: lease.workspace_id, leaseId: lease.id, type: eventTypeForState(to), at: options.at, revision: updated.version });
  return updated;
}

/**
 * Enter REVOKING (expiry, task closure, operator revocation, failure cleanup) and queue the revoke job in the same
 * transaction. Revocation is requested here; it is verified later by the revoke job (never by elapsed time).
 */
export async function startRevocation(
  tx: Queryable,
  lease: LeaseRow,
  o: { reason: CloseReason; detail?: string; at: Date; actorRef: string; action: string; metadata?: Record<string, unknown> },
): Promise<LeaseRow> {
  const updated = await transition(tx, lease, "REVOKING", {
    at: o.at,
    actorRef: o.actorRef,
    action: o.action,
    patch: { close_reason: o.reason, close_detail: o.detail ? o.detail.slice(0, 500) : null, close_requested_at: o.at, next_retry_at: null },
    metadata: { reason: o.reason, ...o.metadata },
  });
  await enqueueJob(tx, { workspaceId: lease.workspace_id, leaseId: lease.id, type: "revoke", at: o.at, dedupKey: `revoke:${lease.id}` });
  return updated;
}
