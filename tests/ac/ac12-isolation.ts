import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { ghostId, isoPlus } from "../helpers/clock.js";
import { tableFingerprint } from "../helpers/oracle.js";

/**
 * AC-12: workspace membership and admin/operator/viewer roles are enforced on reads, writes, jobs and exports; a cross-workspace
 * object id is a 404 indistinguishable from a missing object and changes no state. Real persistence and real routes; the synthetic
 * provider is enough here because no live criterion is claimed.
 */
export function workspaceIsolation(): void {
  let h: Harness;
  let a: TestWorkspace;
  let b: TestWorkspace;
  let bRequested: string;
  let bRequestedHash: string;
  let bActive: string;
  let aLease: string;
  const state = ["leases", "approvals", "provider_grants", "revocation_attempts", "audit_events", "jobs", "events", "idempotency_keys"];
  const scopes = ["synthetic:demo:read"];

  beforeAll(async () => {
    h = await createHarness({ provider: "synthetic", fixedClock: true });
    a = await h.workspace("iso-a");
    b = await h.workspace("iso-b");
    const mk = (ws: TestWorkspace) => requestLease(h, ws, { task_ref: "TASK-AC12", subject_ref: "someone@example.invalid", resource_ref: "demo", scopes, expires_at: isoPlus(h.clock!(), 3600) });
    const l1 = await mk(b);
    bRequested = l1.id;
    bRequestedHash = l1.plan_hash;
    const l2 = await mk(b);
    await h.client.post(b.operator.session, `/leases/${l2.id}/approve`, { plan_hash: l2.plan_hash });
    await h.drain();
    bActive = l2.id;
    aLease = (await mk(a)).id;
  });
  afterAll(async () => {
    await h.close();
    await h.database.drop();
  });

  const stripRequestId = (body: any) => JSON.stringify({ ...body, error: body?.error ? { ...body.error, request_id: "x" } : undefined });

  it("cross-workspace ids answer 404 with a body identical to a missing object, on every read and write route, and change no state", async () => {
    const missing = ghostId(170);
    const attempts: [string, string, unknown?][] = [
      ["GET", "/leases/ID"],
      ["POST", "/leases/ID/approve", { plan_hash: bRequestedHash }],
      ["POST", "/leases/ID/revoke", { reason: "x" }],
      ["POST", "/leases/ID/close", { reason: "x" }],
      ["POST", "/leases/ID/credential"],
      ["GET", "/leases/ID/evidence"],
    ];
    const before = await tableFingerprint(h.database.url, state);
    for (const target of [bRequested, bActive]) {
      for (const [method, path, body] of attempts) {
        const real = await h.client.call(a.operator.session, method as "GET" | "POST", path.replace("ID", target), body);
        const ghost = await h.client.call(a.operator.session, method as "GET" | "POST", path.replace("ID", missing), body);
        expect(real.status, `${method} ${path}`).toBe(404);
        expect(ghost.status).toBe(404);
        expect(stripRequestId(real.body), `${method} ${path} leaks existence`).toBe(stripRequestId(ghost.body));
        // Viewers and admins of the other workspace are equally blind.
        for (const persona of [a.viewer, a.admin]) {
          const r = await h.client.call(persona.session, method as "GET" | "POST", path.replace("ID", target), body);
          expect([403, 404]).toContain(r.status);
        }
      }
    }
    expect(await tableFingerprint(h.database.url, state)).toEqual(before);
    for (const bad of ["not-a-uuid", "../etc/passwd", "1", "%00"]) expect((await h.client.get(a.operator.session, `/leases/${encodeURIComponent(bad)}`)).status).toBe(404);
  });

  it("lists, reports, events, jobs and exports contain only the caller's workspace", async () => {
    await h.drain();
    const leaseList = await h.client.get(a.viewer.session, "/leases?limit=100");
    expect(leaseList.body.items.map((l: { id: string }) => l.id)).toEqual([aLease]);
    const report = await h.client.get(a.viewer.session, "/report");
    expect(report.body.leases.map((l: { id: string }) => l.id)).toEqual([aLease]);
    const events = await h.client.get(a.viewer.session, "/events?after=0&limit=100");
    expect(events.body.items.every((e: { resource_id: string }) => e.resource_id === aLease)).toBe(true);
    const jobs = await h.client.get(a.operator.session, "/jobs");
    expect(JSON.stringify(jobs.body)).not.toContain(bRequested);
    expect(JSON.stringify(jobs.body)).not.toContain(bActive);
    const exp = await h.client.get(a.operator.session, "/evidence/export");
    expect(exp.status).toBe(200);
    expect(exp.raw).not.toContain(bRequested);
    expect(exp.raw).not.toContain(bActive);
    const filtered = await h.client.get(a.operator.session, `/evidence/export?lease_ids=${bActive}`);
    expect(filtered.status === 404 || !filtered.raw.includes(bActive)).toBe(true);
    // The other workspace sees exactly its own.
    const bList = await h.client.get(b.viewer.session, "/leases?limit=100");
    expect(bList.body.items.map((l: { id: string }) => l.id).sort()).toEqual([bRequested, bActive].sort());
  });

  it("enforces admin, operator and viewer roles on every route; anonymous callers get 401", async () => {
    const lease = await requestLease(h, a, { task_ref: "TASK-RBAC", subject_ref: "r@example.invalid", resource_ref: "demo", scopes, expires_at: isoPlus(h.clock!(), 3600) });
    type Row = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown; min: "viewer" | "operator" | "admin" };
    const rows: Row[] = [
      { method: "GET", path: "/leases", min: "viewer" },
      { method: "GET", path: `/leases/${lease.id}`, min: "viewer" },
      { method: "GET", path: `/leases/${lease.id}/evidence`, min: "viewer" },
      { method: "GET", path: "/policy", min: "viewer" },
      { method: "GET", path: "/report", min: "viewer" },
      { method: "GET", path: "/events?after=0", min: "viewer" },
      { method: "GET", path: "/imports", min: "viewer" },
      { method: "GET", path: "/jobs", min: "operator" },
      { method: "GET", path: "/provider", min: "operator" },
      { method: "GET", path: "/evidence/export", min: "operator" },
      { method: "POST", path: "/leases", body: { task_ref: "t", subject_ref: "s@example.invalid", resource_ref: "demo", scopes }, min: "operator" },
      { method: "POST", path: `/leases/${lease.id}/revoke`, body: { reason: "x" }, min: "operator" },
      { method: "GET", path: "/members", min: "admin" },
      { method: "POST", path: "/members", body: { email: "new@example.invalid", password: "synthetic-test-password-123", role: "viewer" }, min: "admin" },
      { method: "PUT", path: "/policy", body: { default_ttl_seconds: 1800 }, min: "admin" },
      { method: "POST", path: "/evidence/import", body: {}, min: "admin" },
    ];
    const rank = { viewer: 0, operator: 1, admin: 2 } as const;
    for (const row of rows) {
      const anon = await h.client.call(null, row.method, row.path, row.body);
      expect(anon.status, `anonymous ${row.method} ${row.path}`).toBe(401);
      for (const [role, persona] of [["viewer", a.viewer], ["operator", a.operator], ["admin", a.admin]] as const) {
        const res = await h.client.call(persona.session, row.method, row.path, row.body);
        if (rank[role] < rank[row.min]) expect(res.status, `${role} ${row.method} ${row.path}`).toBe(403);
        else expect(res.status, `${role} ${row.method} ${row.path} -> ${res.raw.slice(0, 160)}`).not.toBe(403);
      }
    }
  });

  it("requires a valid CSRF token on every mutation and revokes sessions at logout", async () => {
    const before = await tableFingerprint(h.database.url, state);
    const body = { task_ref: "TASK-CSRF", subject_ref: "c@example.invalid", resource_ref: "demo", scopes, expires_at: isoPlus(h.clock!(), 3600) };
    for (const csrf of [null, "wrong-token", b.operator.session.csrf]) {
      const res = await h.client.post(a.operator.session, "/leases", body, { csrf });
      expect(res.status, `csrf=${String(csrf)}`).toBe(403);
      expect(res.body.error.code).toBe("csrf_invalid");
    }
    expect(await tableFingerprint(h.database.url, state)).toEqual(before);
    const extra = await h.client.login(a.viewer.email, "synthetic-test-password-123", a.id);
    expect((await h.client.get(extra, "/leases")).status).toBe(200);
    expect((await h.client.post(extra, "/auth/logout")).status).toBe(200);
    expect((await h.client.get(extra, "/leases")).status).toBe(401);
    const login = await h.client.call(null, "POST", "/auth/login", { email: a.viewer.email, password: "synthetic-test-password-123", workspace_id: a.id });
    const cookie = ([] as string[]).concat(login.headers["set-cookie"] as string | string[]).join(";");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("a user cannot sign into a workspace they do not belong to, and repeated bad logins are rate limited", async () => {
    const wrong = await h.client.call(null, "POST", "/auth/login", { email: a.operator.email, password: "synthetic-test-password-123", workspace_id: b.id });
    const bad = await h.client.call(null, "POST", "/auth/login", { email: a.operator.email, password: "not-the-password", workspace_id: a.id });
    expect(wrong.status).toBe(401);
    expect(stripRequestId(wrong.body)).toBe(stripRequestId(bad.body));
    let limited = false;
    for (let i = 0; i < 60 && !limited; i += 1) {
      const res = await h.client.call(null, "POST", "/auth/login", { email: "ratelimit@example.invalid", password: `wrong-${i}` });
      if (res.status === 429) {
        limited = true;
        expect(res.headers["retry-after"]).toBeTruthy();
      }
    }
    expect(limited).toBe(true);
    expect((await getLease(h, b.viewer.session, bRequested)).id).toBe(bRequested);
  });
}
