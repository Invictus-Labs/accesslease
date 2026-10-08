import type { Ctx } from "../context.js";
import { labelForKind } from "../domain/scopes.js";
import { LIST_MAX_LIMIT, type Principal, type ProviderKind, type ProviderLabel, WIRE_STATES, type WireLeaseState } from "../domain/types.js";
import { redactDeep } from "../lib/redact.js";
import type { ReportData, ReportLease, ReportOptions } from "./contract.js";
import { listImports } from "./evidence.js";
import { loadDetails } from "./leases.js";
import { requireRole } from "./roles.js";

export { unresolvedCount } from "./unresolved.js";

/**
 * Data for the static report and the UI report view (viewer and above). Already redacted: the renderer must still
 * HTML-escape every string (hostile text is data). The unresolved states are counted explicitly so a renderer cannot
 * present them as success.
 */
export async function getReportData(ctx: Ctx, principal: Principal, options: ReportOptions = {}): Promise<ReportData> {
  requireRole(principal, "viewer");
  const limit = Math.min(options.limit ?? 1000, 1000);
  // Summary counts come from SQL over the WHOLE workspace (or the requested subset), never from the truncated list, so an unresolved
  // lease can not be hidden by the list limit. The list keeps the newest `limit` leases (shown oldest first).
  const subset = options.leaseIds ?? null;
  const counts = (
    await ctx.db.query<{ state: string; n: number }>(
      "SELECT state::text AS state, count(*)::int AS n FROM leases WHERE workspace_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) GROUP BY state",
      [principal.workspaceId, subset],
    )
  ).rows;
  const rows = (
    await ctx.db.query<{ id: string }>(
      `SELECT id FROM (SELECT id, created_at FROM leases WHERE workspace_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
                        ORDER BY created_at DESC, id DESC LIMIT $3) newest ORDER BY created_at, id`,
      [principal.workspaceId, subset, limit],
    )
  ).rows;
  const leases: ReportLease[] = (await loadDetails(ctx.db, principal.workspaceId, rows.map((r) => r.id))) as ReportLease[];
  const byState = Object.fromEntries(WIRE_STATES.map((s) => [s, 0])) as Record<WireLeaseState, number>;
  const labels = new Map<string, ProviderLabel>();
  let maxDelay: number | null = null;
  for (const { state, n } of counts) byState[state.toLowerCase() as WireLeaseState] = n;
  const workspaceTotal = counts.reduce((sum, c) => sum + c.n, 0);
  const kinds = (await ctx.db.query<{ kind: ProviderKind }>("SELECT DISTINCT provider_kind::text AS kind FROM leases WHERE workspace_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))", [principal.workspaceId, subset])).rows;
  for (const { kind } of kinds) labels.set(kind, labelForKind(kind));
  const delays = (
    await ctx.db.query<{ delay: number }>(
      `SELECT EXTRACT(EPOCH FROM (close_requested_at - expires_at))::float8 AS delay FROM leases
        WHERE workspace_id = $1 AND close_reason = 'expired' AND close_requested_at IS NOT NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [principal.workspaceId, options.leaseIds ?? null],
    )
  ).rows;
  for (const { delay } of delays) maxDelay = maxDelay === null ? delay : Math.max(maxDelay, delay);
  const imports = (await listImports(ctx, principal)).map((i) => ({ import_id: i.import_id, bundle_hash: i.bundle_hash, lease_count: i.lease_count, imported_at: i.imported_at }));
  const data: ReportData = {
    schema_version: 1,
    generated_at: ctx.clock().toISOString(),
    workspace: { id: principal.workspaceId, name: principal.workspaceName },
    providers: [...labels.values()],
    contains_synthetic: [...labels.values()].some((l) => !l.live),
    truncated: workspaceTotal > leases.length,
    workspace_total: workspaceTotal,
    summary: {
      total: workspaceTotal,
      by_state: byState,
      unresolved: { issue_unknown: byState.issue_unknown, revocation_unconfirmed: byState.revocation_unconfirmed },
      max_revocation_request_delay_seconds: maxDelay === null ? null : Math.round(maxDelay * 1000) / 1000,
    },
    leases,
    imports,
  };
  return redactDeep(data) as ReportData;
}

export const REPORT_LIMIT = LIST_MAX_LIMIT * 10;
