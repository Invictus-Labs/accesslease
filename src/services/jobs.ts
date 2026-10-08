import { newId } from "../lib/ids.js";
import type { Clock, Ctx } from "../context.js";
import { addSeconds } from "../context.js";
import type { Database, Queryable } from "../db/index.js";
import { SWEEP_STATES } from "../domain/state-machine.js";
import type { JobState, JobType, Principal } from "../domain/types.js";
import { requireRole } from "./roles.js";

export interface Job {
  id: string;
  workspace_id: string;
  lease_id: string;
  type: JobType;
  priority: number;
  state: JobState;
  attempt: number;
  lease_until: Date | null;
  locked_by: string | null;
  next_attempt_at: Date;
  deduplication_key: string;
  last_error: string | null;
}

/** Claim order: revocation first, then reconciliation, then new issuance. */
export const PRIORITY: Record<JobType, number> = { revoke: 0, reconcile: 1, issue: 2 };

/** Retry delay for unconfirmed revocation / unknown issue: exponential, capped (never an attempt ceiling). */
export function retryDelaySeconds(attempt: number, baseSeconds: number, capSeconds: number): number {
  return Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, Math.min(attempt, 16) - 1));
}

/** Enqueue inside the caller's transaction (transactional outbox). The deduplication key makes it idempotent. */
export async function enqueueJob(
  tx: Queryable,
  job: { workspaceId: string; leaseId: string; type: JobType; at: Date; dedupKey: string; delaySeconds?: number },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO jobs (id, workspace_id, lease_id, type, priority, state, next_attempt_at, deduplication_key, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$8)
     ON CONFLICT (deduplication_key) DO UPDATE SET deduplication_key = EXCLUDED.deduplication_key
     RETURNING id`,
    [newId(), job.workspaceId, job.leaseId, job.type, PRIORITY[job.type], addSeconds(job.at, job.delaySeconds ?? 0), job.dedupKey, job.at],
  );
  return (result.rows[0] as { id: string }).id;
}

/**
 * Claim one due job with a row lock and a bounded lease. Rules:
 * - a job whose lease expired (worker died between claim and completion) is reclaimable (AC-13);
 * - jobs of one lease run one at a time (a revoke queued behind an in-flight issue waits for it);
 * - issue/reconcile jobs are not claimable while any lease is overdue and un-swept (AC-06: sweep before issuing);
 * - claim order is revoke, reconcile, issue.
 */
export async function claimJob(db: Queryable, workerId: string, clock: Clock, leaseSeconds: number): Promise<Job | null> {
  const now = clock();
  const sweepStates = SWEEP_STATES.map((s) => `'${s}'`).join(",");
  const result = await db.query<Job>(
    `UPDATE jobs SET state = 'running', attempt = attempt + 1, locked_by = $1, lease_until = $2, updated_at = $3
      WHERE id = (
        SELECT j.id FROM jobs j
         WHERE ((j.state = 'queued' AND j.next_attempt_at <= $3) OR (j.state = 'running' AND j.lease_until < $3))
           AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.lease_id = j.lease_id AND o.id <> j.id AND o.state = 'running' AND o.lease_until >= $3)
           AND (j.type = 'revoke' OR NOT EXISTS (SELECT 1 FROM leases l WHERE l.state IN (${sweepStates}) AND l.expires_at <= $3))
         ORDER BY j.priority, j.next_attempt_at, j.created_at
         LIMIT 1
         FOR UPDATE OF j SKIP LOCKED)
      RETURNING *`,
    [workerId, addSeconds(now, leaseSeconds), now],
  );
  return result.rows[0] ?? null;
}

export class LeaseLostError extends Error {
  constructor() {
    super("job lease lost to another worker");
    this.name = "LeaseLostError";
  }
}

/** Lock the job row for this exact claim, or throw when another worker took it over (fenced completion). */
export async function fence(tx: Queryable, job: Job): Promise<void> {
  const row = await tx.query("SELECT id FROM jobs WHERE id = $1 AND locked_by = $2 AND attempt = $3 AND state = 'running' FOR UPDATE", [job.id, job.locked_by, job.attempt]);
  if (row.rows.length === 0) throw new LeaseLostError();
}

/** Mark the job done. Call inside the same transaction as the effect it completes, after `fence`. */
export async function markDone(tx: Queryable, job: Job, at: Date): Promise<void> {
  await tx.query("UPDATE jobs SET state = 'done', lease_until = NULL, last_error = NULL, updated_at = $2 WHERE id = $1", [job.id, at]);
}

/** Return the job to the queue (retry later). Fenced by the caller. `type` may change (issue -> reconcile). */
export async function requeue(tx: Queryable, job: Job, o: { at: Date; delaySeconds: number; error: string | null; type?: JobType }): Promise<void> {
  await tx.query(
    `UPDATE jobs SET state = 'queued', lease_until = NULL, locked_by = NULL, next_attempt_at = $2, last_error = $3,
            type = COALESCE($4::job_type, type), priority = CASE WHEN $4::job_type IS NULL THEN priority ELSE $5 END, updated_at = $6
      WHERE id = $1`,
    [job.id, addSeconds(o.at, o.delaySeconds), o.error ? o.error.slice(0, 200) : null, o.type ?? null, o.type ? PRIORITY[o.type] : 0, o.at],
  );
}

/** Record an unexpected processing error without losing the job: back to the queue with a visible error. */
export async function failUnexpected(db: Database, job: Job, code: string, clock: Clock, base: number, cap: number): Promise<void> {
  const now = clock();
  await db.query(
    `UPDATE jobs SET state = 'queued', lease_until = NULL, locked_by = NULL, next_attempt_at = $2, last_error = $3, updated_at = $4
      WHERE id = $1 AND locked_by = $5 AND attempt = $6 AND state = 'running'`,
    [job.id, addSeconds(now, retryDelaySeconds(job.attempt, base, cap)), code.slice(0, 200), now, job.locked_by, job.attempt],
  );
}

/** Eagerly return jobs whose worker lease expired to the queue (restart recovery). Returns how many. */
export async function reclaimExpired(db: Queryable, clock: Clock): Promise<number> {
  const result = await db.query(
    "UPDATE jobs SET state = 'queued', lease_until = NULL, locked_by = NULL, last_error = COALESCE(last_error, 'lease_expired'), updated_at = $1 WHERE state = 'running' AND lease_until < $1",
    [clock()],
  );
  return result.rowCount;
}

export interface JobView {
  id: string;
  lease_id: string;
  type: JobType;
  state: JobState;
  attempt: number;
  next_attempt_at: string;
  last_error: string | null;
  /** queued, running, failed (queued after an error), or unknown (lease expired while running). */
  status: "queued" | "running" | "failed" | "unknown" | "done" | "dead";
}

export async function listJobs(ctx: Ctx, principal: Principal): Promise<JobView[]> {
  requireRole(principal, "operator");
  const now = ctx.clock();
  const result = await ctx.db.query<Job>("SELECT * FROM jobs WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100", [principal.workspaceId]);
  return result.rows.map((j) => ({
    id: j.id,
    lease_id: j.lease_id,
    type: j.type,
    state: j.state,
    attempt: j.attempt,
    next_attempt_at: j.next_attempt_at.toISOString(),
    last_error: j.last_error,
    status:
      j.state === "running" && j.lease_until && j.lease_until < now
        ? "unknown"
        : j.state === "queued" && j.last_error
          ? "failed"
          : j.state,
  }));
}
