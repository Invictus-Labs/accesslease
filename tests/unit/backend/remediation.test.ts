import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { ProviderRegistry } from "../../../src/connectors/provider.js";
import { openDatabase } from "../../../src/db/index.js";
import { canonicalJson, contentHash } from "../../../src/domain/canonical.js";
import { buildApp } from "../../../src/server.js";
import { runDoctor } from "../../../src/services/doctor.js";
import { exportBundle, importBundle, verifyBundle } from "../../../src/services/evidence.js";
import { approveLease, getLease, requestLease } from "../../../src/services/leases.js";
import { getPolicy, policyHashOf, setPolicy } from "../../../src/services/policy.js";
import { drive, type Env, goodRequest, makeEnv, requestApprove, testDatabaseUrl, testProviderUrl } from "./helpers.js";

const PLANTED = "PLANTED_SECRET_TOKEN_backend_remediation_01";
let env: Env;
let app: FastifyInstance;
let clean: any;
let leaseId: string;
let adminHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;

async function session(email: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "synthetic-password-123" } });
  expect(response.statusCode).toBe(200);
  return { cookie: String(response.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": response.json().csrf_token };
}

beforeAll(async () => {
  env = await makeEnv();
  app = await buildApp(env.ctx, { logRequests: true });
  adminHeaders = await session("admin-main@example.test");
  viewerHeaders = await session("viewer-main@example.test");
  const lease = await requestLease(env.ctx, env.operator, goodRequest());
  leaseId = lease.id;
  clean = JSON.parse((await exportBundle(env.ctx, env.operator)).bytes.toString());
  expect(verifyBundle(Buffer.from(JSON.stringify(clean)))).toMatchObject({ ok: true });
});
afterAll(async () => {
  await app?.close();
  await env?.drop();
});

function bundleWith(change: (bundle: any) => void) {
  const bundle = structuredClone(clean);
  change(bundle);
  for (const entry of bundle.manifest.files) {
    entry.sha256 = contentHash(bundle.files[entry.path]);
    entry.bytes = Buffer.byteLength(canonicalJson(bundle.files[entry.path]));
  }
  bundle.manifest.total_bytes = bundle.manifest.files.reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  bundle.manifest.manifest_hash = contentHash(bundle.manifest.files);
  const { bundle_hash: _old, ...unhashed } = bundle;
  bundle.bundle_hash = contentHash(unhashed);
  return bundle;
}

async function importCounts() {
  return (await env.ctx.db.query("SELECT (SELECT count(*)::int FROM evidence_imports) AS imports, (SELECT count(*)::int FROM imported_leases) AS leases, (SELECT count(*)::int FROM audit_events) AS audit")).rows[0];
}

it("public version and ordinary unknown-key errors keep stable codes without secret reflection", async () => {
  const invalid = JSON.stringify({ kind: "accesslease.evidence-bundle", schema_version: PLANTED });
  const verified = await app.inject({ method: "POST", url: "/api/v1/evidence/verify", headers: { ...adminHeaders, "content-type": "application/json" }, payload: invalid });
  const imported = await app.inject({ method: "POST", url: "/api/v1/evidence/import", headers: { ...adminHeaders, "content-type": "application/json" }, payload: invalid });
  const unknown = await app.inject({ method: "POST", url: "/api/v1/leases", headers: adminHeaders, payload: goodRequest({ [PLANTED]: "ordinary value" }) });
  expect(verified.statusCode).toBe(200);
  expect(verified.json()).toMatchObject({ ok: false, code: "bundle_unsupported_version" });
  expect(imported.statusCode).toBe(422);
  expect(imported.json().error.code).toBe("bundle_unsupported_version");
  expect(unknown.statusCode).toBe(422);
  expect(unknown.json().error.code).toBe("validation_failed");
  expect([verified.body, imported.body, unknown.body, ...env.logs].join("\n")).not.toContain(PLANTED);
  expect(unknown.body).toContain("[REDACTED]");
});

it.each(["task", "nested-extra", "member-name"])("hash-valid %s secret evidence is rejected before any import write", async (carrier) => {
  const bundle = bundleWith((b) => {
    const doc = b.files[`leases/${leaseId}.json`];
    if (carrier === "task") doc.lease.task_ref = PLANTED;
    if (carrier === "nested-extra") doc.extra = { details: [{ password: "synthetic-hidden-value" }] };
    if (carrier === "member-name") doc[PLANTED] = "ordinary value";
  });
  // Independent integrity positive: original bytes and every declared hash agree.
  expect(contentHash(bundle.files[`leases/${leaseId}.json`])).toBe(bundle.manifest.files.find((e: any) => e.path === `leases/${leaseId}.json`).sha256);
  const before = await importCounts();
  const response = await app.inject({ method: "POST", url: "/api/v1/evidence/import", headers: { ...adminHeaders, "content-type": "application/json" }, payload: JSON.stringify(bundle) });
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().error.code).toBe("bundle_schema_invalid");
  expect(response.body).not.toContain(PLANTED);
  expect(response.body).not.toContain("synthetic-hidden-value");
  expect(await importCounts()).toEqual(before);
});

it("clean extra members preserve original verified identity and stored unsafe documents cannot be returned", async () => {
  const bundle = bundleWith((b) => { b.files[`leases/${leaseId}.json`].extra = { notes: ["harmless"], session_count: 2 }; });
  const bytes = Buffer.from(JSON.stringify(bundle));
  expect(verifyBundle(bytes)).toMatchObject({ ok: true, bundle_hash: bundle.bundle_hash });
  const receipt = await importBundle(env.ctx, env.admin, bytes);
  const url = `/api/v1/imports/${receipt.import_id}/leases/${leaseId}`;
  const safe = await app.inject({ method: "GET", url, headers: viewerHeaders });
  expect(safe.statusCode).toBe(200);
  expect(safe.json()).toMatchObject({ hash_verified: true, evidence: bundle.files[`leases/${leaseId}.json`] });
  const original = (await env.ctx.db.query("SELECT doc_hash FROM imported_leases WHERE import_id=$1", [receipt.import_id])).rows[0];
  expect(original.doc_hash).toBe(contentHash(bundle.files[`leases/${leaseId}.json`]));
  const unsafe = structuredClone(bundle.files[`leases/${leaseId}.json`]);
  unsafe.extra.notes = [PLANTED];
  // Controlled historical-row fixture: no repair; independently matching hash.
  await env.ctx.db.query("UPDATE imported_leases SET doc=$2, doc_hash=$3 WHERE import_id=$1", [receipt.import_id, JSON.stringify(unsafe), contentHash(unsafe)]);
  const refused = await app.inject({ method: "GET", url, headers: viewerHeaders });
  expect(refused.statusCode).toBe(422);
  expect(refused.json().error.code).toBe("bundle_schema_invalid");
  expect(refused.body).not.toContain(PLANTED);
});

it("doctor certifies only real distinct cluster identities and refuses missing metadata identity", async () => {
  const provider = new PostgresRoleProvider({ adminUrl: testProviderUrl(), allowlist: ["127.0.0.1"] });
  const e = await makeEnv({ providers: [provider] });
  const role = `al_diag_${randomBytes(5).toString("hex")}`;
  let weak: ReturnType<typeof openDatabase> | undefined;
  try {
    expect((await runDoctor(e.ctx)).checks.find((c) => c.name === "provider:separation")).toMatchObject({ status: "ok" });
    const same = new PostgresRoleProvider({ adminUrl: testDatabaseUrl(), allowlist: ["127.0.0.1"] });
    expect((await runDoctor({ ...e.ctx, providers: new ProviderRegistry([same], "postgres-role") })).checks.find((c) => c.name === "provider:separation")).toMatchObject({ status: "fail" });
    await e.ctx.db.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-diagnostic-password' NOSUPERUSER`);
    await e.ctx.db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await e.ctx.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    // Owned disposable database only: reproduce an operator-restricted identity function.
    await e.ctx.db.query("REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC");
    const url = new URL(e.url);
    url.username = role;
    url.password = "synthetic-diagnostic-password";
    weak = openDatabase(url.toString());
    await expect(weak.query("SELECT system_identifier::text FROM pg_control_system()")).rejects.toMatchObject({ code: "42501" });
    const result = await runDoctor({ ...e.ctx, db: weak });
    expect(result.checks.find((c) => c.name === "provider:separation")).toMatchObject({ status: "unavailable", hint: expect.any(String) });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  } finally {
    await weak?.close();
    await e.ctx.db.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await e.ctx.db.query(`DROP ROLE IF EXISTS ${role}`);
    await e.drop();
  }
});

it("policy hashes project exactly six rules despite operational/runtime properties", async () => {
  const policy = await getPolicy(env.ctx, env.viewer);
  const expected = contentHash({ default_ttl_seconds: policy.default_ttl_seconds, max_ttl_seconds: policy.max_ttl_seconds,
    min_ttl_seconds: policy.min_ttl_seconds, approval_ttl_seconds: policy.approval_ttl_seconds,
    scope_allow_prefixes: [...policy.scope_allow_prefixes].sort(), scope_deny_prefixes: [...policy.scope_deny_prefixes].sort() });
  expect(policyHashOf({ ...policy, retention_days: policy.retention_days + 1, runtime_extra: "ignored" } as typeof policy)).toBe(expected);
});

it.each(["no-op", "retention-only"])("%s policy saves preserve pending approval and approved issuance", async (change) => {
  const e = await makeEnv();
  try {
    const pending = await requestLease(e.ctx, e.operator, goodRequest());
    const approved = await requestApprove(e, { task_ref: "already-approved" });
    const before = await getPolicy(e.ctx, e.viewer);
    const after = await setPolicy(e.ctx, e.admin, change === "no-op" ? {} : { retention_days: before.retention_days + 1 });
    expect(after.policy_hash).toBe(before.policy_hash);
    await approveLease(e.ctx, e.operator, pending.id, { plan_hash: pending.plan_hash });
    await drive(e);
    expect((await getLease(e.ctx, e.viewer, pending.id)).state).toBe("active");
    expect((await getLease(e.ctx, e.viewer, approved.id)).state).toBe("active");
  } finally { await e.drop(); }
});

it.each([{ default_ttl_seconds: 1800 }, { scope_deny_prefixes: ["synthetic:other:"] }])("real lease-rule edit %j still invalidates approval and issuance", async (change) => {
  const e = await makeEnv();
  try {
    const pending = await requestLease(e.ctx, e.operator, goodRequest());
    const approved = await requestApprove(e, { task_ref: "already-approved" });
    const before = await getPolicy(e.ctx, e.viewer);
    expect((await setPolicy(e.ctx, e.admin, change)).policy_hash).not.toBe(before.policy_hash);
    await expect(approveLease(e.ctx, e.operator, pending.id, { plan_hash: pending.plan_hash })).rejects.toMatchObject({ code: "stale_plan" });
    await drive(e);
    expect(e.provider.hasGrant(approved.id)).toBe(false);
    expect((await getLease(e.ctx, e.viewer, approved.id)).state).not.toBe("active");
  } finally { await e.drop(); }
});
