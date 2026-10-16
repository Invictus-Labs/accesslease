import { afterAll, beforeAll, expect, it } from "vitest";
import type { Provider } from "../../src/connectors/provider.js";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, sleep, waitFor } from "../helpers/clock.js";
import { roleFacts } from "../helpers/db.js";
import { providerRoleFor, sql } from "../helpers/oracle.js";

/**
 * AC-06: after scheduler downtime, overdue grants are swept BEFORE new leases are issued, and retries identify the same provider
 * grant. Real postgres-role provider; the provider call order is recorded by wrapping the live provider instance.
 */
export function restartSweep(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  let provider: Provider;
  const calls: { op: string; leaseId: string }[] = [];
  const base = { task_ref: "TASK-AC06", subject_ref: "contractor-restart@example.invalid" };

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: false });
    ws = await h.workspace("ac06");
    resource = h.target!.database;
    provider = h.ctx.providers.require("postgres-role");
    for (const op of ["issue", "revoke"] as const) {
      const original = (provider as any)[op].bind(provider);
      (provider as any)[op] = (arg: { leaseId: string }) => {
        calls.push({ op, leaseId: arg.leaseId });
        return original(arg);
      };
    }
  });
  afterAll(async () => {
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  const request = (ttl: number) => requestLease(h, ws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), ttl) });
  const approve = (id: string, plan_hash: string) => h.client.post(ws.operator.session, `/leases/${id}/approve`, { plan_hash });
  async function activeLease(ttl: number): Promise<string> {
    const created = await request(ttl);
    await approve(created.id, created.plan_hash);
    await waitFor("ACTIVE", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, created.id)).state === "active";
    }, 30_000, 200);
    return created.id;
  }

  it("after downtime the first worker pass revokes every overdue lease before issuing a newly approved one", async () => {
    const overdueA = await activeLease(5);
    const overdueB = await activeLease(5);
    // Scheduler downtime: nothing runs while both leases expire; meanwhile a new lease is approved.
    await sleep(6500);
    const fresh = await request(900);
    expect((await approve(fresh.id, fresh.plan_hash)).status).toBe(202);
    expect((await getLease(h, ws.operator.session, overdueA)).state).toBe("active"); // nobody has swept yet
    calls.length = 0;

    const report = await h.worker();
    expect(report.sweep.overdueRecovered + report.sweep.expiredToRevoking).toBeGreaterThanOrEqual(2);
    const order = calls.map((c) => `${c.op}:${c.leaseId}`);
    const lastRevoke = Math.max(order.indexOf(`revoke:${overdueA}`), order.indexOf(`revoke:${overdueB}`));
    const issueFresh = order.indexOf(`issue:${fresh.id}`);
    expect(lastRevoke, `provider calls: ${order.join(" ")}`).toBeGreaterThanOrEqual(0);
    if (issueFresh >= 0) expect(issueFresh, "the new lease must not be issued before overdue grants are revoked").toBeGreaterThan(lastRevoke);
    for (const id of [overdueA, overdueB]) {
      // A transient provider hiccup under load may leave a lease REVOCATION_UNCONFIRMED for one retry; it must converge to verified.
      await waitFor("overdue lease verified", async () => {
        await h.worker();
        return (await getLease(h, ws.operator.session, id)).state === "revoked_verified";
      }, 90_000, 500);
      const d = await getLease(h, ws.operator.session, id);
      expect(d.state).toBe("revoked_verified");
      expect(d.close_reason).toBe("expired");
      expect(await roleFacts(h.target!.clusterUrl, providerRoleFor(id))).toMatchObject({ exists: false });
    }
    await waitFor("the new lease is issued after the sweep", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, fresh.id)).state === "active";
    }, 60_000, 500);
    // Audit order agrees: both revocations were recorded before the new lease reached ISSUING.
    const seq = async (leaseId: string, pattern: RegExp) => (await sql(h.database.url, "SELECT min(seq)::int AS s FROM audit_events WHERE lease_id = $1 AND action ~* $2", [leaseId, pattern.source]))[0]!.s as number;
    const issuing = await seq(fresh.id, /^issue\.started$/);
    expect(issuing).toBeGreaterThan(0);
    expect(await seq(overdueA, /^sweep\.expired$/)).toBeLessThan(issuing);
    expect(await seq(overdueB, /^sweep\.expired$/)).toBeLessThan(issuing);
  });

  it("a lease that expired before it was ever issued is swept and never granted access", async () => {
    const created = await request(3);
    await approve(created.id, created.plan_hash);
    await sleep(4500);
    calls.length = 0;
    await h.drain();
    const d = await getLease(h, ws.operator.session, created.id);
    expect(d.state).toBe("revoked_verified");
    expect(d.issued_at).toBeNull();
    expect(calls.filter((c) => c.op === "issue" && c.leaseId === created.id)).toEqual([]);
    expect(await roleFacts(h.target!.clusterUrl, providerRoleFor(created.id))).toMatchObject({ exists: false });
  });

  it("a redelivered issue job retries the same provider grant: same reference, one role, the lease is not disturbed", async () => {
    const id = await activeLease(600);
    const before = await getLease(h, ws.operator.session, id);
    const role = providerRoleFor(id);
    expect(before.provider_grant?.provider_ref).toBe(role);
    // At-least-once delivery: put the finished issue job back in the queue, exactly as a crashed-before-ack worker would leave it.
    const requeued = await sql(h.database.url, "UPDATE jobs SET state = 'queued', lease_until = NULL, locked_by = NULL, next_attempt_at = now() WHERE lease_id = $1 AND type = 'issue' RETURNING id", [id]);
    expect(requeued.length).toBeGreaterThanOrEqual(1);
    calls.length = 0;
    await h.drain();
    const issueCalls = calls.filter((c) => c.op === "issue" && c.leaseId === id).length;
    const after = await getLease(h, ws.operator.session, id);
    expect(after.state).toBe("active");
    expect(after.provider_grant?.provider_ref).toBe(role);
    expect((await sql(h.target!.clusterUrl, "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [role]))[0]!.n).toBe(1);
    expect(issueCalls).toBeLessThanOrEqual(1);
    // The provider contract itself: issuing the same lease again aligns the same grant (alreadyExisted) and never creates a second.
    const again = await provider.issue({ leaseId: id, resource, attempt: 9, subject: base.subject_ref, scopes: ["pg:app.records:select"], expiresAt: new Date(after.expires_at), credentialSecret: "x".repeat(32) });
    expect(again.providerRef).toBe(role);
    expect(again.alreadyExisted).toBe(true);
    await h.client.post(ws.operator.session, `/leases/${id}/revoke`, { reason: "cleanup" });
    await h.drain();
  });
}
