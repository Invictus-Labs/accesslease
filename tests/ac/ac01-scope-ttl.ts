import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, T0 } from "../helpers/clock.js";
import { tableFingerprint } from "../helpers/oracle.js";

/** AC-01: reject wildcard/admin scopes and TTL over the policy maximum; default 1 h, hard max 8 h, configurable only by admins. */
export function scopeAndTtlPolicy(): void {
  let h: Harness;
  let ws: TestWorkspace;
  const base = { task_ref: "TASK-AC01", subject_ref: "contractor-alpha@example.invalid", resource_ref: "placeholder" };
  let resource: string;
  const providerCalls: string[] = [];

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: true });
    ws = await h.workspace("ac01");
    resource = h.target!.database;
    // Spy on every provider method so "before any provider is contacted" is observable, not assumed.
    const provider = h.ctx.providers.require("postgres-role");
    for (const name of ["ping", "issue", "lookup", "revoke", "probeUse"] as const) {
      const original = (provider as any)[name].bind(provider);
      (provider as any)[name] = (...args: unknown[]) => {
        providerCalls.push(name);
        return original(...args);
      };
    }
  });
  afterAll(async () => {
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  const scope = (suffix: string) => `pg:app.records:${suffix}`;

  it("rejects wildcard and admin-class scopes with 422 before any provider call and stores nothing", async () => {
    const bad: { scopes: string[]; codes: string[] }[] = [
      { scopes: ["*"], codes: ["scope_wildcard"] },
      { scopes: ["pg:app.*:select"], codes: ["scope_wildcard", "invalid_scope"] },
      { scopes: ["pg:*.*:select"], codes: ["scope_wildcard", "invalid_scope"] },
      { scopes: [scope("all")], codes: ["scope_wildcard", "scope_forbidden", "invalid_scope"] },
      { scopes: ["all"], codes: ["scope_wildcard", "invalid_scope"] },
      { scopes: [scope("superuser")], codes: ["scope_forbidden", "invalid_scope"] },
      { scopes: ["admin"], codes: ["scope_forbidden", "invalid_scope"] },
      // Valid provider grammar must still hit the generic administrative-scope ban.
      // Otherwise malformed privilege examples can pass through the grammar rejection alone.
      { scopes: ["pg:admin.records:select"], codes: ["scope_forbidden"] },
      { scopes: ["pg:app.superuser_records:select"], codes: ["scope_forbidden"] },
      { scopes: [scope("delete")], codes: ["scope_forbidden", "invalid_scope"] },
      { scopes: [scope("select"), "pg:app.records:createrole"], codes: ["scope_forbidden", "invalid_scope"] },
      { scopes: [scope("select"), "*"], codes: ["scope_wildcard"] },
    ];
    const before = await tableFingerprint(h.database.url, ["leases", "approvals", "provider_grants", "jobs"]);
    providerCalls.length = 0;
    for (const { scopes, codes } of bad) {
      const res = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes });
      expect(res.status, JSON.stringify(scopes)).toBe(422);
      expect(codes, `${JSON.stringify(scopes)} -> ${res.body?.error?.code}`).toContain(res.body.error.code);
    }
    expect(providerCalls).toEqual([]);
    expect(await tableFingerprint(h.database.url, ["leases", "approvals", "provider_grants", "jobs"])).toEqual(before);
  });

  it("accepts an exact narrow scope and the same request is accepted again only as a new lease", async () => {
    const res = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")] });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("requested");
    expect(res.body.lease.provider.label).toBe("LIVE_LOCAL_POSTGRES");
  });

  it("enforces the 8 hour hard maximum exactly at the boundary and the minimum below it", async () => {
    const now = h.clock!();
    const ok = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")], expires_at: isoPlus(now, 8 * 3600) });
    expect(ok.status).toBe(201);
    const over = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")], expires_at: isoPlus(now, 8 * 3600 + 1) });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("ttl_exceeds_max");
    const past = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")], expires_at: isoPlus(now, -5) });
    expect(past.status).toBe(422);
    expect(["expires_in_past", "ttl_below_min"]).toContain(past.body.error.code);
    const offset = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")], expires_at: "2026-09-28T14:00:00+02:00" });
    expect(offset.status).toBe(422);
  });

  it("defaults to a one hour lease when expires_at is omitted", async () => {
    const res = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")] });
    expect(res.status).toBe(201);
    expect(res.body.lease.expires_at).toBe(isoPlus(h.clock!(), 3600));
    expect(h.clock!().toISOString()).toBe(T0.toISOString());
  });

  it("lets only admins change TTL and scope policy; operators and viewers get 403 and nothing changes", async () => {
    const before = await h.client.get(ws.viewer.session, "/policy");
    expect(before.status).toBe(200);
    for (const persona of [ws.operator, ws.viewer]) {
      const res = await h.client.put(persona.session, "/policy", { max_ttl_seconds: 24 * 3600, expected_version: before.body.version });
      expect(res.status).toBe(403);
    }
    const after = await h.client.get(ws.viewer.session, "/policy");
    expect(after.body).toEqual(before.body);
    // An admin can tighten the maximum and the new maximum is enforced on the next request.
    const tightened = await h.client.put(ws.admin.session, "/policy", { max_ttl_seconds: 2 * 3600, expected_version: before.body.version });
    expect(tightened.status).toBe(200);
    expect(tightened.body.max_ttl_seconds).toBe(7200);
    const now = h.clock!();
    const tooLong = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")], expires_at: isoPlus(now, 3 * 3600) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe("ttl_exceeds_max");
    // The configurable ceiling is itself bounded: an admin cannot disable the maximum.
    const absurd = await h.client.put(ws.admin.session, "/policy", { max_ttl_seconds: 30 * 24 * 3600, expected_version: tightened.body.version });
    expect(absurd.status).toBe(422);
  });

  it("scope allow and deny lists set by an admin are enforced", async () => {
    const current = await h.client.get(ws.admin.session, "/policy");
    const res = await h.client.put(ws.admin.session, "/policy", { scope_deny_prefixes: ["pg:app.secrets_vault"], expected_version: current.body.version });
    expect(res.status).toBe(200);
    const denied = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: ["pg:app.secrets_vault:select"] });
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe("scope_forbidden");
    const allowed = await h.client.post(ws.operator.session, "/leases", { ...base, resource_ref: resource, scopes: [scope("select")] });
    expect(allowed.status).toBe(201);
  });

  it("a plain unknown member or wrong type is a 422 schema rejection, not an accepted lease", async () => {
    for (const body of [
      { ...base, resource_ref: resource, scopes: [scope("select")], is_admin: true },
      { ...base, resource_ref: resource, scopes: "pg:app.records:select" },
      { ...base, resource_ref: resource, scopes: [] },
      { ...base, resource_ref: resource },
    ]) {
      const res = await h.client.post(ws.operator.session, "/leases", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
}

void describe;
