import { ProviderRejectedError, type IssueResult, type Provider } from "../connectors/provider.js";
import type { Ctx } from "../context.js";
import type { Queryable } from "../db/index.js";
import type { CloseReason } from "../domain/types.js";
import { newId } from "../lib/ids.js";
import { withDeadline } from "./deadline.js";
import { redactDeep, registerSecret } from "../lib/redact.js";
import { audit } from "../services/audit.js";
import { fence, type Job, markDone, requeue, retryDelaySeconds } from "../services/jobs.js";
import { lockLease, startRevocation, transition } from "../services/lifecycle.js";
import { computePlanHash } from "../services/policy.js";
import type { LeaseRow } from "../services/rows.js";

const ACTOR = "system:worker";

export type IssueOutcome = "issued" | "adopted" | "refused" | "unknown" | "retry" | "skipped";

interface Plan {
  lease: LeaseRow;
  provider: Provider;
  /** `reconcile`: the outcome of a previous attempt is uncertain, so look the grant up before writing. */
  mode: "issue" | "reconcile";
  secret: string;
}

/** Credential secret derived from the operator key and the lease id: a retry or reconciliation reuses it. */
export const credentialSecretFor = (ctx: Ctx, leaseId: string): string => ctx.key.derive("credential", leaseId, 40);

async function refuse(tx: Queryable, ctx: Ctx, job: Job, lease: LeaseRow, reason: CloseReason, detail: string): Promise<IssueOutcome> {
  const now = ctx.clock();
  await startRevocation(tx, lease, { reason, detail, at: now, actorRef: ACTOR, action: `issue.refused_${reason}` });
  await markDone(tx, job, now);
  return "refused";
}

/**
 * Issue (and reconcile) one lease. Phases:
 *   A. fenced transaction: validate approval/plan/policy/expiry, enter ISSUING (or ISSUE_UNKNOWN reconciliation);
 *   B. provider call outside any transaction (idempotent by deterministic provider reference);
 *   C. fenced transaction: record the outcome (ACTIVE, ISSUE_UNKNOWN, or cleanup via REVOKING).
 * A crash between A and C leaves the lease ISSUING; the reclaimed job treats that as an uncertain outcome and
 * reconciles by lookup instead of assuming anything (AC-13).
 */
export async function processIssue(ctx: Ctx, job: Job): Promise<IssueOutcome> {
  const plan = await ctx.db.transaction<Plan | IssueOutcome>(async (tx) => {
    const now = ctx.clock();
    // Lock order everywhere: lease, then job, then workspace (event sequence). The foreign key guarantees the lease exists
    // for as long as its job does.
    const lease = (await lockLease(tx, job.lease_id)) as LeaseRow;
    await fence(tx, job);
    if (!["APPROVED", "ISSUING", "ISSUE_UNKNOWN"].includes(lease.state)) {
      await markDone(tx, job, now);
      return "skipped";
    }
    if (lease.expires_at.getTime() <= now.getTime()) return refuse(tx, ctx, job, lease, "expired", "lease expired before issuance");
    // One round trip for the approval and the current policy hash.
    const checks = (
      await tx.query<{ approval_plan_hash: string | null; approval_expires_at: Date | null; current_policy_hash: string }>(
        `SELECT a.plan_hash AS approval_plan_hash, a.expires_at AS approval_expires_at, p.policy_hash AS current_policy_hash
           FROM policies p LEFT JOIN approvals a ON a.lease_id = $1 WHERE p.workspace_id = $2`,
        [lease.id, lease.workspace_id],
      )
    ).rows[0] as { approval_plan_hash: string | null; approval_expires_at: Date | null; current_policy_hash: string };
    const recomputed = computePlanHash({ ...lease, expires_at: lease.expires_at });
    if (checks.approval_plan_hash === null || checks.approval_plan_hash !== lease.plan_hash || recomputed !== lease.plan_hash) {
      return refuse(tx, ctx, job, lease, "plan_mismatch", "stored lease does not match its approved plan");
    }
    if (checks.current_policy_hash !== lease.policy_hash) return refuse(tx, ctx, job, lease, "plan_mismatch", "workspace policy changed after approval");
    if ((checks.approval_expires_at as Date).getTime() <= now.getTime()) return refuse(tx, ctx, job, lease, "approval_expired", "approval expired before issuance");
    const provider = ctx.providers.get(lease.provider_kind);
    if (!provider) {
      // No provider call is possible, so nothing is uncertain: stay put and retry visibly (AC-08: explicit failure).
      await requeue(tx, job, { at: now, delaySeconds: retryDelaySeconds(job.attempt, ctx.settings.retryBaseSeconds, ctx.settings.retryCapSeconds), error: "provider_disconnected" });
      return "retry";
    }
    if (!provider.capabilities().nativeTtl) return refuse(tx, ctx, job, lease, "issue_failed", "provider has no native TTL; refusing to issue (AC-03)");
    let current = lease;
    let mode: Plan["mode"] = "issue";
    if (lease.state === "APPROVED") {
      current = await transition(tx, lease, "ISSUING", { at: now, actorRef: ACTOR, action: "issue.started", metadata: { attempt: job.attempt } });
    } else {
      mode = "reconcile";
      if (lease.state === "ISSUING") {
        current = await transition(tx, lease, "ISSUE_UNKNOWN", {
          at: now,
          actorRef: ACTOR,
          action: "issue.interrupted",
          patch: { next_retry_at: now },
          metadata: { attempt: job.attempt, note: "a previous attempt did not record its outcome; reconciling by provider lookup" },
        });
      }
    }
    const secret = credentialSecretFor(ctx, lease.id);
    registerSecret(secret);
    await tx.query(
      `WITH g AS (
         INSERT INTO provider_grants (id, workspace_id, lease_id, provider_kind, provider_ref, status, created_at)
         VALUES ($6, $1, $2, $3, $4, 'pending', $5) ON CONFLICT (lease_id) DO NOTHING)
       INSERT INTO lease_secrets (lease_id, workspace_id, credential_ct, created_at) VALUES ($2, $1, $7, $5) ON CONFLICT (lease_id) DO NOTHING`,
      [lease.workspace_id, lease.id, lease.provider_kind, provider.providerRefFor(lease.id), now, newId(), ctx.key.encrypt(`credential:${lease.id}`, secret)],
    );
    return { lease: current, provider, mode, secret };
  });
  if (typeof plan === "string") return plan;

  // ---- Phase B: provider call(s), no transaction held ----
  const { lease, provider, secret } = plan;
  const target = { leaseId: lease.id, resource: lease.resource_ref };
  let lookupState: string | null = null;
  let outcome: { kind: "ok"; result: IssueResult } | { kind: "rejected"; code: string } | { kind: "unknown"; code: string };
  try {
    if (plan.mode === "reconcile") {
      const found = await withDeadline(ctx.settings.providerCallTimeoutMs, () => provider.lookup(target));
      lookupState = found.state;
      if (found.state === "unknown") throw Object.assign(new Error("lookup unknown"), { code: "lookup_unknown" });
    }
    outcome = {
      kind: "ok",
      result: await withDeadline(ctx.settings.providerCallTimeoutMs, () => provider.issue({
        ...target,
        attempt: job.attempt,
        subject: lease.subject_ref,
        scopes: lease.scopes,
        expiresAt: lease.expires_at,
        credentialSecret: secret,
      })),
    };
  } catch (error) {
    outcome = error instanceof ProviderRejectedError ? { kind: "rejected", code: error.code } : { kind: "unknown", code: (error as { code?: string }).code ?? "provider_error" };
  }

  // ---- Phase C: fenced outcome ----
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock();
    const lease2 = (await lockLease(tx, lease.id)) as LeaseRow;
    await fence(tx, job);
    if (outcome.kind === "ok") {
      const r = outcome.result;
      await tx.query(
        `UPDATE provider_grants SET status = 'issued', issued_at = COALESCE(issued_at, $2), valid_until = $3, provider_ref = $4,
                conn_host = $5, conn_port = $6, conn_database = $7, conn_username = $8 WHERE lease_id = $1`,
        [lease.id, now, r.validUntil, r.providerRef, r.connection.host, r.connection.port, r.connection.database, r.connection.username],
      );
      if (lease2.state === "ISSUING" || lease2.state === "ISSUE_UNKNOWN") {
        await transition(tx, lease2, "ACTIVE", {
          at: now,
          actorRef: ACTOR,
          action: plan.mode === "reconcile" ? "issue.reconciled" : "issue.completed",
          patch: { issued_at: now, next_retry_at: null },
          metadata: { already_existed: r.alreadyExisted, lookup_state: lookupState, provider_ref: r.providerRef },
        });
      } else {
        await audit(tx, { workspaceId: lease2.workspace_id, leaseId: lease2.id, actorRef: ACTOR, action: "issue.completed_after_close", at: now, metadata: { state: lease2.state } });
      }
      await markDone(tx, job, now);
      return plan.mode === "reconcile" && r.alreadyExisted ? "adopted" : "issued";
    }
    if (outcome.kind === "rejected") {
      if (lease2.state === "ISSUING" || lease2.state === "ISSUE_UNKNOWN") {
        await startRevocation(tx, lease2, { reason: "issue_failed", detail: `provider rejected: ${outcome.code}`, at: now, actorRef: ACTOR, action: "issue.rejected", metadata: { code: outcome.code } });
      }
      await markDone(tx, job, now);
      return "refused";
    }
    // Unknown outcome: the provider may or may not hold a grant. Keep it visible and reconcile; never re-issue blindly.
    const delay = retryDelaySeconds(job.attempt, ctx.settings.retryBaseSeconds, ctx.settings.retryCapSeconds);
    const next = new Date(now.getTime() + delay * 1000);
    if (lease2.state === "ISSUING" || lease2.state === "ISSUE_UNKNOWN") {
      await transition(tx, lease2, "ISSUE_UNKNOWN", {
        at: now,
        actorRef: ACTOR,
        action: lease2.state === "ISSUING" ? "issue.unknown" : "issue.reconcile_retry",
        patch: { next_retry_at: next },
        emit: lease2.state === "ISSUING",
        metadata: { code: outcome.code, lookup_state: lookupState },
      });
    }
    await requeue(tx, job, { at: now, delaySeconds: delay, error: outcome.code, type: "reconcile" });
    return "unknown";
  });
}

/** Redacted description of an outcome for logs. */
export const describeOutcome = (outcome: IssueOutcome, job: Job) => redactDeep({ event: "job.issue", outcome, job_id: job.id, lease_id: job.lease_id, attempt: job.attempt });
