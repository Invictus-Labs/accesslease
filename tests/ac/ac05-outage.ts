import pg from "pg";
import { reportModelFromData } from "../../src/report/from-data.js";
import { renderReport } from "../../src/report/render.js";
import { cliPrincipal, getReportData } from "../../src/services/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, sleep, waitFor } from "../helpers/clock.js";
import { pauseProvider, unpauseProvider } from "../helpers/docker.js";
import { roleFacts } from "../helpers/db.js";
import { providerRoleFor } from "../helpers/oracle.js";

/**
 * AC-05: a provider outage leaves REVOCATION_UNCONFIRMED with a next retry and a visible warning; a green "revoked" state is never
 * shown. The outage is real: the disposable provider cluster is frozen (docker pause) while revocation is attempted.
 */
export function revocationOutage(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  const base = { task_ref: "TASK-AC05", subject_ref: "contractor-outage@example.invalid" };

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: false, settings: { retryBaseSeconds: 2, retryCapSeconds: 4 } });
    ws = await h.workspace("ac05");
    resource = h.target!.database;
  });
  afterAll(async () => {
    unpauseProvider();
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  async function activeLease(ttlSeconds: number) {
    const created = await requestLease(h, ws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), ttlSeconds) });
    await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
    await waitFor("ACTIVE", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, created.id)).state === "active";
    }, 30_000, 200);
    return created.id;
  }

  function expectNeverGreen(detail: Awaited<ReturnType<typeof getLease>>): void {
    expect(detail.state).toBe("revocation_unconfirmed");
    expect(detail.revocation_status).toBe("unconfirmed");
    expect(detail.warning, "an unconfirmed revocation must carry a visible warning").toBeTruthy();
    expect(detail.next_retry_at, "an unconfirmed revocation must schedule the next retry").toBeTruthy();
    expect(new Date(detail.next_retry_at!).getTime()).toBeGreaterThan(Date.now() - 2000);
    expect(detail.revoked_at).toBeNull();
    expect(detail.last_verified_at).toBeNull();
    expect(detail.attempts.length).toBeGreaterThanOrEqual(1);
    expect(detail.attempts.every((a) => a.result !== "verified")).toBe(true);
  }

  it("a frozen provider during explicit revocation leaves REVOCATION_UNCONFIRMED with next retry and warning, then recovers to verified without rewriting history", async () => {
    const id = await activeLease(600);
    pauseProvider();
    try {
      const res = await h.client.post(ws.operator.session, `/leases/${id}/revoke`, { reason: "outage drill" });
      expect(res.status).toBe(202);
      await h.worker();
      const unconfirmed = await getLease(h, ws.operator.session, id);
      expectNeverGreen(unconfirmed);

      // Every surface that can show the lease agrees: list, report data and events never claim success.
      const list = await h.client.get(ws.viewer.session, "/leases");
      const row = list.body.items.find((l: { id: string }) => l.id === id);
      expect(row.state).toBe("revocation_unconfirmed");
      expect(row.revocation_status).toBe("unconfirmed");
      const report = await h.client.get(ws.viewer.session, "/report");
      expect(report.body.summary.unresolved.revocation_unconfirmed).toBeGreaterThanOrEqual(1);
      const events = await h.client.get(ws.viewer.session, "/events?after=0&limit=100");
      const types = events.body.items.filter((e: { resource_id: string }) => e.resource_id === id).map((e: { event_type: string }) => e.event_type);
      expect(types).toContain("lease.revocation_unconfirmed");
      expect(types).not.toContain("lease.revoked_verified");

      // A second worker pass while still frozen appends another attempt; earlier attempts are untouched.
      await sleep(2500);
      await h.worker();
      const again = await getLease(h, ws.operator.session, id);
      expectNeverGreen(again);
      expect(again.attempts.length).toBeGreaterThan(unconfirmed.attempts.length);
      expect(again.attempts.slice(0, unconfirmed.attempts.length)).toEqual(unconfirmed.attempts);
    } finally {
      unpauseProvider();
    }
    // Provider is back: the retry verifies independently and only now does the lease read as revoked.
    await h.client.post(ws.operator.session, `/leases/${id}/revoke`, { reason: "retry now" });
    await waitFor("verified after recovery", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, id)).state === "revoked_verified";
    }, 60_000, 500);
    const done = await getLease(h, ws.operator.session, id);
    expect(done.revocation_status).toBe("verified");
    expect(done.attempts.some((a) => a.result !== "verified")).toBe(true);
    expect(await roleFacts(h.target!.clusterUrl, providerRoleFor(id))).toMatchObject({ exists: false, sessions: 0 });
  });

  it("a partial real revocation (the role cannot be dropped because it holds a privilege elsewhere) is REVOCATION_UNCONFIRMED even though logins are already blocked, and verifies only after the leftover is removed", async () => {
    const id = await activeLease(600);
    const role = providerRoleFor(id);
    // Outside AccessLease an administrator granted the role a privilege in ANOTHER database: DROP OWNED in the target database cannot
    // remove it, so DROP ROLE must now fail.
    const otherName = `${h.target!.database}_other`;
    const cluster = new pg.Client({ connectionString: h.target!.clusterUrl });
    await cluster.connect();
    await cluster.query(`CREATE DATABASE ${otherName}`);
    await cluster.end();
    const other = new URL(h.target!.clusterUrl);
    other.pathname = `/${otherName}`;
    const side = new pg.Client({ connectionString: other.toString() });
    await side.connect();
    await side.query("CREATE TABLE leftovers (id int)");
    await side.query(`GRANT SELECT ON leftovers TO "${role}"`);
    try {
      await h.client.post(ws.operator.session, `/leases/${id}/revoke`, { reason: "partial revocation drill" });
      await h.worker();
      const detail = await getLease(h, ws.operator.session, id);
      expectNeverGreen(detail);
      // The static report built from the same live data never styles the unconfirmed lease as verified.
      const principal = await cliPrincipal(h.ctx, "ac05");
      const html = renderReport(reportModelFromData(await getReportData(h.ctx, principal)));
      expect(html).toMatch(/class="badge tone-uncertain" data-state="revocation_unconfirmed"/i);
      expect(html).not.toMatch(/tone-verified" data-state="revocation_unconfirmed"/i);
      expect(html).toContain("unresolved");
      const facts = await roleFacts(h.target!.clusterUrl, role);
      expect(facts).toMatchObject({ exists: true, canLogin: false, sessions: 0 }); // access is already blocked, but the grant is not gone: not verified
      expect(detail.attempts.at(-1)!.verification_ref).toMatch(/introspection:present/);
      await side.query(`REVOKE SELECT ON leftovers FROM "${role}"`);
    } finally {
      await side.end().catch(() => undefined);
    }
    await h.client.post(ws.operator.session, `/leases/${id}/revoke`, { reason: "retry now" });
    await waitFor("verified after the leftover grant was removed", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, id)).state === "revoked_verified";
    }, 60_000, 500);
    expect(await roleFacts(h.target!.clusterUrl, role)).toMatchObject({ exists: false });
    const cleanup = new pg.Client({ connectionString: h.target!.clusterUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${otherName} WITH (FORCE)`);
    await cleanup.end();
  }, 150_000);

  it("expiry during an outage is also unconfirmed, never verified by elapsed time alone", async () => {
    const id = await activeLease(5);
    const expiresAt = new Date((await getLease(h, ws.operator.session, id)).expires_at).getTime();
    pauseProvider();
    try {
      await sleep(Math.max(0, expiresAt - Date.now()) + 800);
      await h.worker();
      const detail = await getLease(h, ws.operator.session, id);
      expectNeverGreen(detail);
      expect(detail.close_reason).toBe("expired");
    } finally {
      unpauseProvider();
    }
    await waitFor("verified after recovery", async () => {
      await sleep(500);
      await h.worker();
      return (await getLease(h, ws.operator.session, id)).state === "revoked_verified";
    }, 90_000, 500);
  });
}
