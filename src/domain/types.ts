/**
 * AccessLease domain types. FROZEN at M0 (contract owner: accesslease-backend).
 * Changes after M0 are announced to accesslease-surface and accesslease-qa.
 * Narrative contract: docs/contracts/api.md, docs/contracts/state-machine.md.
 */

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// States (PRD section 6: "State and uncertainty contract"). No other states exist.
// ---------------------------------------------------------------------------

export const LEASE_STATES = [
  "REQUESTED",
  "APPROVED",
  "ISSUING",
  "ACTIVE",
  "ISSUE_UNKNOWN",
  "REVOKING",
  "REVOKED_VERIFIED",
  "REVOCATION_UNCONFIRMED",
] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/** Wire (API, evidence, report, CLI JSON) spelling of the same states: lowercase, e.g. `issue_unknown`. Internal enums and the database use UPPER_SNAKE. */
export type WireLeaseState = Lowercase<LeaseState>;
export const WIRE_STATES = LEASE_STATES.map((s) => s.toLowerCase()) as WireLeaseState[];
export const toWireState = (state: LeaseState): WireLeaseState => state.toLowerCase() as WireLeaseState;

/** States in which a provider grant may exist (or may exist for all we know). */
export const GRANT_BEARING_STATES: readonly LeaseState[] = ["ISSUING", "ACTIVE", "ISSUE_UNKNOWN", "REVOKING", "REVOCATION_UNCONFIRMED"];

/** States that must be shown with a warning and never styled green or as success. */
export const UNRESOLVED_STATES: readonly LeaseState[] = ["ISSUE_UNKNOWN", "REVOCATION_UNCONFIRMED"];

/** Why a lease entered REVOKING. Expired time alone never means verified revocation. */
export const CLOSE_REASONS = ["expired", "task_closed", "operator_revoked", "issue_failed", "plan_mismatch", "approval_expired"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/** Derived, API-facing revocation status. `verified` is only ever the result of REVOKED_VERIFIED. */
export const REVOCATION_STATUSES = ["none", "pending", "verified", "unconfirmed"] as const;
export type RevocationStatus = (typeof REVOCATION_STATUSES)[number];

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDER_KINDS = ["synthetic", "postgres-role"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Result of one append-only revocation attempt row. Only `verified` is success. */
export const REVOCATION_RESULTS = ["verified", "unverified", "provider_error"] as const;
export type RevocationResult = (typeof REVOCATION_RESULTS)[number];

export const JOB_TYPES = ["issue", "reconcile", "revoke"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_STATES = ["queued", "running", "done", "dead"] as const;
export type JobState = (typeof JOB_STATES)[number];

// ---------------------------------------------------------------------------
// Limits and defaults (PRD AC-01, section 6 limits). Admin-configurable where noted.
// ---------------------------------------------------------------------------

export const DEFAULT_TTL_SECONDS = 3600;
export const DEFAULT_MAX_TTL_SECONDS = 8 * 3600;
export const DEFAULT_MIN_TTL_SECONDS = 60;
/** Absolute upper bound an admin may configure for the policy maximum (sanity ceiling, flagged to the coordinator). */
export const ABSOLUTE_MAX_TTL_SECONDS = 24 * 3600;
export const DEFAULT_APPROVAL_TTL_SECONDS = 15 * 60;
export const DEFAULT_RETENTION_DAYS = 90;
/** Revocation must be requested within this long after expiry or closure under healthy conditions (AC-04). */
export const REVOCATION_REQUEST_SLA_SECONDS = 30;
export const MAX_SCOPES_PER_LEASE = 20;
export const MAX_REF_LENGTH = 200;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const DEFAULT_IMPORT_METADATA_BYTES = 25 * 1024 * 1024;
export const DEFAULT_IMPORT_MAX_FILES = 1000;
export const MAX_IMPORT_BLOB_OVERRIDE_BYTES = 250 * 1024 * 1024;
export const LIST_MAX_LIMIT = 100;
export const IDEMPOTENCY_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Entities (as persisted, serialized form; all timestamps are UTC ISO-8601 strings with milliseconds)
// ---------------------------------------------------------------------------

export interface Policy {
  schema_version: typeof SCHEMA_VERSION;
  workspace_id: string;
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  min_ttl_seconds: number;
  approval_ttl_seconds: number;
  retention_days: number;
  /** Optional allow list (prefixes). Empty means: any scope that is valid for the provider and not denied. */
  scope_allow_prefixes: string[];
  scope_deny_prefixes: string[];
  version: number;
  /** SHA-256 over the canonical JSON of the policy rules (not of version/updated_at). Bound into plan_hash. */
  policy_hash: string;
  updated_at: string;
  updated_by: string | null;
}

export interface ProviderLabel {
  kind: ProviderKind;
  /** "SYNTHETIC" for the simulator, "LIVE_LOCAL_POSTGRES" for the real local PostgreSQL provider. */
  label: "SYNTHETIC" | "LIVE_LOCAL_POSTGRES";
  /** true only for connectors that talk to a real system. The synthetic provider is never live. */
  live: boolean;
}

export interface LeaseRequestInput {
  task_ref: string;
  subject_ref: string;
  resource_ref: string;
  scopes: string[];
  /** Absolute UTC instant. Omitted: now + policy default TTL. */
  expires_at?: string;
}

export interface LeaseView {
  id: string;
  workspace_id: string;
  task_ref: string;
  subject_ref: string;
  resource_ref: string;
  scopes: string[];
  expires_at: string;
  /** Lowercase wire value: requested, approved, issuing, active, issue_unknown, revoking, revoked_verified, revocation_unconfirmed. */
  state: WireLeaseState;
  /** Monotonic per lease; increments on every state change. Used as `revision` in events and for expected_version. */
  version: number;
  plan_hash: string;
  policy_hash: string;
  provider: ProviderLabel;
  approval: { actor_id: string | null; actor_ref: string; approved_at: string; expires_at: string } | null;
  issued_at: string | null;
  revoked_at: string | null;
  /** Last independent verification (introspection and/or denied-use probe) that succeeded. */
  last_verified_at: string | null;
  revocation_status: RevocationStatus;
  /** Set while REVOCATION_UNCONFIRMED (and ISSUE_UNKNOWN reconciliation): when the next automatic retry runs. */
  next_retry_at: string | null;
  close_reason: CloseReason | null;
  /** Human-readable warning for unresolved states; null otherwise. Never a "green" message. */
  warning: string | null;
  credential_available: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRecord {
  id: string;
  lease_id: string;
  actor_id: string | null;
  actor_ref: string;
  plan_hash: string;
  approved_at: string;
  expires_at: string;
}

export interface ProviderGrantRecord {
  id: string;
  lease_id: string;
  provider_kind: ProviderKind;
  provider_ref: string;
  label: ProviderLabel["label"];
  issued_at: string | null;
  valid_until: string | null;
  revoked_at: string | null;
  status: "pending" | "issued" | "revoked";
}

export interface RevocationAttemptRecord {
  id: string;
  lease_id: string;
  attempt_no: number;
  attempted_at: string;
  result: RevocationResult;
  /** Reference to the verification evidence, e.g. "introspection+probe:denied". Empty when none was possible. */
  verification_ref: string;
  /** Redacted details: steps taken, introspection summary, probe outcome, error code. */
  detail: Record<string, unknown>;
  next_retry_at: string | null;
}

export interface AuditEventRecord {
  id: string;
  seq: number;
  lease_id: string | null;
  actor_ref: string;
  action: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export interface LeaseDetail extends LeaseView {
  provider_grant: ProviderGrantRecord | null;
  attempts: RevocationAttemptRecord[];
  audit: AuditEventRecord[];
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null at the end. */
  next_cursor: string | null;
}

/** One-time credential delivery. Returned once by POST /leases/{id}/credential; never in a URL, log or event. */
export interface CredentialDelivery {
  lease_id: string;
  provider: ProviderLabel;
  expires_at: string;
  /** Connection facts for the grantee. `secret` is the only secret field. */
  credential: {
    kind: ProviderKind;
    host: string;
    port: number;
    database: string;
    username: string;
    secret: string;
  };
  delivered_at: string;
}

// ---------------------------------------------------------------------------
// Events (PRD "Ecosystem adapter boundary"): versioned envelope, at-least-once pull.
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "lease.requested",
  "lease.approved",
  "lease.issuing",
  "lease.active",
  "lease.issue_unknown",
  "lease.revoking",
  "lease.revoked_verified",
  "lease.revocation_unconfirmed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope {
  schema_version: 1;
  event_id: string;
  source: "accesslease";
  resource_id: string;
  event_type: EventType;
  occurred_at: string;
  revision: number;
  evidence_ref: string;
  correlation_id?: string;
}

// ---------------------------------------------------------------------------
// Evidence bundle (AC-10)
// ---------------------------------------------------------------------------

export const BUNDLE_KIND = "accesslease.evidence-bundle" as const;
export const BUNDLE_SCHEMA_VERSION = 1 as const;

export interface BundleFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  files: BundleFileEntry[];
  file_count: number;
  total_bytes: number;
  /** SHA-256 over the canonical JSON of `files`. */
  manifest_hash: string;
}

export interface EvidenceBundle {
  schema_version: typeof BUNDLE_SCHEMA_VERSION;
  kind: typeof BUNDLE_KIND;
  exported_at: string;
  generator: { name: "accesslease"; version: string };
  source: { workspace_id: string; workspace_name: string; provider_labels: ProviderLabel[] };
  manifest: BundleManifest;
  /** path -> JSON document. Each document is hashed (canonical JSON) into the manifest. */
  files: Record<string, unknown>;
  /** SHA-256 over the canonical JSON of the bundle without this field. */
  bundle_hash: string;
}

export const BUNDLE_ERROR_CODES = [
  "bundle_too_large",
  "bundle_truncated",
  "bundle_malformed",
  "bundle_unsupported_version",
  "bundle_hash_mismatch",
  "bundle_manifest_mismatch",
  "bundle_unsafe_path",
  "bundle_too_many_files",
  "bundle_schema_invalid",
  "bundle_reference_broken",
] as const;
export type BundleErrorCode = (typeof BUNDLE_ERROR_CODES)[number];

export interface BundleVerification {
  ok: boolean;
  /** Stable machine-readable failure code, null when ok. */
  code: BundleErrorCode | null;
  message: string | null;
  bundle_hash: string | null;
  schema_version: number | null;
  file_count: number;
  lease_count: number;
}

export interface ImportReceipt {
  import_id: string;
  bundle_hash: string;
  already_imported: boolean;
  lease_count: number;
  imported_at: string;
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

export interface Principal {
  /** Stable audit identity: "user:<uuid>" for sessions, "cli:local" for the local operator CLI, "system:worker" for the worker. */
  actorRef: string;
  userId: string | null;
  email: string | null;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Error codes (HTTP status as value). Body: {error:{code,message,request_id}}.
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  malformed_json: 400,
  bad_request: 400,
  invalid_cookie: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  forbidden: 403,
  csrf_invalid: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  stale_plan: 409,
  plan_hash_mismatch: 409,
  approval_expired: 409,
  version_conflict: 409,
  credential_already_retrieved: 409,
  credential_unavailable: 409,
  already_member: 409,
  payload_too_large: 413,
  bundle_too_large: 413,
  invalid_body: 422,
  validation_failed: 422,
  invalid_scope: 422,
  scope_forbidden: 422,
  scope_wildcard: 422,
  ttl_exceeds_max: 422,
  ttl_below_min: 422,
  expires_in_past: 422,
  policy_invalid: 422,
  bundle_invalid: 422,
  bundle_truncated: 422,
  bundle_malformed: 422,
  bundle_unsupported_version: 422,
  bundle_hash_mismatch: 422,
  bundle_manifest_mismatch: 422,
  bundle_unsafe_path: 422,
  bundle_too_many_files: 422,
  bundle_schema_invalid: 422,
  bundle_reference_broken: 422,
  rate_limited: 429,
  provider_no_native_ttl: 422,
  provider_unavailable: 503,
  not_ready: 503,
  internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
