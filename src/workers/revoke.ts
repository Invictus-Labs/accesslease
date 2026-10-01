import { newId } from "../lib/ids.js";
import type { LookupResult, ProbeResult, RevokeStep } from "../connectors/provider.js";
import type { Ctx } from "../context.js";
import type { RevocationResult } from "../domain/types.js";
import { redactDeep } from "../lib/redact.js";
import { audit } from "../services/audit.js";
import { fence, type Job, markDone, requeue, retryDelaySeconds } from "../services/jobs.js";
import { lockLease, transition } from "../services/lifecycle.js";
import type { LeaseRow } from "../services/rows.js";
import { withDeadline } from "./deadline.js";
import { credentialSecretFor } from "./issue.js";

const ACTOR = "system:worker";

export type RevokeOutcome = "verified" | "unconfirmed" | "skipped";

const errorCode = (error: unknown): string => (error as { code?: string }).code ?? "provider_error";

/**
 * Revoke and independently verify one lease (AC-04, AC-05).
 *   B. revoke at the provider (idempotent), then verify with provider introspection AND a denied-use probe.
 *   C. fenced transaction: append the attempt row; REVOKED_VERIFIED only when introspection says the grant is gone
 *      and the probe was denied. Anything else (outage, partial, stale, unknown probe) is REVOCATION_UNCONFIRMED with
 *      next_retry_at; the job returns to the queue and never gives up.
 * Elapsed time alone is never verification.
 */
export async function processRevoke(ctx: Ctx, job: Job): Promise<RevokeOutcome> {
  const start = await ctx.db.transaction(async (tx) => {
    const now = ctx.clock();
    // Lock order everywhere: lease, then job, then workspace (event sequence).
    const lease = (await lockLease(tx, job.lease_id)) as LeaseRow;
    await fence(tx, job);
    if (!["REVOKING", "REVOCATION_UNCONFIRMED"].includes(lease.state)) {
      await markDone(tx, job, now);
      return null;
    }
    const n = await tx.query<{ n: number }>("SELECT COALESCE(max(attempt_no), 0) + 1 AS n FROM revocation_attempts WHERE lease_id = $1", [lease.id]);
    return { lease, attemptNo: n.rows[0]?.n ?? 1 };
  });
  if (!start) return "skipped";
  const { lease, attemptNo } = start;

  // ---- Phase B: provider revocation + independent verification (no transaction held) ----
  const provider = ctx.providers.get(lease.provider_kind);
  const target = { leaseId: lease.id, resource: lease.resource_ref };
  let steps: RevokeStep[] = [];
  let sessionsTerminated = 0;
  let look: LookupResult | null = null;
  let probe: ProbeResult = "unknown";
  let errCode: string | null = null;
  if (!provider) {
    errCode = "provider_disconnected";
  } else {
    try {
      const revoked = await withDeadline(ctx.settings.providerRevokeTimeoutMs, () => provider.revoke(target));
      steps = revoked.steps;
      sessionsTerminated = revoked.sessionsTerminated;
    } catch (error) {
      errCode = errorCode(error);
    }
    try {
      look = await withDeadline(ctx.settings.providerCallTimeoutMs, () => provider.lookup(target));
    } catch (error) {
      errCode = errCode ?? errorCode(error);
    }
    try {
      probe = await withDeadline(ctx.settings.providerCallTimeoutMs, () => provider.probeUse({ ...target, credentialSecret: credentialSecretFor(ctx, lease.id) }));
    } catch (error) {
      errCode = errCode ?? errorCode(error);
      probe = "unknown";
    }
  }
  // Verified needs independent introspection AND a denied probe, and no revocation step may have failed (a failed session termination
  // must never be hidden by a later drop of the role).
  // Absence during an unfinished/failed revoke is not settled terminality: its fence may still roll back.
  const verified = errCode === null && steps.length > 0 && look?.state === "absent" && probe === "denied" && steps.every((s) => s.ok);
  const result: RevocationResult = verified ? "verified" : errCode ? "provider_error" : "unverified";
  const verificationRef = `introspection:${look?.state ?? "error"}+probe:${probe}`;
  const detail = redactDeep({
    steps,
    sessions_terminated: sessionsTerminated,
    introspection: look ? { state: look.state, login_allowed: look.loginAllowed, active_sessions: look.activeSessions, ...look.detail } : { state: "error" },
    probe,
    error_code: errCode,
    provider: lease.provider_kind,
  }) as Record<string, unknown>;

  // ---- Phase C: fenced outcome ----
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock();
    const current = (await lockLease(tx, lease.id)) as LeaseRow;
    await fence(tx, job);
    const delay = retryDelaySeconds(attemptNo, ctx.settings.retryBaseSeconds, ctx.settings.retryCapSeconds);
    const next = verified ? null : new Date(now.getTime() + delay * 1000);
    await tx.query(
      `INSERT INTO revocation_attempts (id, workspace_id, lease_id, attempt_no, attempted_at, result, verification_ref, detail, next_retry_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId(), current.workspace_id, current.id, attemptNo, now, result, verificationRef, JSON.stringify(detail), next],
    );
    if (verified) {
      await transition(tx, current, "REVOKED_VERIFIED", {
        at: now,
        actorRef: ACTOR,
        action: "revocation.verified",
        patch: { revoked_at: now, last_verified_at: now, next_retry_at: null },
        metadata: { attempt_no: attemptNo, verification_ref: verificationRef, reason: current.close_reason },
      });
      await tx.query("UPDATE provider_grants SET status = 'revoked', revoked_at = $2 WHERE lease_id = $1", [current.id, now]);
      // Secrets are purged once revocation is verified.
      await tx.query("UPDATE lease_secrets SET credential_ct = NULL, purged_at = COALESCE(purged_at, $2) WHERE lease_id = $1", [current.id, now]);
      await markDone(tx, job, now);
      return "verified";
    }
    await transition(tx, current, "REVOCATION_UNCONFIRMED", {
      at: now,
      actorRef: ACTOR,
      action: "revocation.unconfirmed",
      patch: { next_retry_at: next },
      emit: current.state === "REVOKING",
      metadata: { attempt_no: attemptNo, result, verification_ref: verificationRef, error_code: errCode, next_retry_at: next?.toISOString() },
    });
    await requeue(tx, job, { at: now, delaySeconds: delay, error: errCode ?? "unverified" });
    await audit(tx, { workspaceId: current.workspace_id, leaseId: current.id, actorRef: ACTOR, action: "revocation.retry_scheduled", at: now, metadata: { attempt_no: attemptNo, delay_seconds: delay } });
    return "unconfirmed";
  });
}
