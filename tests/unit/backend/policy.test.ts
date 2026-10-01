import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { genericScopeCheck } from "../../../src/domain/scopes.js";
import { AppError } from "../../../src/errors.js";
import { approveLease, getLease, listLeases, requestLease } from "../../../src/services/leases.js";
import { computePlanHash, evaluateLease, getPolicy, policyHashOf, setPolicy } from "../../../src/services/policy.js";
import { drive, type Env, goodRequest, iso, makeEnv } from "./helpers.js";

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

describe("AC-01 scope and TTL policy", () => {
  it("accepts a narrow scope and defaults the TTL to one hour", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest());
    expect(created.state).toBe("requested");
    expect(created.http_status).toBe(201);
    expect(created.lease.expires_at).toBe(iso(env.clock, 3600));
    expect(created.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.lease.provider).toEqual({ kind: "synthetic", label: "SYNTHETIC", live: false });
  });

  it.each([
    ["*", "scope_wildcard"],
    ["synthetic:*:read", "scope_wildcard"],
    ["synthetic:sandbox:%", "scope_wildcard"],
    ["ALL PRIVILEGES", "scope_wildcard"],
    ["all", "scope_wildcard"],
    ["pg:public.*:select", "scope_wildcard"],
    ["admin", "scope_forbidden"],
    ["synthetic:admin:read", "scope_forbidden"],
    ["root", "scope_forbidden"],
    ["superuser", "scope_forbidden"],
    ["synthetic:sandbox:owner", "scope_forbidden"],
    ["pg:public.users:createrole", "scope_forbidden"],
    ["synthetic:sandbox:execute", "scope_forbidden"],
    ["synthetic:sandbox", "invalid_scope"],
    ["not a scope", "invalid_scope"],
  ])("rejects scope %j with %s and creates nothing", async (scope, code) => {
    const before = await listLeases(env.ctx, env.viewer, { limit: 100 });
    const error = await rejects(requestLease(env.ctx, env.operator, goodRequest({ scopes: [scope] })));
    expect(error.status).toBe(422);
    expect(error.code).toBe(code);
    const after = await listLeases(env.ctx, env.viewer, { limit: 100 });
    expect(after.items.length).toBe(before.items.length);
  });

  it("rejects a TTL over the policy maximum (8 h) and accepts exactly the maximum", async () => {
    const over = await rejects(requestLease(env.ctx, env.operator, goodRequest({ expires_at: iso(env.clock, 8 * 3600 + 1) })));
    expect([over.status, over.code]).toEqual([422, "ttl_exceeds_max"]);
    const exact = await requestLease(env.ctx, env.operator, goodRequest({ expires_at: iso(env.clock, 8 * 3600) }));
    expect(exact.state).toBe("requested");
  });

  it("rejects a TTL under the minimum and an expiry in the past", async () => {
    const short = await rejects(requestLease(env.ctx, env.operator, goodRequest({ expires_at: iso(env.clock, 5) })));
    expect(short.code).toBe("ttl_below_min");
    const past = await rejects(requestLease(env.ctx, env.operator, goodRequest({ expires_at: iso(env.clock, -5) })));
    expect(past.code).toBe("expires_in_past");
  });

  it("rejects unknown fields, empty scope lists, non-UTC expiries and oversize scope lists", async () => {
    for (const bad of [{ extra: 1 }, { scopes: [] }, { expires_at: "2026-03-01T14:00:00+02:00" }, { scopes: Array.from({ length: 21 }, (_, i) => `synthetic:r${i}:read`) }]) {
      const error = await rejects(requestLease(env.ctx, env.operator, goodRequest(bad)));
      expect([error.status, error.code]).toEqual([422, "validation_failed"]);
    }
    const nul = await rejects(requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bad\u0000ref" })));
    expect(nul.code).toBe("validation_failed");
  });

  it("de-duplicates and sorts scopes so the plan hash is order independent", async () => {
    const a = await requestLease(env.ctx, env.operator, goodRequest({ scopes: ["synthetic:b:read", "synthetic:a:write", "synthetic:b:read"], expires_at: iso(env.clock, 900) }));
    const b = await requestLease(env.ctx, env.operator, goodRequest({ scopes: ["synthetic:a:write", "synthetic:b:read"], expires_at: iso(env.clock, 900) }));
    expect(a.lease.scopes).toEqual(["synthetic:a:write", "synthetic:b:read"]);
    expect(a.plan_hash).toBe(b.plan_hash);
  });

  it("only admins change the policy; the defaults and hard maximum are configurable", async () => {
    expect((await rejects(setPolicy(env.ctx, env.operator, { max_ttl_seconds: 7200 }))).status).toBe(403);
    expect((await rejects(setPolicy(env.ctx, env.viewer, { max_ttl_seconds: 7200 }))).status).toBe(403);
    const before = await getPolicy(env.ctx, env.viewer);
    expect([before.default_ttl_seconds, before.max_ttl_seconds, before.min_ttl_seconds]).toEqual([3600, 28800, 60]);
    const updated = await setPolicy(env.ctx, env.admin, { max_ttl_seconds: 7200, default_ttl_seconds: 1800, expected_version: before.version });
    expect(updated.version).toBe(before.version + 1);
    expect(updated.policy_hash).not.toBe(before.policy_hash);
    const over = await rejects(requestLease(env.ctx, env.operator, goodRequest({ expires_at: iso(env.clock, 7201) })));
    expect(over.code).toBe("ttl_exceeds_max");
    const defaulted = await requestLease(env.ctx, env.operator, goodRequest());
    expect(defaulted.lease.expires_at).toBe(iso(env.clock, 1800));
    // restore for the other tests
    await setPolicy(env.ctx, env.admin, { max_ttl_seconds: 28800, default_ttl_seconds: 3600 });
  });

  it("validates policy updates (ceiling, ordering, prefixes, expected_version)", async () => {
    for (const bad of [{ max_ttl_seconds: 90_000 }, { min_ttl_seconds: 5000 }, { scope_deny_prefixes: ["synthetic:*"] }, { approval_ttl_seconds: 100_000 }]) {
      expect((await rejects(setPolicy(env.ctx, env.admin, bad))).code).toBe("policy_invalid");
    }
    expect((await rejects(setPolicy(env.ctx, env.admin, { bogus: true }))).code).toBe("validation_failed");
    expect((await rejects(setPolicy(env.ctx, env.admin, { retention_days: 30, expected_version: 999 }))).code).toBe("version_conflict");
    const ok = await setPolicy(env.ctx, env.admin, { retention_days: 30 });
    expect(ok.retention_days).toBe(30);
  });

  it("applies scope allow and deny prefixes from the policy", async () => {
    await setPolicy(env.ctx, env.admin, { scope_allow_prefixes: ["synthetic:sandbox:"], scope_deny_prefixes: ["synthetic:sandbox:write"] });
    const ok = await requestLease(env.ctx, env.operator, goodRequest({ scopes: ["synthetic:sandbox:read"] }));
    expect(ok.state).toBe("requested");
    expect((await rejects(requestLease(env.ctx, env.operator, goodRequest({ scopes: ["synthetic:sandbox:write"] })))).code).toBe("scope_forbidden");
    expect((await rejects(requestLease(env.ctx, env.operator, goodRequest({ scopes: ["synthetic:other:read"] })))).code).toBe("scope_forbidden");
    await setPolicy(env.ctx, env.admin, { scope_allow_prefixes: [], scope_deny_prefixes: [] });
  });

  it("records policy rejections in the workspace audit trail without the rejected content", async () => {
    await rejects(requestLease(env.ctx, env.operator, goodRequest({ scopes: ["superuser"] })));
    const rows = (await env.ctx.db.query<{ redacted_metadata: Record<string, unknown> }>("SELECT redacted_metadata FROM audit_events WHERE action = 'policy.rejected' ORDER BY seq DESC LIMIT 1")).rows;
    expect(rows[0]?.redacted_metadata).toEqual({ code: "scope_forbidden" });
  });

  it("viewers cannot request leases (RBAC)", async () => {
    expect((await rejects(requestLease(env.ctx, env.viewer, goodRequest()))).status).toBe(403);
  });

  it("genericScopeCheck covers control characters, length and whitespace", () => {
    expect(genericScopeCheck("").ok).toBe(false);
    expect(genericScopeCheck("a".repeat(201)).ok).toBe(false);
    expect(genericScopeCheck("synthetic:x\u0001:read")).toMatchObject({ ok: false, code: "invalid_scope" });
    expect(genericScopeCheck("synthetic:sandbox:read")).toEqual({ ok: true });
  });

  it("evaluateLease validates the provider resource", () => {
    expect(() =>
      evaluateLease({
        policy: { min_ttl_seconds: 60, max_ttl_seconds: 3600, scope_allow_prefixes: [], scope_deny_prefixes: [] },
        provider: env.provider,
        resource: "Bad Resource!",
        scopes: ["synthetic:sandbox:read"],
        expiresAt: new Date(env.clock().getTime() + 600_000),
        now: env.clock(),
      }),
    ).toThrow(AppError);
  });
});

describe("AC-02 approval binding", () => {
  it("binds approval to the exact plan hash and enqueues issuance", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-1" }));
    const wrong = await rejects(approveLease(env.ctx, env.operator, created.id, { plan_hash: "0".repeat(64) }));
    expect([wrong.status, wrong.code]).toEqual([409, "plan_hash_mismatch"]);
    expect((await getLease(env.ctx, env.viewer, created.id)).state).toBe("requested");
    const ok = await approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash });
    expect(ok.http_status).toBe(202);
    expect(ok.state).toBe("approved");
    expect(ok.lease.approval?.actor_ref).toBe(env.operator.actorRef);
    const jobs = await env.ctx.db.query("SELECT 1 FROM jobs WHERE lease_id = $1 AND type = 'issue'", [created.id]);
    expect(jobs.rows).toHaveLength(1);
  });

  it("a changed request has a different plan hash and the old hash cannot approve it", async () => {
    const a = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-2", expires_at: iso(env.clock, 900) }));
    const b = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-2", expires_at: iso(env.clock, 901) }));
    const c = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-2", expires_at: iso(env.clock, 900), subject_ref: "someone-else" }));
    const d = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-2", expires_at: iso(env.clock, 900), resource_ref: "other" }));
    const e = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-2", expires_at: iso(env.clock, 900), scopes: ["synthetic:sandbox:write"] }));
    const hashes = new Set([a, b, c, d, e].map((r) => r.plan_hash));
    expect(hashes.size).toBe(5);
    expect((await rejects(approveLease(env.ctx, env.operator, b.id, { plan_hash: a.plan_hash }))).code).toBe("plan_hash_mismatch");
  });

  it("a lease can be approved only once and only from REQUESTED", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-3" }));
    await approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash });
    expect((await rejects(approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash }))).code).toBe("invalid_transition");
  });

  it("refuses to approve a lease that expired or is about to, and when the policy changed since the request", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-4", expires_at: iso(env.clock, 120) }));
    env.clock.advance(100);
    expect((await rejects(approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash }))).code).toBe("stale_plan");
    env.clock.advance(100);
    expect((await rejects(approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash }))).code).toBe("stale_plan");
    const fresh = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-5" }));
    await setPolicy(env.ctx, env.admin, { default_ttl_seconds: 1200 });
    expect((await rejects(approveLease(env.ctx, env.operator, fresh.id, { plan_hash: fresh.plan_hash }))).code).toBe("stale_plan");
    await setPolicy(env.ctx, env.admin, { default_ttl_seconds: 3600 });
    await drive(env);
  });

  it("an expired approval cannot issue access", async () => {
    await setPolicy(env.ctx, env.admin, { approval_ttl_seconds: 30 });
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-6" }));
    await approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash });
    env.clock.advance(31);
    await drive(env);
    const detail = await getLease(env.ctx, env.viewer, created.id);
    expect(detail.close_reason).toBe("approval_expired");
    expect(env.provider.hasGrant(created.id)).toBe(false);
    expect(detail.state).toBe("revoked_verified");
    await setPolicy(env.ctx, env.admin, { approval_ttl_seconds: 900 });
  });

  it("approval requires operator or admin and a UUID lease id; unknown ids are 404", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-7" }));
    expect((await rejects(approveLease(env.ctx, env.viewer, created.id, { plan_hash: created.plan_hash }))).status).toBe(403);
    expect((await rejects(approveLease(env.ctx, env.operator, "not-a-uuid", { plan_hash: created.plan_hash }))).status).toBe(404);
    expect((await rejects(approveLease(env.ctx, env.operator, randomUUID(), { plan_hash: created.plan_hash }))).status).toBe(404);
    expect((await rejects(approveLease(env.ctx, env.operator, created.id, { plan_hash: "xyz" }))).status).toBe(422);
    const adminApproved = await approveLease(env.ctx, env.admin, created.id, { plan_hash: created.plan_hash, expected_version: 1 });
    expect(adminApproved.state).toBe("approved");
  });

  it("expected_version guards approval", async () => {
    const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "bind-8" }));
    expect((await rejects(approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash, expected_version: 7 }))).code).toBe("version_conflict");
  });

  it("computePlanHash is stable and policyHashOf ignores list order", () => {
    const plan = { task_ref: "t", subject_ref: "s", resource_ref: "r", scopes: ["b", "a"], expires_at: "2026-03-01T12:10:00.000Z", policy_hash: "p" };
    expect(computePlanHash(plan)).toBe(computePlanHash({ ...plan, scopes: ["a", "b", "a"], expires_at: new Date("2026-03-01T12:10:00Z") }));
    const rules = { default_ttl_seconds: 1, max_ttl_seconds: 2, min_ttl_seconds: 1, approval_ttl_seconds: 5, scope_allow_prefixes: ["b", "a"], scope_deny_prefixes: [] };
    expect(policyHashOf(rules)).toBe(policyHashOf({ ...rules, scope_allow_prefixes: ["a", "b"] }));
  });
});
