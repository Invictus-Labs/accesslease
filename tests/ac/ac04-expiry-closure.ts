import { afterAll, beforeAll, expect, it } from "vitest";
import { runWorker } from "../../src/services/index.js";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { ghostId, isoPlus, sleep, waitFor } from "../helpers/clock.js";
import { roleFacts } from "../helpers/db.js";
import { providerRoleFor } from "../helpers/oracle.js";
import { recordEvidence } from "../helpers/evidence.js";

/**
 * AC-04: on expiry or task closure, revocation is REQUESTED within 30 seconds under healthy conditions and verified by provider
 * introspection or a denied-use probe. Measured on the real wall clock with the real worker loop at the shipped default poll
 * interval against the real postgres-role provider.
 */
export function expiryAndClosure(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  let stop: AbortController;
  let loop: Promise<void>;
  const base = { task_ref: "TASK-AC04", subject_ref: "contractor-clock@example.invalid" };

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: false, settings: { workerPollMs: 5000 } });
    ws = await h.workspace("ac04");
    resource = h.target!.database;
  });
  afterAll(async () => {
    stop?.abort();
    await loop;
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  async function issue(ttlSeconds: number) {
    const created = await requestLease(h, ws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), ttlSeconds) });
    await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    await waitFor("ACTIVE", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, created.id)).state === "active";
    }, 30_000, 200);
    return created.id;
  }

  /** When revocation was REQUESTED: the transactional-outbox event for the lease entering REVOKING, an independent record from the lease row. */
  const revokingAtOf = async (leaseId: string): Promise<number> => {
    const events = await h.client.get(ws.viewer.session, "/events?after=0&limit=100");
    const hit = (events.body.items as { resource_id: string; event_type: string; occurred_at: string }[]).filter((e) => e.resource_id === leaseId && e.event_type === "lease.revoking");
    expect(hit.length, `events for ${leaseId}: ${JSON.stringify(events.body.items.filter((e: { resource_id: string }) => e.resource_id === leaseId).map((e: { event_type: string }) => e.event_type))}`).toBe(1);
    return new Date(hit[0]!.occurred_at).getTime();
  };

  it("expiry alone never reads as revoked; once the healthy worker runs, revocation is requested within 30 s of expiry and verified independently", async () => {
    const id = await issue(8);
    const detail0 = await getLease(h, ws.operator.session, id);
    const expiresAt = new Date(detail0.expires_at).getTime();
    await sleep(Math.max(0, expiresAt - Date.now()) + 500);
    // Time has passed but nothing has acted yet: expiry is not revocation.
    const stale = await getLease(h, ws.operator.session, id);
    expect(stale.state).not.toBe("revoked_verified");
    expect(stale.revocation_status).not.toBe("verified");

    stop = new AbortController();
    loop = runWorker(h.ctx, { pollMs: 5000, signal: stop.signal });
    await waitFor("REVOKED_VERIFIED", async () => (await getLease(h, ws.operator.session, id)).state === "revoked_verified", 60_000, 250);
    stop.abort();
    await loop;

    const done = await getLease(h, ws.operator.session, id);
    const requestedAt = await revokingAtOf(id);
    const delay = (requestedAt - expiresAt) / 1000;
    expect(done.close_reason).toBe("expired");
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay, `revocation was requested ${delay.toFixed(2)} s after expiry`).toBeLessThanOrEqual(30);
    expect(done.attempts.at(-1)!.verification_ref).toMatch(/introspection|probe/);
    expect(new Date(done.last_verified_at!).getTime()).toBeGreaterThanOrEqual(requestedAt);
    expect(await roleFacts(h.target!.clusterUrl, providerRoleFor(id))).toMatchObject({ exists: false, sessions: 0 });
    recordEvidence("ac-04-expiry-request-delay", { worker_poll_ms: 5000, revocation_requested_after_expiry_seconds: delay, sla_seconds: 30 });
  });

  it("task closure requests revocation within 30 s (immediately in the API call) and ends verified", async () => {
    const id = await issue(600);
    const before = Date.now();
    const res = await h.client.post(ws.operator.session, `/leases/${id}/close`, { reason: "task done" });
    expect(res.status).toBe(202);
    const closing = await getLease(h, ws.operator.session, id);
    expect(["revoking", "revoked_verified", "revocation_unconfirmed"]).toContain(closing.state);
    expect(closing.close_reason).toBe("task_closed");
    const requestedAfter = ((await revokingAtOf(id)) - before) / 1000;
    expect(requestedAfter).toBeLessThanOrEqual(30);
    await waitFor("REVOKED_VERIFIED", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, id)).state === "revoked_verified";
    }, 30_000, 200);
    const done = await getLease(h, ws.operator.session, id);
    expect(done.revocation_status).toBe("verified");
    expect(done.attempts.at(-1)!.verification_ref).toMatch(/introspection|probe/);
    recordEvidence("ac-04-closure-request-delay", { revocation_requested_after_close_seconds: requestedAfter });
  });

  it("a closure request on an already-closed lease changes nothing and unknown or foreign leases are rejected", async () => {
    const id = await issue(600);
    await h.client.post(ws.operator.session, `/leases/${id}/close`, { reason: "first" });
    await h.drain();
    const before = await getLease(h, ws.operator.session, id);
    const again = await h.client.post(ws.operator.session, `/leases/${id}/close`, { reason: "second" });
    expect(again.status).toBe(202);
    const after = await getLease(h, ws.operator.session, id);
    expect(after.state).toBe(before.state);
    expect(after.audit.length).toBe(before.audit.length);
    expect((await h.client.post(ws.operator.session, `/leases/${ghostId(0)}/close`, { reason: "x" })).status).toBe(404);
    expect((await h.client.post(ws.viewer.session, `/leases/${id}/close`, { reason: "x" })).status).toBe(403);
  });
}
