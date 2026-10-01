import type { ReportData } from "../services/contract.js";
import { parseReportModel, REPORT_SCHEMA_VERSION, ReportInputError, type ReportModel } from "./model.js";
import { formatMetadata, needsAttention } from "./status.js";

/**
 * Adapt the backend's redacted ReportData into the report view-model and validate it (size and schema first).
 * The mapping keeps every unresolved or unconfirmed field the backend reported; nothing is derived from clocks.
 */
export function reportModelFromData(data: ReportData): ReportModel {
  const kinds = new Set(data.providers.map((p) => p.kind));
  for (const lease of data.leases) kinds.add(lease.provider.kind);
  const providerKind = kinds.size === 1 ? ([...kinds][0] as string) : kinds.size === 0 ? "unknown" : "mixed";
  return parseReportModel({
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: data.generated_at,
    title: "AccessLease report",
    provider_kind: providerKind,
    workspace_label: data.workspace.name,
    max_revocation_request_delay_seconds: data.summary.max_revocation_request_delay_seconds,
    errors: [],
    truncation: data.truncated ? { shown: data.leases.length, total: data.workspace_total } : null,
    state_counts: data.truncated ? Object.fromEntries(Object.entries(data.summary.by_state).map(([k, v]) => [k.toUpperCase(), v])) : null,
    workspace_unresolved: data.truncated ? data.summary.unresolved.issue_unknown + data.summary.unresolved.revocation_unconfirmed : null,
    leases: data.leases.map((l) => ({
      id: l.id,
      task_ref: l.task_ref,
      subject_ref: l.subject_ref,
      resource_ref: l.resource_ref,
      scopes: l.scopes,
      state: l.state.toUpperCase(),
      expires_at: l.expires_at,
      last_verified_at: l.last_verified_at,
      revocation_status: l.revocation_status,
      next_retry_at: l.next_retry_at,
      provider_label: l.provider.label,
      close_reason: l.close_reason ?? null,
      warning: l.warning,
      attempts: l.attempts.map((a) => ({ attempted_at: a.attempted_at, result: a.result, verification_ref: a.verification_ref || null })),
      audit: l.audit.map((e) => ({ occurred_at: e.occurred_at, actor_ref: e.actor_ref, action: e.action, details: formatMetadata(e.metadata) || null })),
    })),
  });
}

export interface UnresolvedCount {
  issueUnknown: number;
  revocationUnconfirmed: number;
  /** Unrecognised states and verified-without-verification-time records: unresolved, but not a contract category. */
  other: number;
}

/** Recount unresolved leases from the leases themselves. The report's self-declared summary is never trusted for this. */
export function recountUnresolved(data: ReportData): UnresolvedCount {
  const out: UnresolvedCount = { issueUnknown: 0, revocationUnconfirmed: 0, other: 0 };
  for (const lease of data.leases) {
    const state = lease.state.toUpperCase();
    if (state === "ISSUE_UNKNOWN") out.issueUnknown += 1;
    else if (state === "REVOCATION_UNCONFIRMED") out.revocationUnconfirmed += 1;
    else if (needsAttention(state, lease.last_verified_at)) out.other += 1;
  }
  return out;
}

/**
 * Number of unresolved leases in a report, for exit code 4, counted from the leases. A complete report whose summary
 * disagrees with its own leases is refused (ReportInputError, exit 2). A truncated report lists only some leases while its
 * summary covers the whole workspace, so the summary may only be larger than the listed count, never smaller; the larger
 * figure is used so a hidden unresolved lease can never read as success.
 */
export function unresolvedInReport(data: ReportData): number {
  const counted = recountUnresolved(data);
  const declared = data.summary.unresolved;
  const disagree = data.truncated
    ? declared.issue_unknown < counted.issueUnknown || declared.revocation_unconfirmed < counted.revocationUnconfirmed
    : declared.issue_unknown !== counted.issueUnknown || declared.revocation_unconfirmed !== counted.revocationUnconfirmed;
  if (disagree) {
    throw new ReportInputError(
      `report summary disagrees with its leases (summary says ${declared.issue_unknown} ISSUE_UNKNOWN and ${declared.revocation_unconfirmed} REVOCATION_UNCONFIRMED, the leases show ${counted.issueUnknown} and ${counted.revocationUnconfirmed}); refusing to use it`,
    );
  }
  const issueUnknown = Math.max(declared.issue_unknown, counted.issueUnknown);
  const revocationUnconfirmed = Math.max(declared.revocation_unconfirmed, counted.revocationUnconfirmed);
  return issueUnknown + revocationUnconfirmed + counted.other;
}
