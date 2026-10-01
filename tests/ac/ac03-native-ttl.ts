import { afterAll, beforeAll, expect, it } from "vitest";
import { ProviderRegistry, ProviderUnavailableError, type Provider } from "../../src/connectors/provider.js";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, waitFor } from "../helpers/clock.js";
import { providerRoleFor, sql } from "../helpers/oracle.js";
import { roleFacts } from "../helpers/db.js";
import { withProviderPaused } from "../helpers/docker.js";

/** AC-03: the provider must enforce the TTL natively; uncertainty while issuing is ISSUE_UNKNOWN plus reconciliation, never a duplicate grant. */
export function nativeTtlAndIssueAmbiguity(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  let provider: Provider;
  let original: Provider["issue"];
  const base = { task_ref: "TASK-AC03", subject_ref: "automation-agent@example.invalid" };

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: false });
    ws = await h.workspace("ac03");
    resource = h.target!.database;
    provider = h.ctx.providers.require("postgres-role");
    original = provider.issue.bind(provider);
  });
  afterAll(async () => {
    provider.issue = original;
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  const newLease = (over: Record<string, unknown> = {}) =>
    requestLease(h, ws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), 1800), ...over });
  const approve = async (id: string, plan_hash: string) => {
    const res = await h.client.post(ws.operator.session, `/leases/${id}/approve`, { plan_hash });
    expect(res.status).toBe(202);
  };
  const roleCount = async (leaseId: string) => (await sql(h.target!.clusterUrl, "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [providerRoleFor(leaseId)]))[0]!.n as number;

  it("the real provider reports a native TTL, narrow role attributes and exactly the requested privileges", async () => {
    const caps = provider.capabilities();
    expect(caps.nativeTtl).toBe(true);
    expect(caps.live).toBe(true);
    const created = await newLease();
    await approve(created.id, created.plan_hash);
    await h.drain();
    const detail = await getLease(h, ws.operator.session, created.id);
    expect(detail.state).toBe("active");
    const role = providerRoleFor(created.id);
    const facts = await roleFacts(h.target!.clusterUrl, role);
    expect(facts.exists).toBe(true);
    expect(facts.canLogin).toBe(true);
    // The provider, not AccessLease's scheduler, holds the hard expiry: VALID UNTIL equals the lease expiry.
    expect(Math.abs(facts.validUntil!.getTime() - new Date(detail.expires_at).getTime())).toBeLessThanOrEqual(1000);
    const attrs = await sql(h.target!.clusterUrl, "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit FROM pg_roles WHERE rolname = $1", [role]);
    expect(attrs[0]).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolconnlimit: 5 });
    const privileges = await sql(h.target!.adminUrl, "SELECT table_schema, table_name, privilege_type FROM information_schema.table_privileges WHERE grantee = $1 ORDER BY 1,2,3", [role]);
    expect(privileges).toEqual([{ table_schema: "app", table_name: "records", privilege_type: "SELECT" }]);
  });

  it("an ambiguous issue (the write happened but the call failed) enters ISSUE_UNKNOWN and reconciles to the same grant without a duplicate", async () => {
    const created = await newLease();
    await approve(created.id, created.plan_hash);
    let calls = 0;
    provider.issue = async (request) => {
      calls += 1;
      await original(request); // the remote write really happens ...
      throw new ProviderUnavailableError("provider_ambiguous", "connection dropped after the write (injected)"); // ... but the caller never learns the outcome
    };
    await h.worker();
    provider.issue = original;
    const unknown = await getLease(h, ws.operator.session, created.id);
    expect(unknown.state).toBe("issue_unknown");
    expect(unknown.warning).toBeTruthy();
    expect(unknown.revocation_status).not.toBe("verified");
    expect(await roleCount(created.id)).toBe(1);
    const beforeRef = unknown.provider_grant?.provider_ref;
    await waitFor("reconciliation to adopt the existing grant", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, created.id)).state === "active";
    }, 60_000, 500);
    const active = await getLease(h, ws.operator.session, created.id);
    expect(active.provider_grant?.provider_ref).toBe(providerRoleFor(created.id));
    if (beforeRef) expect(active.provider_grant?.provider_ref).toBe(beforeRef);
    expect(await roleCount(created.id)).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("a real provider outage during issuance (cluster frozen) enters ISSUE_UNKNOWN, then converges on one grant when the provider returns", async () => {
    const created = await newLease();
    await approve(created.id, created.plan_hash);
    await withProviderPaused(async () => {
      await h.worker();
    });
    const state = (await getLease(h, ws.operator.session, created.id)).state;
    expect(["issue_unknown", "issuing"]).toContain(state);
    expect(state).not.toBe("active");
    await waitFor("convergence after the outage", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, created.id)).state === "active";
    }, 90_000, 750);
    expect(await roleCount(created.id)).toBe(1);
  });

  it("a definite provider rejection (target database does not exist) never reaches ACTIVE, creates no role and ends REVOKED_VERIFIED with an explicit reason", async () => {
    const created = await newLease({ resource_ref: "al_missing_database" });
    await approve(created.id, created.plan_hash);
    await h.drain();
    const detail = await getLease(h, ws.operator.session, created.id);
    expect(detail.state).toBe("revoked_verified");
    expect(detail.close_reason).toBe("issue_failed");
    expect(detail.credential_available).toBe(false);
    expect(await roleCount(created.id)).toBe(0);
  });

  it("a provider without a native TTL is refused at registration", () => {
    const withoutTtl = Object.create(provider) as Provider;
    withoutTtl.capabilities = () => ({ ...provider.capabilities(), nativeTtl: false });
    expect(() => new ProviderRegistry([withoutTtl], "postgres-role"), "constructing a registry with a provider that cannot enforce a TTL natively must throw").toThrow();
    const registry = new ProviderRegistry([], "postgres-role");
    expect(() => registry.register(withoutTtl), "registering a provider that cannot enforce a TTL natively must throw").toThrow();
    expect(registry.kinds()).toEqual([]);
  });

  it("a provider that stops enforcing a native TTL after registration is never used to issue", async () => {
    const created = await newLease();
    const real = provider.capabilities.bind(provider);
    provider.capabilities = () => ({ ...real(), nativeTtl: false });
    try {
      const res = await h.client.post(ws.operator.session, `/leases/${created.id}/approve`, { plan_hash: created.plan_hash });
      expect([422, 503]).toContain(res.status);
      await h.drain();
    } finally {
      provider.capabilities = real;
    }
    expect((await getLease(h, ws.operator.session, created.id)).state).not.toBe("active");
    expect(await roleCount(created.id)).toBe(0);
  });
}
