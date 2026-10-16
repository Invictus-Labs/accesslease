import type { Ctx } from "../context.js";
import { addSeconds } from "../context.js";
import type { Database } from "../db/index.js";

export interface RetentionReport {
  leases: number;
  workspaceAudit: number;
  imports: number;
}

const BATCH = 200;

/**
 * Retention (PRD section 6): redacted evidence is kept `retention_days` (default 90, per workspace policy) after verified
 * revocation; primary deletion runs from the worker at least hourly, so it completes well within 24 hours. Only
 * REVOKED_VERIFIED leases are ever deleted: unresolved, active or pending leases are never purged. The append-only triggers
 * allow DELETE only inside this transaction (`accesslease.retention = 'on'`). Rotated backups expire on the operator's
 * schedule (documented in the runbook: 30 days).
 */
export async function purgeExpiredEvidence(ctx: Ctx): Promise<RetentionReport> {
  const now = ctx.clock();
  const report: RetentionReport = { leases: 0, workspaceAudit: 0, imports: 0 };
  const policies = await ctx.db.query<{ workspace_id: string; retention_days: number }>("SELECT workspace_id, retention_days FROM policies");
  for (const { workspace_id: workspaceId, retention_days: days } of policies.rows) {
    const cutoff = addSeconds(now, -days * 86_400);
    for (;;) {
      const batch = await ctx.db.transaction(async (tx) => {
        await tx.query("SET LOCAL accesslease.retention = 'on'");
        const ids = (
          await tx.query<{ id: string }>(
            "SELECT id FROM leases WHERE workspace_id = $1 AND state = 'REVOKED_VERIFIED' AND revoked_at < $2 ORDER BY revoked_at LIMIT $3 FOR UPDATE",
            [workspaceId, cutoff, BATCH],
          )
        ).rows.map((r) => r.id);
        if (ids.length === 0) return 0;
        for (const table of ["audit_events", "revocation_attempts", "events", "jobs", "approvals", "provider_grants", "lease_secrets"]) {
          await tx.query(`DELETE FROM ${table} WHERE lease_id = ANY($1::uuid[])`, [ids]);
        }
        await tx.query("DELETE FROM leases WHERE id = ANY($1::uuid[])", [ids]);
        return ids.length;
      });
      report.leases += batch;
      if (batch < BATCH) break;
    }
    const detached = await ctx.db.transaction(async (tx) => {
      await tx.query("SET LOCAL accesslease.retention = 'on'");
      const audit = await tx.query("DELETE FROM audit_events WHERE workspace_id = $1 AND lease_id IS NULL AND occurred_at < $2", [workspaceId, cutoff]);
      await tx.query("DELETE FROM imported_leases WHERE workspace_id = $1 AND import_id IN (SELECT id FROM evidence_imports WHERE workspace_id = $1 AND imported_at < $2)", [workspaceId, cutoff]);
      const imports = await tx.query("DELETE FROM evidence_imports WHERE workspace_id = $1 AND imported_at < $2", [workspaceId, cutoff]);
      return { audit: audit.rowCount, imports: imports.rowCount };
    });
    report.workspaceAudit += detached.audit;
    report.imports += detached.imports;
  }
  return report;
}

const lastRun = new WeakMap<Database, number>();

/** Run the purge at most once per hour per process and database (called by every worker pass). */
export async function maybePurge(ctx: Ctx): Promise<RetentionReport | null> {
  const nowMs = ctx.clock().getTime();
  const previous = lastRun.get(ctx.db);
  if (previous !== undefined && nowMs - previous < 3_600_000 && nowMs >= previous) return null;
  lastRun.set(ctx.db, nowMs);
  return purgeExpiredEvidence(ctx);
}
