import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/context.js";
import { AppError } from "../../../src/errors.js";
import { claimJob, fence, LeaseLostError, markDone } from "../../../src/services/jobs.js";
import { closeLease, getLease, listLeases, requestLease, retrieveCredential, revokeLease } from "../../../src/services/leases.js";
import { pullEvents } from "../../../src/services/events.js";
import { runWorkerOnce, sweepOverdue } from "../../../src/workers/index.js";
import { credentialSecretFor } from "../../../src/workers/issue.js";
import { drive, type Env, goodRequest, iso, leaseRow, makeEnv, requestApprove } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => {
  await env.drop();
});

async function rejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the call to be rejected");
}

const actions = async (leaseId: string) =>
  (await env.ctx.db.query<{ action: string }>("SELECT action FROM audit_events WHERE lease_id = $1 ORDER BY seq", [leaseId])).rows.map((r) => r.action);

describe("issuance and credential delivery", () => {
  it("approve -> issue -> ACTIVE with a provider-enforced expiry, one-time credential, then expiry revokes and verifies", async () => {
    const approved = await requestApprove(env, { task_ref: "happy" });
    expect(approved.state).toBe("approved");
    const report = await drive(env);
    expect(report.unresolved).toEqual({ issueUnknown: 0, revocationUnconfirmed: 0 });
    let detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("active");
    expect(detail.credential_available).toBe(true);
    expect(detail.provider_grant?.status).toBe("issued");
    expect(detail.provider_grant?.valid_until).toBe(detail.expires_at);
    expect(env.provider.hasGrant(approved.id)).toBe(true);

    const credential = await retrieveCredential(env.ctx, env.operator, approved.id);
    expect(credential.provider.label).toBe("SYNTHETIC");
    expect(credential.credential.secret).toBe(credentialSecretFor(env.ctx, approved.id));
    expect(credential.credential.username).toBe(env.provider.providerRefFor(approved.id));
    expect((await rejects(retrieveCredential(env.ctx, env.operator, approved.id))).code).toBe("credential_already_retrieved");
    expect((await rejects(retrieveCredential(env.ctx, env.viewer, approved.id))).status).toBe(403);
    detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.credential_available).toBe(false);
    const secretRow = (await env.ctx.db.query("SELECT credential_ct FROM lease_secrets WHERE lease_id = $1", [approved.id])).rows[0] as { credential_ct: string | null };
    expect(secretRow.credential_ct).toBeNull();
    // the secret is nowhere in the audit trail, the detail or the logs
    const blob = JSON.stringify(detail) + env.logs.join("\n") + JSON.stringify((await env.ctx.db.query("SELECT redacted_metadata FROM audit_events")).rows);
    expect(blob).not.toContain(credential.credential.secret);

    // a session opened during the lease; native TTL ends new logins at expiry but not the open session
    expect(env.provider.openSession(approved.id, credential.credential.secret)).toBe(true);
    env.clock.advance(601);
    expect(env.provider.openSession(approved.id, credential.credential.secret)).toBe(false);
    expect(env.provider.sessionCount(approved.id)).toBe(1);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("active");
    const swept = await runWorkerOnce(env.ctx, { workerId: "w" });
    expect(swept.sweep.expiredToRevoking).toBe(1);
    expect(swept.verified).toBe(1);
    detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.revocation_status).toBe("verified");
    expect(detail.close_reason).toBe("expired");
    expect(detail.last_verified_at).not.toBeNull();
    expect(detail.revoked_at).not.toBeNull();
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ result: "verified", verification_ref: "introspection:absent+probe:denied" });
    expect(detail.attempts[0]?.detail).toMatchObject({ sessions_terminated: 1 });
    expect(env.provider.hasGrant(approved.id)).toBe(false);
    expect(await actions(approved.id)).toEqual(expect.arrayContaining(["lease.requested", "lease.approved", "issue.started", "issue.completed", "credential.retrieved", "sweep.expired", "revocation.verified"]));
  });

  it("credential retrieval is only possible while ACTIVE", async () => {
    const approved = await requestApprove(env, { task_ref: "cred-state" });
    expect((await rejects(retrieveCredential(env.ctx, env.operator, approved.id))).code).toBe("credential_unavailable");
    expect((await rejects(retrieveCredential(env.ctx, env.operator, "nope"))).status).toBe(404);
    await drive(env);
    await closeLease(env.ctx, env.operator, approved.id, { reason: "done" });
    expect((await rejects(retrieveCredential(env.ctx, env.operator, approved.id))).code).toBe("credential_unavailable");
    await drive(env);
  });
});

describe("AC-03 issue ambiguity enters ISSUE_UNKNOWN and reconciles without duplicates", () => {
  it("ambiguous issue (applied, answer lost): ISSUE_UNKNOWN with warning, then reconciled to ACTIVE with exactly one grant", async () => {
    const before = env.provider.grantCount();
    env.provider.faults.next("issue", "ambiguous");
    const approved = await requestApprove(env, { task_ref: "ambiguous" });
    const report = await drive(env);
    expect(report.unresolved.issueUnknown).toBe(1);
    let detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("issue_unknown");
    expect(detail.warning).toContain("WARNING");
    expect(detail.next_retry_at).not.toBeNull();
    expect(detail.revocation_status).toBe("none");
    expect(env.provider.grantCount()).toBe(before + 1);
    env.clock.advance(6);
    await drive(env);
    detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("active");
    expect(env.provider.grantCount()).toBe(before + 1);
    expect(await actions(approved.id)).toEqual(expect.arrayContaining(["issue.unknown", "issue.reconciled"]));
    const refs = env.provider.calls.filter((c) => c.op === "issue" && c.ref === env.provider.providerRefFor(approved.id));
    expect(refs.length).toBe(2);
  });

  it("timeout before any effect: reconciliation finds nothing and issues once by the same deterministic reference", async () => {
    const before = env.provider.grantCount();
    env.provider.faults.next("issue", "timeout");
    const approved = await requestApprove(env, { task_ref: "timeout" });
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("issue_unknown");
    expect(env.provider.grantCount()).toBe(before);
    env.clock.advance(6);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("active");
    expect(env.provider.grantCount()).toBe(before + 1);
  });

  it("lookup outage during reconciliation keeps the lease ISSUE_UNKNOWN with growing backoff and never issues blindly", async () => {
    env.provider.faults.next("issue", "timeout");
    const approved = await requestApprove(env, { task_ref: "recon-outage" });
    await drive(env);
    env.provider.faults.always("lookup", "outage");
    const issueCalls = () => env.provider.calls.filter((c) => c.op === "issue").length;
    const baseline = issueCalls();
    env.clock.advance(6);
    await drive(env);
    const first = await getLease(env.ctx, env.viewer, approved.id);
    expect(first.state).toBe("issue_unknown");
    env.clock.advance(11);
    await drive(env);
    const second = await getLease(env.ctx, env.viewer, approved.id);
    expect(second.state).toBe("issue_unknown");
    expect(Date.parse(second.next_retry_at as string)).toBeGreaterThan(Date.parse(first.next_retry_at as string));
    expect(issueCalls()).toBe(baseline);
    env.provider.faults.clear("lookup");
    env.clock.advance(30);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("active");
  });

  it("a definite provider rejection creates no grant and closes through REVOKING with issue_failed", async () => {
    const before = env.provider.grantCount();
    env.provider.faults.next("issue", "reject");
    const approved = await requestApprove(env, { task_ref: "rejected" });
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.close_reason).toBe("issue_failed");
    expect(env.provider.grantCount()).toBe(before);
  });

  it("an ISSUE_UNKNOWN lease that expires is revoked and any orphan grant is removed", async () => {
    env.provider.faults.next("issue", "ambiguous");
    const approved = await requestApprove(env, { task_ref: "orphan" }, 120);
    await drive(env);
    env.provider.faults.always("lookup", "outage");
    expect(env.provider.hasGrant(approved.id)).toBe(true);
    env.clock.advance(130);
    await drive(env);
    // lookup outage during revoke verification => unconfirmed, not green
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("revocation_unconfirmed");
    env.provider.faults.clear();
    env.clock.advance(400);
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("revoked_verified");
    expect(env.provider.hasGrant(approved.id)).toBe(false);
  });
});

describe("AC-04/AC-05 revocation, verification and outage", () => {
  async function activeLease(task: string, ttl = 600) {
    const approved = await requestApprove(env, { task_ref: task }, ttl);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("active");
    return approved;
  }

  it("provider outage leaves REVOCATION_UNCONFIRMED with next retry and a visible warning; it recovers with backoff", async () => {
    const lease = await activeLease("outage");
    env.provider.faults.always("revoke", "outage");
    env.provider.faults.always("lookup", "outage");
    const requested = await revokeLease(env.ctx, env.operator, lease.id, { reason: "operator says stop" });
    expect(requested.http_status).toBe(202);
    expect(requested.state).toBe("revoking");
    let report = await drive(env);
    expect(report.unresolved.revocationUnconfirmed).toBeGreaterThanOrEqual(1);
    let detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.state).toBe("revocation_unconfirmed");
    expect(detail.revocation_status).toBe("unconfirmed");
    expect(detail.warning).toContain("NOT verified");
    expect(detail.last_verified_at).toBeNull();
    expect(detail.revoked_at).toBeNull();
    expect(detail.next_retry_at).toBe(iso(env.clock, 5));
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ attempt_no: 1, result: "provider_error" });
    expect(env.provider.hasGrant(lease.id)).toBe(true);
    // not yet due: no new attempt
    env.clock.advance(3);
    report = await drive(env);
    expect(report.revokeAttempts).toBe(0);
    env.clock.advance(3);
    await drive(env);
    detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.attempts).toHaveLength(2);
    expect(detail.state).toBe("revocation_unconfirmed");
    expect(Date.parse(detail.next_retry_at as string)).toBe(env.clock().getTime() + 10_000);
    env.provider.faults.clear();
    env.clock.advance(11);
    await drive(env);
    detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.attempts.map((a) => a.attempt_no)).toEqual([1, 2, 3]);
    expect(detail.attempts.map((a) => a.result)).toEqual(["provider_error", "provider_error", "verified"]);
    expect(env.provider.hasGrant(lease.id)).toBe(false);
  });

  it.each([
    ["stale introspection", "lookup", "stale_introspection"],
    ["unknown denied-use probe", "probe", "probe_unknown"],
    ["partial revoke (session survives)", "revoke", "partial_revoke"],
  ] as const)("%s is unverified and never green; the retry verifies", async (_name, op, fault) => {
    const lease = await activeLease(`unverified-${op}`);
    env.provider.openSession(lease.id, credentialSecretFor(env.ctx, lease.id));
    env.provider.faults.next(op, fault);
    await closeLease(env.ctx, env.operator, lease.id, { reason: "task done" });
    await drive(env);
    let detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.state).toBe("revocation_unconfirmed");
    expect(detail.attempts[0]?.result).toBe("unverified");
    expect(detail.close_reason).toBe("task_closed");
    env.clock.advance(6);
    await drive(env);
    detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.attempts).toHaveLength(2);
  });

  it("expiry without a worker never produces a verified state (expired is not revoked)", async () => {
    const lease = await activeLease("time-only", 120);
    env.clock.advance(500);
    const detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.state).toBe("active");
    expect(detail.revocation_status).toBe("none");
    await drive(env);
  });

  it("the database refuses transitions that would fake verification", async () => {
    const lease = await activeLease("db-guard");
    await expect(env.ctx.db.query("UPDATE leases SET state = 'REVOKED_VERIFIED', last_verified_at = now(), revoked_at = now() WHERE id = $1", [lease.id])).rejects.toThrow(/invalid lease transition/);
    await revokeLease(env.ctx, env.operator, lease.id, { reason: "x" });
    await expect(env.ctx.db.query("UPDATE leases SET state = 'REVOKED_VERIFIED' WHERE id = $1", [lease.id])).rejects.toThrow(/verification timestamp/);
    await expect(env.ctx.db.query("UPDATE leases SET scopes = '[\"synthetic:x:read\"]' WHERE id = $1", [lease.id])).rejects.toThrow(/immutable/);
    await drive(env);
    await expect(env.ctx.db.query("UPDATE leases SET close_reason = 'expired' WHERE id = $1", [lease.id])).rejects.toThrow(/final/);
    await expect(env.ctx.db.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(env.ctx.db.query("DELETE FROM revocation_attempts")).rejects.toThrow(/append-only/);
    await expect(env.ctx.db.query("DELETE FROM events")).rejects.toThrow(/append-only/);
  });

  it("revoking a never-issued lease verifies only after the provider shows no grant", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "never" }));
    await revokeLease(env.ctx, env.operator, created.id, { reason: "changed my mind" });
    const detail0 = await getLease(env.ctx, env.viewer, created.id);
    expect(detail0.state).toBe("revoking");
    expect(detail0.warning).toContain("Not yet verified");
    env.provider.faults.always("lookup", "outage");
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, created.id)).state).toBe("revocation_unconfirmed");
    env.provider.faults.clear();
    env.clock.advance(6);
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, created.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.close_reason).toBe("operator_revoked");
    expect(detail.provider_grant).toBeNull();
  });

  it("revoke is idempotent, retries immediately on UNCONFIRMED, and is role/workspace scoped", async () => {
    const lease = await activeLease("revoke-idem");
    env.provider.faults.always("revoke", "outage");
    const first = await revokeLease(env.ctx, env.operator, lease.id, { reason: "r" });
    const again = await revokeLease(env.ctx, env.operator, lease.id, { reason: "r" });
    expect(again.state).toBe(first.state);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, lease.id)).state).toBe("revocation_unconfirmed");
    env.provider.faults.clear();
    const retry = await revokeLease(env.ctx, env.operator, lease.id, { reason: "retry now" });
    expect(retry.state).toBe("revocation_unconfirmed");
    await drive(env); // no clock advance needed: the operator asked for an immediate retry
    expect((await getLease(env.ctx, env.viewer, lease.id)).state).toBe("revoked_verified");
    const done = await revokeLease(env.ctx, env.operator, lease.id, { reason: "again" });
    expect(done.state).toBe("revoked_verified");
    expect((await rejects(revokeLease(env.ctx, env.viewer, lease.id, { reason: "r" }))).status).toBe(403);
    expect((await rejects(revokeLease(env.ctx, env.other.operator, lease.id, { reason: "r" }))).status).toBe(404);
    expect((await rejects(closeLease(env.ctx, env.other.operator, lease.id, {}))).status).toBe(404);
    expect((await rejects(revokeLease(env.ctx, env.operator, lease.id, { reason: "" }))).status).toBe(422);
    expect((await rejects(revokeLease(env.ctx, env.operator, lease.id, { reason: "r", expected_version: 999 }))).code).toBe("version_conflict");
  });

  it("an unconfigured provider is an explicit visible failure, not silence", async () => {
    const lease = await activeLease("disconnected");
    const saved = env.ctx.providers.get("synthetic");
    // simulate a deployment whose provider disappeared
    (env.ctx.providers as unknown as { providers: Map<string, unknown> }).providers.delete("synthetic");
    await revokeLease(env.ctx, env.operator, lease.id, { reason: "x" });
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, lease.id);
    expect(detail.state).toBe("revocation_unconfirmed");
    expect(detail.attempts[0]?.detail).toMatchObject({ error_code: "provider_disconnected" });
    (env.ctx.providers as unknown as { register(p: unknown): void }).register(saved);
    env.clock.advance(10);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, lease.id)).state).toBe("revoked_verified");
  });
});

describe("AC-06 restart sweep and issuance ordering", () => {
  it("sweeps overdue leases before any new issuance; the retry identifies the same grant", async () => {
    const overdue = await requestApprove(env, { task_ref: "overdue" }, 120);
    await drive(env);
    expect(env.provider.hasGrant(overdue.id)).toBe(true);
    // scheduler downtime: the lease expires while no worker runs, a new approved lease is waiting
    env.clock.advance(3600);
    const fresh = await requestApprove(env, { task_ref: "after-downtime" }, 600);
    const claimable = await claimJob(env.ctx.db, "probe-worker", env.clock, 120);
    // the only claimable job is a revoke job or nothing: the issue job is blocked while a lease is overdue and un-swept
    expect(claimable === null || claimable.type !== "issue").toBe(true);
    if (claimable) await env.ctx.db.query("UPDATE jobs SET state = 'queued', lease_until = NULL, locked_by = NULL WHERE id = $1", [claimable.id]);
    const report = await runWorkerOnce(env.ctx, { workerId: "restart-worker" });
    expect(report.sweep.expiredToRevoking).toBeGreaterThanOrEqual(1);
    expect(report.sweep.overdueRecovered).toBeGreaterThanOrEqual(1);
    await drive(env);
    const sweepSeq = (await env.ctx.db.query<{ seq: number }>("SELECT seq FROM audit_events WHERE lease_id = $1 AND action = 'sweep.expired'", [overdue.id])).rows[0]?.seq as number;
    const issueSeq = (await env.ctx.db.query<{ seq: number }>("SELECT seq FROM audit_events WHERE lease_id = $1 AND action = 'issue.started'", [fresh.id])).rows[0]?.seq as number;
    expect(sweepSeq).toBeLessThan(issueSeq);
    expect((await getLease(env.ctx, env.viewer, overdue.id)).state).toBe("revoked_verified");
    expect((await getLease(env.ctx, env.viewer, fresh.id)).state).toBe("active");
  });

  it("closes requests that expired before approval or issuance", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "stale-request", expires_at: iso(env.clock, 100) }));
    env.clock.advance(200);
    const report = await sweepOverdue(env.ctx);
    expect(report.staleRequestsClosed).toBeGreaterThanOrEqual(1);
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, created.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.close_reason).toBe("expired");
  });
});

describe("AC-13 job leases, fencing and restart recovery", () => {
  it("a restarted worker reclaims a job whose lease expired", async () => {
    const approved = await requestApprove(env, { task_ref: "reclaim" });
    const claimed = await claimJob(env.ctx.db, "dead-worker", env.clock, 120);
    expect(claimed?.lease_id).toBe(approved.id);
    env.clock.advance(121);
    const report = await runWorkerOnce(env.ctx, { workerId: "new-worker" });
    expect(report.sweep.jobsReclaimed).toBe(1);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("active");
  });

  it("an ISSUING lease whose worker died is reconciled by lookup and adopts the existing grant", async () => {
    const approved = await requestApprove(env, { task_ref: "interrupted" });
    // simulate: worker moved the lease to ISSUING, the provider applied the grant, the worker died before recording
    await env.ctx.db.query("UPDATE leases SET state = 'ISSUING', version = version + 1 WHERE id = $1", [approved.id]);
    const row = await leaseRow(env, approved.id);
    env.provider.seedGrant({
      leaseId: approved.id,
      resource: row.resource_ref,
      attempt: 1,
      subject: row.subject_ref,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      credentialSecret: credentialSecretFor(env.ctx, approved.id),
    });
    const before = env.provider.grantCount();
    await claimJob(env.ctx.db, "dead-worker", env.clock, 120);
    env.clock.advance(121);
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("active");
    expect(env.provider.grantCount()).toBe(before);
    expect(await actions(approved.id)).toEqual(expect.arrayContaining(["issue.interrupted", "issue.reconciled"]));
  });

  it("fenced completion: a stale worker cannot commit after another worker took the job", async () => {
    const approved = await requestApprove(env, { task_ref: "fenced" });
    const first = await claimJob(env.ctx.db, "worker-a", env.clock, 10);
    expect(first).not.toBeNull();
    env.clock.advance(11);
    const second = await claimJob(env.ctx.db, "worker-b", env.clock, 10);
    expect(second?.id).toBe(first?.id);
    expect(second?.attempt).toBe((first?.attempt ?? 0) + 1);
    await expect(env.ctx.db.transaction((tx) => fence(tx, first as NonNullable<typeof first>))).rejects.toBeInstanceOf(LeaseLostError);
    await env.ctx.db.transaction(async (tx) => {
      await fence(tx, second as NonNullable<typeof second>);
      await markDone(tx, second as NonNullable<typeof second>, env.clock());
    });
    // the lease still needs issuing (we only marked the job done); just clean up
    await revokeLease(env.ctx, env.operator, approved.id, { reason: "cleanup" });
    await drive(env);
  });

  it("claims are bounded per pass", async () => {
    const bounded = await makeEnv({ settings: { maxJobsPerPass: 2 } });
    try {
      for (let i = 0; i < 5; i += 1) await requestApprove(bounded, { task_ref: `bounded-${i}` });
      const pass = await runWorkerOnce(bounded.ctx, { workerId: "w" });
      expect(pass.jobsProcessed).toBe(2);
      const next = await runWorkerOnce(bounded.ctx, { workerId: "w" });
      expect(next.jobsProcessed).toBe(2);
    } finally {
      await bounded.drop();
    }
  });

  it("jobs of one lease run one at a time and revoke queued behind an in-flight issue waits", async () => {
    const approved = await requestApprove(env, { task_ref: "serial" });
    const issue = await claimJob(env.ctx.db, "worker-a", env.clock, 120);
    expect(issue?.type).toBe("issue");
    await revokeLease(env.ctx, env.operator, approved.id, { reason: "race" });
    const blocked = await claimJob(env.ctx.db, "worker-b", env.clock, 120);
    expect(blocked).toBeNull();
    await env.ctx.db.query("UPDATE jobs SET state = 'queued', lease_until = NULL, locked_by = NULL WHERE id = $1", [issue?.id]);
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.state).toBe("revoked_verified");
    expect(env.provider.hasGrant(approved.id)).toBe(false);
  });

  it("unexpected processing errors keep the job with a visible error instead of losing it", async () => {
    const approved = await requestApprove(env, { task_ref: "boom" });
    const original = env.provider.issue.bind(env.provider);
    env.provider.issue = async () => {
      throw new Error("kaboom: should not leak");
    };
    await drive(env);
    // an unexpected error from the provider is an unknown outcome
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("issue_unknown");
    env.provider.issue = original;
    env.clock.advance(30);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, approved.id)).state).toBe("active");
    expect(env.logs.join("\n")).not.toContain("kaboom");
  });
});

describe("tampered plans never issue (defense in depth)", () => {
  it("refuses issuance when the stored lease no longer matches the approved plan", async () => {
    const approved = await requestApprove(env, { task_ref: "tamper" });
    // bypass the immutability trigger as a superuser would (e.g. a hostile restore)
    await env.ctx.db.transaction(async (tx) => {
      await tx.query("SET LOCAL session_replication_role = replica");
      await tx.query(`UPDATE leases SET scopes = '["synthetic:other:write"]' WHERE id = $1`, [approved.id]);
    });
    const before = env.provider.grantCount();
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, approved.id);
    expect(detail.close_reason).toBe("plan_mismatch");
    expect(detail.state).toBe("revoked_verified");
    expect(env.provider.grantCount()).toBe(before);
  });

  it("refuses issuance when the policy changed after approval", async () => {
    const approved = await requestApprove(env, { task_ref: "policy-drift" });
    await env.ctx.db.query("UPDATE policies SET policy_hash = 'changed' WHERE workspace_id = $1", [env.workspaceId]);
    await drive(env);
    expect((await getLease(env.ctx, env.viewer, approved.id)).close_reason).toBe("plan_mismatch");
    await env.ctx.db.query("UPDATE policies SET policy_hash = (SELECT l.policy_hash FROM leases l WHERE l.id = $2) WHERE workspace_id = $1", [env.workspaceId, approved.id]);
  });
});

describe("events, pagination and isolation", () => {
  it("writes versioned outbox events in the state-change transaction and pulls them with a cursor", async () => {
    const isolated = await makeEnv();
    try {
      const lease = await requestApprove(isolated, { task_ref: "events" });
      await drive(isolated);
      await closeLease(isolated.ctx, isolated.operator, lease.id, { reason: "done" });
      await drive(isolated);
      const page1 = await pullEvents(isolated.ctx, isolated.viewer, { limit: 3 });
      expect(page1.items).toHaveLength(3);
      const page2 = await pullEvents(isolated.ctx, isolated.viewer, { after: page1.next_cursor, limit: 100 });
      const all = [...page1.items, ...page2.items];
      expect(all.map((e) => e.event_type)).toEqual([
        "lease.requested",
        "lease.approved",
        "lease.issuing",
        "lease.active",
        "lease.revoking",
        "lease.revoked_verified",
      ]);
      expect(all.map((e) => e.revision)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(all[0]).toMatchObject({ schema_version: 1, source: "accesslease", resource_id: lease.id, evidence_ref: `lease:${lease.id}@1` });
      expect(new Set(all.map((e) => e.event_id)).size).toBe(6);
      const empty = await pullEvents(isolated.ctx, isolated.viewer, { after: page2.next_cursor });
      expect(empty.items).toEqual([]);
      expect(empty.next_cursor).toBe(page2.next_cursor);
      expect((await pullEvents(isolated.ctx, isolated.other.viewer)).items).toEqual([]);
      expect((await rejects(pullEvents(isolated.ctx, isolated.viewer, { after: "abc" }))).status).toBe(422);
      expect((await rejects(pullEvents(isolated.ctx, isolated.viewer, { limit: 0 }))).status).toBe(422);
      expect(JSON.stringify(all)).not.toContain(credentialSecretFor(isolated.ctx, lease.id));
    } finally {
      await isolated.drop();
    }
  });

  it("paginates leases newest first with an opaque cursor, caps at 100 and isolates workspaces", async () => {
    const isolated = await makeEnv();
    try {
      for (let i = 0; i < 5; i += 1) {
        await requestLease(isolated.ctx, isolated.operator, goodRequest({ task_ref: `page-${i}` }));
        isolated.clock.advance(1);
      }
      const p1 = await listLeases(isolated.ctx, isolated.viewer, { limit: 2 });
      expect(p1.items.map((l) => l.task_ref)).toEqual(["page-4", "page-3"]);
      expect(p1.next_cursor).not.toBeNull();
      const p2 = await listLeases(isolated.ctx, isolated.viewer, { limit: 2, cursor: p1.next_cursor as string });
      expect(p2.items.map((l) => l.task_ref)).toEqual(["page-2", "page-1"]);
      const p3 = await listLeases(isolated.ctx, isolated.viewer, { limit: 2, cursor: p2.next_cursor as string });
      expect(p3.items.map((l) => l.task_ref)).toEqual(["page-0"]);
      expect(p3.next_cursor).toBeNull();
      expect((await listLeases(isolated.ctx, isolated.viewer, { limit: 1000 })).items).toHaveLength(5);
      expect((await rejects(listLeases(isolated.ctx, isolated.viewer, { cursor: "garbage" }))).status).toBe(422);
      expect((await rejects(listLeases(isolated.ctx, isolated.viewer, { limit: 0 }))).status).toBe(422);
      expect((await listLeases(isolated.ctx, isolated.other.viewer)).items).toEqual([]);
      expect((await listLeases(isolated.ctx, isolated.viewer, { state: "active" })).items).toEqual([]);
      const foreign = p1.items[0]?.id as string;
      expect((await rejects(getLease(isolated.ctx, isolated.other.admin, foreign))).status).toBe(404);
      expect((await rejects(getLease(isolated.ctx, isolated.viewer, "bad"))).status).toBe(404);
    } finally {
      await isolated.drop();
    }
  });
});

describe("wire states are lowercase (decision: PRD example state:\"requested\")", () => {
  it("every API-facing document uses lowercase states while the database keeps UPPER_SNAKE", async () => {
    const e = await makeEnv();
    try {
      const lease = await requestApprove(e, { task_ref: "wire-case" });
      expect(lease.state).toBe("approved");
      await drive(e);
      const detail = await getLease(e.ctx, e.viewer, lease.id);
      expect(detail.state).toBe("active");
      expect((await leaseRow(e, lease.id)).state).toBe("ACTIVE");
      expect(detail.audit.map((a) => [a.metadata.from, a.metadata.to]).filter(([from]) => from)).toEqual([
        ["requested", "approved"],
        ["approved", "issuing"],
        ["issuing", "active"],
      ]);
      expect((await listLeases(e.ctx, e.viewer, { state: "active" })).items).toHaveLength(1);
      expect((await listLeases(e.ctx, e.viewer, { state: "ACTIVE" })).items).toHaveLength(1);
      expect((await listLeases(e.ctx, e.viewer, { state: "revoked_verified" })).items).toEqual([]);
      const { getReportData } = await import("../../../src/services/report.js");
      const report = await getReportData(e.ctx, e.viewer);
      expect(Object.keys(report.summary.by_state)).toEqual(["requested", "approved", "issuing", "active", "issue_unknown", "revoking", "revoked_verified", "revocation_unconfirmed"]);
      expect(report.summary.by_state.active).toBe(1);
      await closeLease(e.ctx, e.operator, lease.id, { reason: "done" });
      await drive(e);
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("revoked_verified");
    } finally {
      await e.drop();
    }
  });
});

describe("AC-03 provider-enforced TTL is required at request, approval and issuance (F-005)", () => {
  it("refuses a provider that stops reporting native TTL, with no issue job and no provider call", async () => {
    const e = await makeEnv();
    try {
      const honest = e.provider.capabilities.bind(e.provider);
      const lease = await requestLease(e.ctx, e.operator, goodRequest({ task_ref: "no-ttl-approve" }));
      e.provider.capabilities = () => ({ ...honest(), nativeTtl: false });
      await expect(requestLease(e.ctx, e.operator, goodRequest({ task_ref: "no-ttl-request" }))).rejects.toMatchObject({ status: 422, code: "provider_no_native_ttl" });
      await expect(approveLease(e.ctx, e.operator, lease.id, { plan_hash: lease.plan_hash })).rejects.toMatchObject({ status: 422, code: "provider_no_native_ttl" });
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("requested");
      expect((await e.ctx.db.query("SELECT 1 FROM jobs WHERE lease_id = $1", [lease.id])).rows).toHaveLength(0);
      // approved while honest, flipped before the worker runs: issuance is refused and closes through revoking
      e.provider.capabilities = honest;
      const approved = await requestApprove(e, { task_ref: "no-ttl-issue" });
      e.provider.capabilities = () => ({ ...honest(), nativeTtl: false });
      const calls = e.provider.calls.filter((c) => c.op === "issue").length;
      e.provider.capabilities = honest; // a provider must be honest to be registered; flip only for the worker pass below
      e.provider.capabilities = () => ({ ...honest(), nativeTtl: false });
      await drive(e);
      const detail = await getLease(e.ctx, e.viewer, approved.id);
      expect(detail.close_reason).toBe("issue_failed");
      expect(detail.state).toBe("revoked_verified");
      expect(e.provider.calls.filter((c) => c.op === "issue").length).toBe(calls);
      expect(e.provider.grantCount()).toBe(0);
    } finally {
      await e.drop();
    }
  });
});

describe("idempotency keys", () => {
  it("same key and body replays the receipt; a changed body is 409; keys are scoped by actor and route", async () => {
    const key = "idem-key-0001";
    const body = goodRequest({ task_ref: "idem", expires_at: iso(env.clock, 900) });
    const first = await requestLease(env.ctx, env.operator, body, { idempotencyKey: key });
    const second = await requestLease(env.ctx, env.operator, body, { idempotencyKey: key });
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    expect((await rejects(requestLease(env.ctx, env.operator, { ...body, task_ref: "different" }, { idempotencyKey: key }))).code).toBe("idempotency_conflict");
    const otherActor = await requestLease(env.ctx, env.admin, body, { idempotencyKey: key });
    expect(otherActor.id).not.toBe(first.id);
    const approved = await (await import("../../../src/services/leases.js")).approveLease(env.ctx, env.operator, first.id, { plan_hash: first.plan_hash }, { idempotencyKey: key });
    expect(approved.id).toBe(first.id);
    const replay = await (await import("../../../src/services/leases.js")).approveLease(env.ctx, env.operator, first.id, { plan_hash: first.plan_hash }, { idempotencyKey: key });
    expect(replay.replayed).toBe(true);
    expect(replay.state).toBe("approved");
    expect((await rejects(requestLease(env.ctx, env.operator, body, { idempotencyKey: "short" }))).status).toBe(422);
    const count = await env.ctx.db.query("SELECT 1 FROM leases WHERE task_ref = 'idem'");
    expect(count.rows).toHaveLength(2);
  });

  it("failed requests do not consume their key", async () => {
    const key = "idem-key-0002";
    await rejects(requestLease(env.ctx, env.operator, goodRequest({ scopes: ["*"] }), { idempotencyKey: key }));
    const ok = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "idem-ok" }), { idempotencyKey: key });
    expect(ok.state).toBe("requested");
  });

  it("purges keys after the retention window", async () => {
    const { purgeIdempotencyKeys } = await import("../../../src/services/idempotency.js");
    const future = fixedClock(env.clock());
    future.advance(9 * 86_400);
    expect(await purgeIdempotencyKeys(env.ctx.db, future())).toBeGreaterThan(0);
  });
});
