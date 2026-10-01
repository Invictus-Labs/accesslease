import type { Ctx } from "../context.js";
import { SWEEP_STATES } from "../domain/state-machine.js";
import { REVOCATION_REQUEST_SLA_SECONDS } from "../domain/types.js";
import { reclaimExpired } from "../services/jobs.js";
import { lockLease, startRevocation } from "../services/lifecycle.js";
import { purgeIdempotencyKeys } from "../services/idempotency.js";
import type { SweepReport } from "../services/contract.js";

const ACTOR = "system:worker";

/**
 * Overdue sweep (AC-04, AC-06). Every worker pass starts here, before any job (and therefore before any issuance) runs:
 * - jobs whose worker lease expired are returned to the queue (restart recovery);
 * - every lease past `expires_at` that is still REQUESTED/APPROVED/ISSUING/ACTIVE/ISSUE_UNKNOWN enters REVOKING with a
 *   revoke job. Expired is not revoked: verification happens in the revoke job.
 * Each lease is handled in its own transaction under a row lock, so a concurrent worker cannot double-process it.
 */
export async function sweepOverdue(ctx: Ctx): Promise<SweepReport> {
  const now = ctx.clock();
  const report: SweepReport = { expiredToRevoking: 0, overdueRecovered: 0, staleRequestsClosed: 0, jobsReclaimed: 0, at: now.toISOString() };
  report.jobsReclaimed = await reclaimExpired(ctx.db, ctx.clock);
  for (let round = 0; round < 50; round += 1) {
    const due = await ctx.db.query<{ id: string }>("SELECT id FROM leases WHERE state = ANY($1::lease_state[]) AND expires_at <= $2 ORDER BY expires_at LIMIT 200", [SWEEP_STATES, now]);
    if (due.rows.length === 0) break;
    for (const { id } of due.rows) {
      await ctx.db.transaction(async (tx) => {
        const lease = await lockLease(tx, id);
        if (!lease || !SWEEP_STATES.includes(lease.state) || lease.expires_at.getTime() > now.getTime()) return;
        const lateSeconds = Math.max(0, Math.round((now.getTime() - lease.expires_at.getTime()) / 1000));
        await startRevocation(tx, lease, {
          reason: "expired",
          detail: `expired ${lateSeconds}s before the sweep`,
          at: now,
          actorRef: ACTOR,
          action: "sweep.expired",
          metadata: { late_seconds: lateSeconds, previous_state: lease.state },
        });
        report.expiredToRevoking += 1;
        if (lease.state === "REQUESTED" || lease.state === "APPROVED") report.staleRequestsClosed += 1;
        if (lateSeconds > REVOCATION_REQUEST_SLA_SECONDS) report.overdueRecovered += 1;
      });
    }
  }
  await purgeIdempotencyKeys(ctx.db, now);
  return report;
}
