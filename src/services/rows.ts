import { labelForKind } from "../domain/scopes.js";
import { revocationStatusFor, warningFor } from "../domain/state-machine.js";
import { type CloseReason, type LeaseState, type LeaseView, type ProviderKind, type ProviderLabel, toWireState } from "../domain/types.js";

/** Database row of `leases` as returned by node-postgres (timestamptz -> Date, jsonb -> parsed). */
export interface LeaseRow {
  id: string;
  workspace_id: string;
  task_ref: string;
  subject_ref: string;
  resource_ref: string;
  scopes: string[];
  expires_at: Date;
  policy_hash: string;
  plan_hash: string;
  state: LeaseState;
  version: number;
  provider_kind: ProviderKind;
  requested_by_ref: string;
  close_reason: CloseReason | null;
  close_detail: string | null;
  close_requested_at: Date | null;
  issued_at: Date | null;
  revoked_at: Date | null;
  last_verified_at: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalRow {
  id: string;
  workspace_id: string;
  lease_id: string;
  actor_id: string | null;
  actor_ref: string;
  plan_hash: string;
  approved_at: Date;
  expires_at: Date;
}

export interface GrantRow {
  id: string;
  workspace_id: string;
  lease_id: string;
  provider_kind: ProviderKind;
  provider_ref: string;
  status: "pending" | "issued" | "revoked";
  issued_at: Date | null;
  valid_until: Date | null;
  revoked_at: Date | null;
  conn_host: string | null;
  conn_port: number | null;
  conn_database: string | null;
  conn_username: string | null;
  created_at: Date;
}

export const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);
export const isoRequired = (date: Date): string => date.toISOString();

export function providerLabel(kind: ProviderKind): ProviderLabel {
  return labelForKind(kind);
}

export function toLeaseView(row: LeaseRow, extra: { approval: ApprovalRow | null; credentialAvailable: boolean }): LeaseView {
  const approval = extra.approval;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    task_ref: row.task_ref,
    subject_ref: row.subject_ref,
    resource_ref: row.resource_ref,
    scopes: row.scopes,
    expires_at: isoRequired(row.expires_at),
    state: toWireState(row.state),
    version: row.version,
    plan_hash: row.plan_hash,
    policy_hash: row.policy_hash,
    provider: providerLabel(row.provider_kind),
    approval: approval
      ? { actor_id: approval.actor_id, actor_ref: approval.actor_ref, approved_at: isoRequired(approval.approved_at), expires_at: isoRequired(approval.expires_at) }
      : null,
    issued_at: iso(row.issued_at),
    revoked_at: iso(row.revoked_at),
    last_verified_at: iso(row.last_verified_at),
    revocation_status: revocationStatusFor(row.state),
    next_retry_at: iso(row.next_retry_at),
    close_reason: row.close_reason,
    warning: warningFor(row.state, row.close_reason, row.next_retry_at),
    credential_available: extra.credentialAvailable,
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}
