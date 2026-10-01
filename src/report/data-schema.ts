import { z } from "zod";
import type { ReportData } from "../services/contract.js";
import { REPORT_LIMITS, ReportInputError } from "./model.js";

/**
 * Validation for a saved `report-data.json` (the redacted ReportData document) before it is rendered offline.
 * Only the fields the report uses are required; additional members from newer backends are ignored.
 */
const text = z.string().max(REPORT_LIMITS.maxTextLength);
const provider = z.looseObject({ kind: text, label: text, live: z.boolean() });

const attempt = z.looseObject({ attempted_at: text, result: text, verification_ref: text.nullable().optional() });
const audit = z.looseObject({ occurred_at: text, actor_ref: text, action: text, metadata: z.record(z.string(), z.unknown()).optional() });

const lease = z.looseObject({
  id: text,
  task_ref: text,
  subject_ref: text,
  resource_ref: text,
  scopes: z.array(text).max(REPORT_LIMITS.maxScopes),
  state: text,
  expires_at: text,
  last_verified_at: text.nullable(),
  revocation_status: text,
  next_retry_at: text.nullable(),
  provider,
  close_reason: text.nullable().optional(),
  warning: text.nullable(),
  attempts: z.array(attempt).max(REPORT_LIMITS.maxRowsPerLease),
  audit: z.array(audit).max(REPORT_LIMITS.maxRowsPerLease),
});

export const reportDataSchema = z.looseObject({
  schema_version: z.literal(1),
  generated_at: text,
  workspace: z.looseObject({ id: text, name: text }),
  providers: z.array(provider).max(16),
  contains_synthetic: z.boolean(),
  /**
   * True when `leases` lists only some of the workspace's leases. Files written before this field existed omit it;
   * they are accepted only if their own summary total equals the number of listed leases (see parseReportData).
   */
  truncated: z.boolean().optional(),
  workspace_total: z.number().int().nonnegative().optional(),
  summary: z.looseObject({
    total: z.number().int().nonnegative().optional(),
    by_state: z.record(z.string(), z.number().int().nonnegative()).optional(),
    unresolved: z.looseObject({ issue_unknown: z.number().int().nonnegative(), revocation_unconfirmed: z.number().int().nonnegative() }),
    max_revocation_request_delay_seconds: z.number().nonnegative().nullable(),
  }),
  leases: z.array(lease).max(REPORT_LIMITS.maxLeases),
});

/** Parse untrusted JSON text into ReportData. Errors are bounded, secret-free and carry exit code 2 through ReportInputError. */
export function parseReportData(json: string): ReportData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ReportInputError("report data is not valid JSON (the file may be truncated)");
  }
  const parsed = reportDataSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length ? first.path.join(".") : "report data";
    throw new ReportInputError(`invalid report data at ${where}: ${first?.message ?? "schema mismatch"}`);
  }
  const d = parsed.data;
  if (d.truncated === undefined) {
    // Unknown completeness: only trust the file if its own summary says the listed leases are all there is.
    if (d.summary.total === undefined || d.summary.total !== d.leases.length || (d.workspace_total !== undefined && d.workspace_total !== d.leases.length)) {
      throw new ReportInputError("invalid report data at truncated: the file does not say whether it is complete and its summary total does not match the listed leases");
    }
    d.truncated = false;
    d.workspace_total = d.leases.length;
  } else if (d.workspace_total === undefined) {
    throw new ReportInputError("invalid report data at workspace_total: required when truncated is present");
  }
  const total = d.workspace_total as number;
  if (total < d.leases.length || (!d.truncated && total !== d.leases.length)) {
    throw new ReportInputError(`invalid report data at workspace_total: ${total} does not match ${d.leases.length} listed leases and truncated=${d.truncated}`);
  }
  if (d.truncated && d.summary.by_state === undefined) {
    throw new ReportInputError("invalid report data at summary.by_state: required for a truncated report");
  }
  return d as unknown as ReportData;
}
