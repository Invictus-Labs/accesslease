import { z } from "zod";
import {
  BUNDLE_ERROR_CODES,
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  CLOSE_REASONS,
  EVENT_TYPES,
  WIRE_STATES,
  LIST_MAX_LIMIT,
  MAX_REF_LENGTH,
  MAX_SCOPES_PER_LEASE,
  PROVIDER_KINDS,
  REVOCATION_RESULTS,
  REVOCATION_STATUSES,
  ROLES,
} from "./types.js";

/**
 * Request/response schemas. These zod schemas are the source of truth: `schemas/*.json` are generated from them
 * (see src/lib/schema-files.ts) and a unit test fails when the committed JSON drifts.
 * All request objects are strict: unknown members are a 422, never ignored.
 */

const uuid = z.uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");
/** UTC ISO-8601 instant, `Z` suffix required (offsets are rejected). */
export const utcInstant = z.iso.datetime();
// PostgreSQL text cannot hold NUL; refuse it at the boundary instead of failing deep inside a write.
const ref = z
  .string()
  .min(1)
  .max(MAX_REF_LENGTH)
  .refine((s) => !s.includes("\u0000"), "must not contain NUL characters");
const nullableInstant = utcInstant.nullable();

// ---- requests -------------------------------------------------------------

export const LeaseRequestSchema = z
  .object({
    task_ref: ref,
    subject_ref: ref,
    resource_ref: ref,
    scopes: z.array(z.string().min(1).max(MAX_REF_LENGTH)).min(1).max(MAX_SCOPES_PER_LEASE),
    expires_at: utcInstant.optional(),
  })
  .strict();

export const ApproveRequestSchema = z.object({ plan_hash: sha256, expected_version: z.int().min(1).optional() }).strict();
export const RevokeRequestSchema = z.object({ reason: z.string().min(1).max(500), expected_version: z.int().min(1).optional() }).strict();
export const CloseRequestSchema = z.object({ reason: z.string().min(1).max(500).optional(), expected_version: z.int().min(1).optional() }).strict();
export const LoginRequestSchema = z
  .object({ email: z.string().min(3).max(320), password: z.string().min(1).max(4096), workspace_id: uuid.optional() })
  .strict();

export const PolicyUpdateSchema = z
  .object({
    default_ttl_seconds: z.int().min(1).optional(),
    max_ttl_seconds: z.int().min(1).optional(),
    min_ttl_seconds: z.int().min(1).optional(),
    approval_ttl_seconds: z.int().min(1).optional(),
    retention_days: z.int().min(1).max(3650).optional(),
    scope_allow_prefixes: z.array(z.string().min(1).max(MAX_REF_LENGTH)).max(100).optional(),
    scope_deny_prefixes: z.array(z.string().min(1).max(MAX_REF_LENGTH)).max(100).optional(),
    expected_version: z.int().min(1).optional(),
  })
  .strict();

export const ListQuerySchema = z
  .object({
    state: z.enum(WIRE_STATES).optional(),
    cursor: z.string().max(200).optional(),
    // Larger values are clamped to LIST_MAX_LIMIT (100) by the service ("lists cap at 100").
    limit: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const EventsQuerySchema = z
  .object({ after: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).optional() })
  .strict();

// ---- responses ------------------------------------------------------------

export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), request_id: z.string() }) });

export const ProviderLabelSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  label: z.enum(["SYNTHETIC", "LIVE_LOCAL_POSTGRES"]),
  live: z.boolean(),
});

export const LeaseViewSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  task_ref: z.string(),
  subject_ref: z.string(),
  resource_ref: z.string(),
  scopes: z.array(z.string()),
  expires_at: utcInstant,
  state: z.enum(WIRE_STATES),
  version: z.int().min(1),
  plan_hash: sha256,
  policy_hash: sha256,
  provider: ProviderLabelSchema,
  approval: z
    .object({ actor_id: uuid.nullable(), actor_ref: z.string(), approved_at: utcInstant, expires_at: utcInstant })
    .nullable(),
  issued_at: nullableInstant,
  revoked_at: nullableInstant,
  last_verified_at: nullableInstant,
  revocation_status: z.enum(REVOCATION_STATUSES),
  next_retry_at: nullableInstant,
  close_reason: z.enum(CLOSE_REASONS).nullable(),
  warning: z.string().nullable(),
  credential_available: z.boolean(),
  created_at: utcInstant,
  updated_at: utcInstant,
});

export const ProviderGrantSchema = z.object({
  id: uuid,
  lease_id: uuid,
  provider_kind: z.enum(PROVIDER_KINDS),
  provider_ref: z.string(),
  label: z.enum(["SYNTHETIC", "LIVE_LOCAL_POSTGRES"]),
  issued_at: nullableInstant,
  valid_until: nullableInstant,
  revoked_at: nullableInstant,
  status: z.enum(["pending", "issued", "revoked"]),
});

export const RevocationAttemptSchema = z.object({
  id: uuid,
  lease_id: uuid,
  attempt_no: z.int().min(1),
  attempted_at: utcInstant,
  result: z.enum(REVOCATION_RESULTS),
  verification_ref: z.string(),
  detail: z.record(z.string(), z.unknown()),
  next_retry_at: nullableInstant,
});

export const AuditEventSchema = z.object({
  id: uuid,
  seq: z.int().min(1),
  lease_id: uuid.nullable(),
  actor_ref: z.string(),
  action: z.string(),
  occurred_at: utcInstant,
  metadata: z.record(z.string(), z.unknown()),
});

export const LeaseDetailSchema = LeaseViewSchema.extend({
  provider_grant: ProviderGrantSchema.nullable(),
  attempts: z.array(RevocationAttemptSchema),
  audit: z.array(AuditEventSchema),
});

export const LeasePageSchema = z.object({ items: z.array(LeaseViewSchema), next_cursor: z.string().nullable() });

export const CredentialDeliverySchema = z.object({
  lease_id: uuid,
  provider: ProviderLabelSchema,
  expires_at: utcInstant,
  credential: z.object({
    kind: z.enum(PROVIDER_KINDS),
    host: z.string(),
    port: z.int(),
    database: z.string(),
    username: z.string(),
    secret: z.string(),
  }),
  delivered_at: utcInstant,
});

export const PolicySchema = z.object({
  schema_version: z.literal(1),
  workspace_id: uuid,
  default_ttl_seconds: z.int(),
  max_ttl_seconds: z.int(),
  min_ttl_seconds: z.int(),
  approval_ttl_seconds: z.int(),
  retention_days: z.int(),
  scope_allow_prefixes: z.array(z.string()),
  scope_deny_prefixes: z.array(z.string()),
  version: z.int().min(1),
  policy_hash: sha256,
  updated_at: utcInstant,
  updated_by: uuid.nullable(),
});

export const EventEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  event_id: uuid,
  source: z.literal("accesslease"),
  resource_id: uuid,
  event_type: z.enum(EVENT_TYPES),
  occurred_at: utcInstant,
  revision: z.int().min(1),
  evidence_ref: z.string(),
  correlation_id: z.string().optional(),
});

export const EventPageSchema = z.object({ items: z.array(EventEnvelopeSchema), next_cursor: z.string() });

export const BundleFileEntrySchema = z.object({ path: z.string(), sha256, bytes: z.int().min(0) });

export const EvidenceBundleSchema = z.object({
  schema_version: z.literal(BUNDLE_SCHEMA_VERSION),
  kind: z.literal(BUNDLE_KIND),
  exported_at: utcInstant,
  generator: z.object({ name: z.literal("accesslease"), version: z.string() }),
  source: z.object({ workspace_id: uuid, workspace_name: z.string(), provider_labels: z.array(ProviderLabelSchema) }),
  manifest: z.object({
    files: z.array(BundleFileEntrySchema),
    file_count: z.int().min(0),
    total_bytes: z.int().min(0),
    manifest_hash: sha256,
  }),
  files: z.record(z.string(), z.unknown()),
  bundle_hash: sha256,
});

/** `leases/<id>.json` inside a bundle and the `GET /leases/{id}/evidence` response (redacted). */
export const LeaseEvidenceSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("accesslease.lease-evidence"),
  lease: LeaseDetailSchema,
  events: z.array(EventEnvelopeSchema),
});

export const BundleSummarySchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("accesslease.bundle-summary"),
  workspace: z.object({ id: uuid, name: z.string() }),
  exported_at: utcInstant,
  lease_ids: z.array(uuid),
  by_state: z.record(z.string(), z.int()),
  unresolved: z.object({ issue_unknown: z.int(), revocation_unconfirmed: z.int() }),
  contains_synthetic: z.boolean(),
});

export const BundleVerificationSchema = z.object({
  ok: z.boolean(),
  code: z.enum(BUNDLE_ERROR_CODES).nullable(),
  message: z.string().nullable(),
  bundle_hash: sha256.nullable(),
  schema_version: z.int().nullable(),
  file_count: z.int(),
  lease_count: z.int(),
});

export const ImportReceiptSchema = z.object({
  import_id: uuid,
  bundle_hash: sha256,
  already_imported: z.boolean(),
  lease_count: z.int(),
  imported_at: utcInstant,
});

export const SessionSchema = z.object({
  user: z.object({ id: uuid, email: z.string(), workspace_id: uuid, workspace_name: z.string(), role: z.enum(ROLES) }),
  csrf_token: z.string(),
});

export const HealthSchema = z.object({ status: z.enum(["ok", "ready"]) });
