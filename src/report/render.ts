import { loadReportTemplate } from "./assets.js";
import { type ReportAttempt, type ReportAuditEvent, type ReportLease, type ReportModel } from "./model.js";
import { redactText } from "./redact.js";
import { LEASE_STATES, isUncertainState, needsAttention, presentState, providerLabel, type StatePresentation } from "./status.js";

/** Escape text for HTML element content and quoted attribute values. Untrusted input never reaches the page unescaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return "&#96;";
    }
  });
}

/** Redact then escape: the only way free text enters the report. */
const safe = (value: string | null | undefined): string => escapeHtml(redactText(value ?? ""));
const dash = (value: string | null | undefined): string => (value ? safe(value) : '<span class="muted">&mdash;</span>');

/** Anchor ids are derived, never taken verbatim from input. */
const anchor = (index: number): string => `lease-${index + 1}`;

function renderBadge(state: string, p: StatePresentation): string {
  // The text always carries the meaning; colour is a second channel. Uncertain states add an explicit warning marker.
  const marker = p.uncertain ? '&#9888; <span class="sr-only">Warning: </span>' : "";
  return `<span class="badge tone-${p.tone}" data-state="${safe(state)}">${marker}${safe(p.label)}</span>`;
}

const badge = (state: string, lastVerifiedAt: string | null): string => renderBadge(state, presentState(state, lastVerifiedAt));

function table(caption: string, headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${safe(empty)}</p>`;
  const head = headers.map((h) => `<th scope="col">${safe(h)}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><caption>${safe(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function summarySection(model: ReportModel): string {
  const counts = new Map<string, number>();
  if (model.state_counts) for (const [state, n] of Object.entries(model.state_counts)) counts.set(state, n);
  else for (const lease of model.leases) counts.set(lease.state, (counts.get(lease.state) ?? 0) + 1);
  const known = new Set<string>(LEASE_STATES);
  const unknownStates = [...counts.keys()].filter((s) => !known.has(s)).sort();
  // Summary badges describe the state itself, so the verification-time consistency check does not apply here.
  const rows = [...LEASE_STATES, ...unknownStates].map((state) => [renderBadge(state, presentState(state, "summary")), String(counts.get(state) ?? 0)]);
  const delay =
    model.max_revocation_request_delay_seconds === null
      ? "<p class=\"muted\">Revocation request delay after expiry: not measured (no revoked lease in this report).</p>"
      : `<p>Longest delay between expiry and the first revocation request: <strong>${model.max_revocation_request_delay_seconds} s</strong> (target: 30 s under healthy conditions).</p>`;
  return `<section aria-labelledby="summary-h"><h2 id="summary-h">Summary</h2>${table(model.state_counts ? "Leases by state (whole workspace)" : "Leases by state", ["State", "Count"], rows, "No leases.")}${delay}</section>`;
}

function truncationSection(model: ReportModel): string {
  if (!model.truncation) return "";
  const { shown, total } = model.truncation;
  const hidden = model.workspace_unresolved === null ? "" : ` The workspace has ${model.workspace_unresolved} unresolved lease${model.workspace_unresolved === 1 ? "" : "s"} in total; some may not be listed below.`;
  return `<section class="error" role="alert" aria-labelledby="trunc-h"><h2 id="trunc-h">&#9888; Incomplete report: showing ${shown} of ${total} leases</h2><p>Only some leases are listed. A lease that is not listed can be unresolved or unverified: do not read this report as success.${hidden}</p></section>`;
}

function attentionSection(model: ReportModel): string {
  const flagged = model.leases.map((lease, index) => ({ lease, index })).filter(({ lease }) => needsAttention(lease.state, lease.last_verified_at));
  if (flagged.length === 0) {
    const scope = model.truncation
      ? "None of the listed leases is in an unresolved state, but this report is incomplete, so this says nothing about the leases that are not listed."
      : "No lease in this report is in an unresolved state. This covers only the leases listed below.";
    return `<section class="note" aria-labelledby="attention-h"><h2 id="attention-h">Unresolved states</h2><p>${scope}</p></section>`;
  }
  const items = flagged
    .map(({ lease, index }) => {
      const p = presentState(lease.state, lease.last_verified_at);
      const retry = lease.next_retry_at ? `Next retry: <time datetime="${safe(lease.next_retry_at)}">${safe(lease.next_retry_at)}</time>.` : "No retry is scheduled; an operator must investigate.";
      return `<li><a href="#${anchor(index)}">${safe(lease.task_ref)}</a> ${renderBadge(lease.state, p)} ${safe(p.explanation)} ${retry}</li>`;
    })
    .join("");
  return `<section class="warning" role="alert" aria-labelledby="attention-h"><h2 id="attention-h">&#9888; ${flagged.length} unresolved ${flagged.length === 1 ? "state" : "states"}: do not read as success</h2><ul>${items}</ul></section>`;
}

function errorsSection(model: ReportModel): string {
  if (model.errors.length === 0) return "";
  const items = model.errors.map((e) => `<li>${safe(e)}</li>`).join("");
  return `<section class="error" role="alert" aria-labelledby="errors-h"><h2 id="errors-h">Report problems</h2><p>The data below may be incomplete.</p><ul>${items}</ul></section>`;
}

function attemptsTable(rows: ReportAttempt[]): string {
  return table(
    "Revocation attempts",
    ["Attempted at", "Result", "Verification reference"],
    rows.map((a) => [dash(a.attempted_at), safe(a.result), dash(a.verification_ref)]),
    "No revocation attempts recorded.",
  );
}

function auditTable(rows: ReportAuditEvent[]): string {
  return table(
    "Audit trail",
    ["Occurred at", "Actor", "Action", "Details"],
    rows.map((e) => [dash(e.occurred_at), safe(e.actor_ref), safe(e.action), dash(e.details)]),
    "No audit events recorded.",
  );
}

function leaseSection(lease: ReportLease, index: number): string {
  const p = presentState(lease.state, lease.last_verified_at);
  const cls = p.uncertain || p.tone === "invalid" ? "lease unresolved" : "lease";
  const scopes = lease.scopes.length ? `<ul class="scopes">${lease.scopes.map((s) => `<li><code>${safe(s)}</code></li>`).join("")}</ul>` : '<span class="muted">none</span>';
  const retry = lease.next_retry_at ? safe(lease.next_retry_at) : p.uncertain ? "not scheduled" : '<span class="muted">&mdash;</span>';
  const core = `<dl class="facts">
<dt>State</dt><dd>${renderBadge(lease.state, p)}</dd>
<dt>Meaning</dt><dd>${safe(p.explanation)}</dd>
${lease.warning ? `<dt>Warning</dt><dd class="warn-text">${safe(lease.warning)}</dd>` : ""}
<dt>Provider</dt><dd>${lease.provider_label ? safe(lease.provider_label) : '<span class="muted">&mdash;</span>'}</dd>
<dt>Expires at (UTC)</dt><dd>${dash(lease.expires_at)}</dd>
<dt>Last verified at (UTC)</dt><dd>${dash(lease.last_verified_at)}</dd>
<dt>Revocation status</dt><dd>${safe(lease.revocation_status)}</dd>
<dt>Why revocation began</dt><dd>${dash(lease.close_reason)}</dd>
<dt>Next retry at (UTC)</dt><dd>${retry}</dd>
<dt>Subject</dt><dd>${safe(lease.subject_ref)}</dd>
<dt>Resource</dt><dd>${safe(lease.resource_ref)}</dd>
<dt>Scopes</dt><dd>${scopes}</dd>
<dt>Lease id</dt><dd><code>${safe(lease.id)}</code></dd>
</dl>`;
  return `<section class="${cls}" id="${anchor(index)}" aria-labelledby="${anchor(index)}-h"><h3 id="${anchor(index)}-h">${safe(lease.task_ref)}</h3>${core}${attemptsTable(lease.attempts)}${auditTable(lease.audit)}</section>`;
}

function overviewSection(model: ReportModel): string {
  const inner = table(
    "Leases",
    ["Task", "State", "Expires at (UTC)", "Last verified (UTC)", "Revocation status", "Next retry (UTC)"],
    model.leases.map((l, i) => [
      `<a href="#${anchor(i)}">${safe(l.task_ref)}</a>`,
      badge(l.state, l.last_verified_at),
      dash(l.expires_at),
      dash(l.last_verified_at),
      safe(l.revocation_status),
      isUncertainState(l.state) && !l.next_retry_at ? "not scheduled" : dash(l.next_retry_at),
    ]),
    "No leases in this report.",
  );
  return `<section aria-labelledby="overview-h"><h2 id="overview-h">Leases</h2>${inner}</section>`;
}

function providerBanner(model: ReportModel): string {
  const label = safe(providerLabel(model.provider_kind));
  if (model.provider_kind === "mixed") {
    return '<p class="banner synthetic" role="note"><strong>SYNTHETIC leases included</strong> &mdash; some leases below come from the synthetic provider and are not live evidence. Check the provider on each lease.</p>';
  }
  if (model.provider_kind === "synthetic") {
    return `<p class="banner synthetic" role="note"><strong>SYNTHETIC</strong> &mdash; this report was produced with the synthetic provider (${label}). It is not live evidence and cannot satisfy a live criterion.</p>`;
  }
  return `<p class="banner" role="note">Provider: ${label}</p>`;
}

/** Fill `{{name}}` placeholders in one pass, so substituted content is never re-scanned for placeholders. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) => (name in values ? (values[name] as string) : match));
}

export interface RenderOptions {
  template?: string;
}

/** Render the static HTML report. Output has no scripts and no external resources. */
export function renderReport(model: ReportModel, options: RenderOptions = {}): string {
  const template = options.template ?? loadReportTemplate();
  const workspace = model.workspace_label ? ` &middot; ${safe(model.workspace_label)}` : "";
  const leases = model.leases.length ? `<h2>Lease details</h2>\n${model.leases.map(leaseSection).join("\n")}` : "";
  return fillTemplate(template, {
    title: safe(model.title),
    meta: `Generated at ${safe(model.generated_at)} (UTC)${workspace}`,
    provider_banner: providerBanner(model),
    errors: truncationSection(model) + errorsSection(model),
    attention: attentionSection(model),
    summary: summarySection(model),
    overview: overviewSection(model),
    leases,
  });
}

/** A report that states why no data could be shown. Used when the data source is unavailable or invalid. */
export function renderErrorReport(message: string, generatedAt: string, options: RenderOptions = {}): string {
  const template = options.template ?? loadReportTemplate();
  return fillTemplate(template, {
    title: "AccessLease report unavailable",
    meta: `Generated at ${safe(generatedAt)} (UTC)`,
    provider_banner: "",
    errors: `<section class="error" role="alert" aria-labelledby="errors-h"><h2 id="errors-h">Report unavailable</h2><p>${safe(message)}</p><p>No lease state could be shown. Do not treat this page as evidence of revocation.</p></section>`,
    attention: "",
    summary: "",
    overview: "",
    leases: "",
  });
}
