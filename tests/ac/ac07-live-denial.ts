import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, sleep, waitFor } from "../helpers/clock.js";
import { providerRoleFor, sql } from "../helpers/oracle.js";
import { openSession, roleFacts, tryConnect } from "../helpers/db.js";
import { recordEvidence } from "../helpers/evidence.js";

/**
 * AC-07 (LIVE): against the real postgres-role provider on a disposable PostgreSQL 17 cluster, prove allowed access during the
 * lease, denial after expiry and after explicit revocation, and the provider's cache/session behavior: native VALID UNTIL only
 * blocks NEW logins; an already-open session survives until AccessLease terminates it. The residual-access window is measured.
 */
export function realDenialProof(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  const base = { task_ref: "TASK-AC07", subject_ref: "contractor-live@example.invalid" };

  beforeAll(async () => {
    // Real clock, real provider. A 250 ms poll keeps the suite fast; the shipped default (5 s) is measured in a dedicated test.
    h = await createHarness({ provider: "postgres-role", fixedClock: false, settings: { workerPollMs: 250 } });
    ws = await h.workspace("ac07");
    resource = h.target!.database;
  });
  afterAll(async () => {
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  async function activeLease(ttlSeconds: number, scopes = ["pg:app.records:select", "pg:app.records:insert"]) {
    const created = await requestLease(h, ws, { ...base, resource_ref: resource, scopes, expires_at: isoPlus(new Date(), ttlSeconds) });
    const approved = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    expect(approved.status).toBe(202);
    await waitFor("lease ACTIVE", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, created.id)).state === "active";
    }, 30_000, 200);
    const delivery = await h.client.post(ws.operator.session, `/leases/${created.id}/credential`);
    expect(delivery.status).toBe(200);
    expect(delivery.headers["cache-control"]).toContain("no-store");
    const c = delivery.body.credential;
    const url = new URL(`postgres://localhost/${c.database}`);
    url.hostname = c.host;
    url.port = String(c.port);
    url.username = c.username;
    url.password = c.secret;
    return { id: created.id, url: url.toString(), role: providerRoleFor(created.id), secret: c.secret as string, expires_at: (await getLease(h, ws.operator.session, created.id)).expires_at };
  }

  it("allows exactly the granted access during the lease and refuses everything else", async () => {
    const lease = await activeLease(120);
    expect((await tryConnect(lease.url)).ok).toBe(true);
    const session = await openSession(lease.url);
    const read = await session.query("SELECT count(*) AS n FROM app.records");
    expect(read.ok).toBe(true);
    expect(Number((read.rows![0] as { n: string }).n)).toBe(h.target!.seededRows);
    const insert = await session.query("INSERT INTO app.records(body) VALUES ('written-during-lease')");
    expect(insert.ok, `an INSERT scope must allow inserting: ${JSON.stringify(insert)}`).toBe(true);
    for (const denied of ["SELECT 1 FROM app.other_records", "SELECT 1 FROM app.secrets_vault", "UPDATE app.records SET body = 'x'", "DELETE FROM app.records", "CREATE TABLE app.pwned(id int)", "CREATE ROLE intruder", "DROP TABLE app.records"]) {
      const r = await session.query(denied);
      expect(r.ok, denied).toBe(false);
      expect(["42501", "25006"], `${denied} -> ${r.code}`).toContain(r.code);
    }
    await session.close();
    // The credential is one-time: a second retrieval is refused and carries no secret.
    const second = await h.client.post(ws.operator.session, `/leases/${lease.id}/credential`);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("credential_already_retrieved");
    expect(second.raw).not.toContain(lease.secret);
    await h.client.post(ws.operator.session, `/leases/${lease.id}/revoke`, { reason: "cleanup" });
    await h.drain();
  });

  it("after expiry the provider natively refuses new logins while an already-open session survives until AccessLease revokes it, then everything is denied", async () => {
    const lease = await activeLease(6);
    const expiresAt = new Date(lease.expires_at).getTime();
    const session = await openSession(lease.url);
    expect((await session.query("SELECT 1")).ok).toBe(true);

    // The worker is deliberately idle while the lease expires, so only the provider's native TTL is in play.
    await sleep(Math.max(0, expiresAt - Date.now()) + 1500);
    const fresh = await tryConnect(lease.url);
    expect(fresh.ok, "native VALID UNTIL must refuse a new login after expiry").toBe(false);
    expect(fresh.code).toMatch(/^28/);
    const residual = await session.query("SELECT count(*) FROM app.records");
    expect(residual.ok, "documented residual access: an open session outlives VALID UNTIL").toBe(true);
    expect((await roleFacts(h.target!.clusterUrl, lease.role)).sessions).toBeGreaterThanOrEqual(1);

    // Now AccessLease acts: run the worker and watch the open session die.
    const workerStarted = Date.now();
    let sessionDiedAt = 0;
    await waitFor("open session terminated and lease verified", async () => {
      await h.worker();
      if (!sessionDiedAt && !(await session.query("SELECT 1")).ok) sessionDiedAt = Date.now();
      return (await getLease(h, ws.operator.session, lease.id)).state === "revoked_verified";
    }, 40_000, 100);
    if (!sessionDiedAt && !(await session.query("SELECT 1")).ok) sessionDiedAt = Date.now();
    expect(sessionDiedAt, "the open session must be terminated by revocation").toBeGreaterThan(0);

    const detail = await getLease(h, ws.operator.session, lease.id);
    expect(detail.close_reason).toBe("expired");
    expect(detail.revocation_status).toBe("verified");
    const last = detail.attempts.at(-1)!;
    expect(last.result).toBe("verified");
    expect(last.verification_ref).toMatch(/introspection/);
    expect(last.verification_ref).toMatch(/probe/);
    expect(await roleFacts(h.target!.clusterUrl, lease.role)).toMatchObject({ exists: false, sessions: 0 });
    expect((await tryConnect(lease.url)).ok).toBe(false);
    expect((await session.query("SELECT 1")).ok).toBe(false);
    await session.close();
    recordEvidence("ac-07-expiry-denial", {
      provider: "postgres-role (PostgreSQL 17, disposable cluster)",
      lease_ttl_seconds: 6,
      worker_idle_after_expiry_ms: workerStarted - expiresAt,
      session_died_after_worker_start_ms: sessionDiedAt - workerStarted,
      session_died_after_expiry_ms: sessionDiedAt - expiresAt,
    });
  });

  it("after explicit revocation access is denied: the open session is terminated, the role is gone and a second revoke is idempotent", async () => {
    const lease = await activeLease(300);
    const session = await openSession(lease.url);
    expect((await session.query("SELECT count(*) FROM app.records")).ok).toBe(true);
    const revoke = await h.client.post(ws.operator.session, `/leases/${lease.id}/revoke`, { reason: "task cancelled" });
    expect(revoke.status).toBe(202);
    const requestedAt = Date.now();
    let diedAt = 0;
    await waitFor("revocation verified", async () => {
      await h.worker();
      if (!diedAt && !(await session.query("SELECT 1")).ok) diedAt = Date.now();
      return (await getLease(h, ws.operator.session, lease.id)).state === "revoked_verified";
    }, 30_000, 100);
    expect(diedAt || (await session.query("SELECT 1")).ok === false).toBeTruthy();
    expect((await session.query("SELECT 1")).ok).toBe(false);
    expect((await tryConnect(lease.url)).ok).toBe(false);
    expect(await roleFacts(h.target!.clusterUrl, lease.role)).toMatchObject({ exists: false, sessions: 0 });
    const detail = await getLease(h, ws.operator.session, lease.id);
    expect(detail.close_reason).toBe("operator_revoked");
    expect(detail.attempts.at(-1)!.verification_ref).toMatch(/probe/);
    const again = await h.client.post(ws.operator.session, `/leases/${lease.id}/revoke`, { reason: "again" });
    expect(again.status).toBe(202);
    expect(again.body.state).toBe("revoked_verified");
    await session.close();
    recordEvidence("ac-07-explicit-revocation", { revoke_to_session_death_ms: diedAt ? diedAt - requestedAt : null });
  });

  it("measures the residual-access window with the shipped worker defaults and keeps it within the documented maximum", async () => {
    // A second harness on the same cluster using the product defaults (5 s poll) and a free-running worker loop.
    const shipped = await createHarness({ provider: "postgres-role", fixedClock: false, target: h.target!, settings: { workerPollMs: 5000 } });
    try {
      const sws = await shipped.workspace("ac07-shipped");
      const created = await requestLease(shipped, sws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), 8) });
      await shipped.client.post(sws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
      await shipped.worker();
      await waitFor("ACTIVE", async () => (await getLease(shipped, sws.operator.session, created.id)).state === "active", 20_000, 200);
      const delivery = await shipped.client.post(sws.operator.session, `/leases/${created.id}/credential`);
      const c = delivery.body.credential;
      const url = new URL(`postgres://localhost/${c.database}`);
      url.hostname = c.host;
      url.port = String(c.port);
      url.username = c.username;
      url.password = c.secret;
      const session = await openSession(url.toString());
      const expiresAt = new Date((await getLease(shipped, sws.operator.session, created.id)).expires_at).getTime();
      const controller = new AbortController();
      const loop = (async () => {
        const { runWorker } = await import("../../src/services/index.js");
        await runWorker(shipped.ctx, { pollMs: 5000, signal: controller.signal });
      })();
      let diedAt = 0;
      await waitFor("open session terminated by the free-running worker", async () => {
        if (!(await session.query("SELECT 1")).ok) diedAt = Date.now();
        return diedAt > 0;
      }, 60_000, 100);
      controller.abort();
      await loop;
      const window = (diedAt - expiresAt) / 1000;
      const documented = shipped.ctx.providers.require("postgres-role").capabilities().maxResidualAccessSeconds;
      recordEvidence("ac-07-residual-window", { poll_ms: 5000, measured_residual_seconds: window, documented_max_seconds: documented, lease_ttl_seconds: 8 });
      expect(window).toBeGreaterThanOrEqual(0);
      expect(window).toBeLessThanOrEqual(documented);
      expect(window).toBeLessThanOrEqual(30);
      await session.close();
      const rows = await sql(shipped.database.url, "SELECT count(*)::int AS n FROM revocation_attempts WHERE lease_id = $1", [created.id]);
      expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await shipped.close();
      await shipped.database.drop();
    }
  });
}
