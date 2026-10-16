import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus } from "../helpers/clock.js";
import { planHash, providerRoleFor, sql, tableFingerprint } from "../helpers/oracle.js";
import { roleFacts } from "../helpers/db.js";

/** AC-02: approval is bound to the exact subject, resource, scopes and expiry; a changed request or an expired approval cannot issue access. */
export function approvalFreshness(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  const base = { task_ref: "TASK-AC02", subject_ref: "contractor-beta@example.invalid" };

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: true });
    ws = await h.workspace("ac02");
    resource = h.target!.database;
  });
  afterAll(async () => {
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  const lease = (over: Record<string, unknown> = {}) =>
    requestLease(h, ws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(h.clock!(), 2 * 3600), ...over });

  it("plan_hash matches an independent canonical-JSON SHA-256 over subject, resource, sorted scopes, expiry and policy", async () => {
    const created = await lease({ scopes: ["pg:app.records:select", "pg:app.records:insert", "pg:app.records:select"] });
    const policy = await h.client.get(ws.viewer.session, "/policy");
    expect(created.lease.scopes).toEqual(["pg:app.records:insert", "pg:app.records:select"]);
    expect(created.plan_hash).toBe(
      planHash({ task_ref: base.task_ref, subject_ref: base.subject_ref, resource_ref: resource, scopes: created.lease.scopes, expires_at: created.lease.expires_at, policy_hash: policy.body.policy_hash }),
    );
  });

  it("approves only with the exact plan_hash; a hash for any changed field is 409 plan_hash_mismatch with no state change", async () => {
    const created = await lease();
    const policy = (await h.client.get(ws.viewer.session, "/policy")).body;
    const fields = { task_ref: base.task_ref, subject_ref: base.subject_ref, resource_ref: resource, scopes: created.lease.scopes, expires_at: created.lease.expires_at, policy_hash: policy.policy_hash };
    const tampered = [
      planHash({ ...fields, subject_ref: "someone-else@example.invalid" }),
      planHash({ ...fields, resource_ref: "other_database" }),
      planHash({ ...fields, scopes: ["pg:app.records:select", "pg:app.records:insert"] }),
      planHash({ ...fields, expires_at: isoPlus(h.clock!(), 3 * 3600) }),
      "0".repeat(64),
    ];
    const before = await tableFingerprint(h.database.url, ["leases", "approvals", "jobs"]);
    for (const plan_hash of tampered) {
      const res = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("plan_hash_mismatch");
    }
    expect(await tableFingerprint(h.database.url, ["leases", "approvals", "jobs"])).toEqual(before);
    const ok = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect(ok.status).toBe(202);
    const detail = await getLease(h, ws.viewer.session, created.id);
    expect(detail.state).toBe("approved");
    expect(detail.approval?.expires_at).toBe(isoPlus(h.clock!(), 15 * 60));
  });

  it("an expired approval cannot issue: the worker closes the lease, no provider grant is ever created and no credential exists", async () => {
    const created = await lease();
    const approved = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect(approved.status).toBe(202);
    h.clock!.advance(15 * 60 + 1);
    await h.drain();
    const detail = await getLease(h, ws.operator.session, created.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.close_reason).toBe("approval_expired");
    expect(detail.issued_at).toBeNull();
    expect(detail.credential_available).toBe(false);
    const facts = await roleFacts(h.target!.clusterUrl, providerRoleFor(created.id));
    expect(facts.exists).toBe(false);
    const credential = await h.client.post(ws.operator.session, `/leases/${created.id}/credential`);
    expect(credential.status).toBe(409);
  });

  it("a request whose expiry is too near is 409 stale_plan at approval time and nothing is queued", async () => {
    const created = await lease({ expires_at: isoPlus(h.clock!(), 90) });
    h.clock!.advance(90); // the lease expiry has now arrived: nothing left to approve
    const before = await tableFingerprint(h.database.url, ["jobs", "approvals"]);
    const res = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect(res.status).toBe(409);
    expect(["stale_plan", "approval_expired"]).toContain(res.body.error.code);
    expect(await tableFingerprint(h.database.url, ["jobs", "approvals"])).toEqual(before);
    expect((await getLease(h, ws.operator.session, created.id)).state).toBe("requested");
  });

  it("tightening the policy after the request invalidates the old plan: approval is refused", async () => {
    const created = await lease({ expires_at: isoPlus(h.clock!(), 3 * 3600) });
    const policy = (await h.client.get(ws.admin.session, "/policy")).body;
    const tightened = await h.client.put(ws.admin.session, "/policy", { max_ttl_seconds: 3600, expected_version: policy.version });
    expect(tightened.status).toBe(200);
    const res = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect([409, 422]).toContain(res.status);
    expect((await getLease(h, ws.operator.session, created.id)).state).toBe("requested");
  });

  it("approval requires the operator role, the lease must be REQUESTED and a replay with the same Idempotency-Key returns the stored receipt", async () => {
    const policy = (await h.client.get(ws.admin.session, "/policy")).body;
    await h.client.put(ws.admin.session, "/policy", { max_ttl_seconds: 8 * 3600, expected_version: policy.version });
    const created = await lease();
    const viewer = await h.client.post(ws.viewer.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect(viewer.status).toBe(403);
    const key = "ac02-approve-key-0001";
    const first = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash }, { idempotencyKey: key });
    const replay = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash }, { idempotencyKey: key });
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const again = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("invalid_transition");
    const conflict = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: "1".repeat(64) }, { idempotencyKey: key });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("idempotency_conflict");
    const rows = await sql(h.database.url, "SELECT count(*)::int AS n FROM approvals WHERE lease_id = $1", [created.id]);
    expect(rows[0]!.n).toBe(1);
  });
}
