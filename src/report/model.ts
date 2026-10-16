import { z } from "zod";

/** Report view-model. The CLI adapts backend lease records into this shape; it is validated before rendering. */
export const REPORT_SCHEMA_VERSION = 1;

/** Size limits applied before any rendering work (AC-09: validate size and schema first). */
export const REPORT_LIMITS = {
  maxLeases: 5000,
  maxRowsPerLease: 500,
  maxTextLength: 2000,
  maxScopes: 64,
  maxErrors: 50,
} as const;

const text = z.string().max(REPORT_LIMITS.maxTextLength);
const timestamp = z.string().max(64);

export const reportAttemptSchema = z
  .object({
    attempted_at: timestamp,
    result: text,
    verification_ref: text.nullable().default(null),
  })
  .strict();

export const reportAuditEventSchema = z
  .object({
    occurred_at: timestamp,
    actor_ref: text,
    action: text,
    /** Redacted scalar metadata of the event (for example the revocation reason), one line. */
    details: text.nullable().default(null),
  })
  .strict();

export const reportLeaseSchema = z
  .object({
    id: text,
    task_ref: text,
    subject_ref: text,
    resource_ref: text,
    scopes: z.array(text).max(REPORT_LIMITS.maxScopes),
    state: text,
    expires_at: timestamp,
    last_verified_at: timestamp.nullable().default(null),
    revocation_status: text,
    next_retry_at: timestamp.nullable().default(null),
    /** Provider label of this lease, for example SYNTHETIC or LIVE_LOCAL_POSTGRES. */
    provider_label: text.nullable().default(null),
    /** Why revocation began: expired, task_closed, operator_revoked or a refusal reason. Null before revocation. */
    close_reason: text.nullable().default(null),
    /** Server-provided warning for unresolved or in-progress states. */
    warning: text.nullable().default(null),
    attempts: z.array(reportAttemptSchema).max(REPORT_LIMITS.maxRowsPerLease).default([]),
    audit: z.array(reportAuditEventSchema).max(REPORT_LIMITS.maxRowsPerLease).default([]),
  })
  .strict();

export const reportModelSchema = z
  .object({
    schema_version: z.literal(REPORT_SCHEMA_VERSION),
    /** Supplied by the caller (a fixed clock in the demo) so a report is reproducible. */
    generated_at: timestamp,
    title: text.default("AccessLease report"),
    /** synthetic | postgres-role | mixed (leases from more than one provider kind). */
    provider_kind: text,
    workspace_label: text.nullable().default(null),
    leases: z.array(reportLeaseSchema).max(REPORT_LIMITS.maxLeases),
    /** Longest delay between expiry and the first revocation request among revoked leases (AC-04 evidence), or null. */
    max_revocation_request_delay_seconds: z.number().nonnegative().nullable().default(null),
    /** Set when the report lists only some of the workspace's leases: shown of total. Never silently dropped. */
    truncation: z.object({ shown: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().nullable().default(null),
    /** Whole-workspace lease counts per state, present when the list is truncated and the counts cover more than it. */
    state_counts: z.record(z.string(), z.number().int().nonnegative()).nullable().default(null),
    /** Whole-workspace unresolved lease count (ISSUE_UNKNOWN + REVOCATION_UNCONFIRMED) when truncated. */
    workspace_unresolved: z.number().int().nonnegative().nullable().default(null),
    /** Load or verification problems to show prominently (never silently dropped). */
    errors: z.array(text).max(REPORT_LIMITS.maxErrors).default([]),
  })
  .strict();

export type ReportAttempt = z.infer<typeof reportAttemptSchema>;
export type ReportAuditEvent = z.infer<typeof reportAuditEventSchema>;
export type ReportLease = z.infer<typeof reportLeaseSchema>;
export type ReportModel = z.infer<typeof reportModelSchema>;
export type ReportModelInput = z.input<typeof reportModelSchema>;

export class ReportInputError extends Error {
  readonly code = "report_invalid";
}

/** Parse untrusted input into a report model; throws ReportInputError with a bounded, secret-free message. */
export function parseReportModel(input: unknown): ReportModel {
  const parsed = reportModelSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length ? first.path.join(".") : "report";
    throw new ReportInputError(`invalid report input at ${where}: ${first?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}
