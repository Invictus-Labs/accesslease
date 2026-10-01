import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { buildProviders } from "../../../src/connectors/factory.js";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { type Provider, ProviderRegistry } from "../../../src/connectors/provider.js";
import { SyntheticProvider } from "../../../src/connectors/synthetic.js";
import { type Ctx, fixedClock } from "../../../src/context.js";
import { openDatabase } from "../../../src/db/index.js";
import { migrationStatus } from "../../../src/db/migrate.js";
import { createLogger } from "../../../src/lib/log.js";
import { revokeUserSessions, login, listMembers } from "../../../src/services/auth.js";
import { runDoctor } from "../../../src/services/doctor.js";
import { pullEvents } from "../../../src/services/events.js";
import { claimJob, listJobs } from "../../../src/services/jobs.js";
import { closeLease, getLease, listLeases, requestLease, revokeLease } from "../../../src/services/leases.js";
import { purgeExpiredEvidence } from "../../../src/services/retention.js";
import { setPolicy } from "../../../src/services/policy.js";
import { runWorker, runWorkerOnce } from "../../../src/workers/index.js";
import { processRevoke } from "../../../src/workers/revoke.js";
import { drive, type Env, freshDatabase, goodRequest, iso, makeEnv, requestApprove, testDatabaseUrl, testProviderUrl, withDatabase } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => {
  await env.drop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AC-13 restart, restore and failure containment", () => {
  it("a restored database copy preserves references, events and pending work, and resumes safely", async () => {
    const source = await makeEnv();
    const active = await requestApprove(source, { task_ref: "restore-active" });
    const pending = await requestApprove(source, { task_ref: "restore-pending" });
    await drive(source); // both ACTIVE
    const approvedOnly = await requestApprove(source, { task_ref: "restore-approved" });
    const done = await requestApprove(source, { task_ref: "restore-done" });
    await drive(source);
    await closeLease(source.ctx, source.operator, done.id, { reason: "done" });
    await drive(source);
    const beforeDetail = await getLease(source.ctx, source.viewer, active.id);
    const beforeEvents = await pullEvents(source.ctx, source.viewer, { limit: 100 });
    const queuedBefore = (await source.ctx.db.query("SELECT 1 FROM jobs WHERE state = 'queued'")).rows.length;
    // "backup": a physical copy of the database taken while the application is stopped (the runbook uses pg_dump / pg_basebackup)
    await source.ctx.db.close();
    const adminUrl = testDatabaseUrl();
    const copyName = `al_restore_${randomBytes(4).toString("hex")}`;
    const sourceName = new URL(source.url).pathname.slice(1);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${copyName} TEMPLATE ${sourceName}`);
    await admin.end();
    const restoredDb = openDatabase(withDatabase(adminUrl, copyName));
    try {
      const ctx: Ctx = { ...source.ctx, db: restoredDb };
      expect(await migrationStatus(restoredDb)).toMatchObject({ ok: true });
      // references are intact: every child row points at an existing lease of the same workspace
      const orphans = await restoredDb.query(
        `SELECT (SELECT count(*) FROM audit_events a WHERE a.lease_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.id = a.lease_id AND l.workspace_id = a.workspace_id))::int AS audit,
                (SELECT count(*) FROM events e WHERE NOT EXISTS (SELECT 1 FROM leases l WHERE l.id = e.lease_id AND l.workspace_id = e.workspace_id))::int AS events,
                (SELECT count(*) FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM leases l WHERE l.id = j.lease_id AND l.workspace_id = j.workspace_id))::int AS jobs,
                (SELECT count(*) FROM revocation_attempts r WHERE NOT EXISTS (SELECT 1 FROM leases l WHERE l.id = r.lease_id))::int AS attempts`,
      );
      expect(orphans.rows[0]).toEqual({ audit: 0, events: 0, jobs: 0, attempts: 0 });
      expect(await getLease(ctx, source.viewer, active.id)).toEqual(beforeDetail);
      expect(await pullEvents(ctx, source.viewer, { limit: 100 })).toEqual(beforeEvents);
      expect((await restoredDb.query("SELECT 1 FROM jobs WHERE state = 'queued'")).rows).toHaveLength(queuedBefore);
      // after restore the worker resumes: the approved lease is issued, the active ones stay active, revoked ones stay final
      source.clock.advance(5);
      await runWorkerOnce(ctx, { workerId: "restored-worker" });
      expect((await getLease(ctx, source.viewer, approvedOnly.id)).state).toBe("active");
      expect((await getLease(ctx, source.viewer, pending.id)).state).toBe("active");
      expect((await getLease(ctx, source.viewer, done.id)).state).toBe("revoked_verified");
      // event sequence continues without gaps or reuse
      await requestLease(ctx, source.operator, goodRequest({ task_ref: "after-restore" }));
      const all = await pullEvents(ctx, source.viewer, { limit: 100 });
      expect(new Set(all.items.map((e) => e.event_id)).size).toBe(all.items.length);
      expect(all.items.length).toBeGreaterThan(beforeEvents.items.length);
    } finally {
      await restoredDb.close();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${copyName} WITH (FORCE)`);
      await cleanup.query(`DROP DATABASE IF EXISTS ${sourceName} WITH (FORCE)`);
      await cleanup.end();
    }
  });

  it("an unexpected processing error keeps the job with a visible error and the job is retried", async () => {
    const e = await makeEnv();
    try {
      const lease = await requestApprove(e, { task_ref: "unexpected" });
      const original = e.provider.providerRefFor.bind(e.provider);
      e.provider.providerRefFor = () => {
        throw Object.assign(new Error("internal glitch password=hunter2"), { code: "GLITCH" });
      };
      const pass = await runWorkerOnce(e.ctx, { workerId: "w" });
      expect(pass.jobsProcessed).toBe(1);
      const job = (await e.ctx.db.query<{ state: string; last_error: string }>("SELECT state, last_error FROM jobs WHERE lease_id = $1", [lease.id])).rows[0];
      expect(job).toEqual({ state: "queued", last_error: "GLITCH" });
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("approved");
      expect(e.logs.join("\n")).toContain("job.failed");
      expect(e.logs.join("\n")).not.toContain("hunter2");
      const jobs = await listJobs(e.ctx, e.operator);
      expect(jobs[0]).toMatchObject({ status: "failed", last_error: "GLITCH" });
      e.provider.providerRefFor = original;
      e.clock.advance(60);
      await drive(e);
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("active");
    } finally {
      await e.drop();
    }
  });

  it("a worker that lost its job lease cannot commit and leaves the lease for the new owner", async () => {
    const e = await makeEnv();
    try {
      const lease = await requestApprove(e, { task_ref: "lease-lost" }, 3600);
      let stolen = false;
      const original = e.provider.issue.bind(e.provider);
      e.provider.issue = async (request) => {
        const result = await original(request);
        if (!stolen) {
          stolen = true;
          e.clock.advance(130); // our worker lease (120 s) expires while the provider call is in flight
          await claimJob(e.ctx.db, "other-worker", e.clock, 120);
        }
        return result;
      };
      const pass = await runWorkerOnce(e.ctx, { workerId: "slow-worker" });
      expect(pass.jobsProcessed).toBeGreaterThanOrEqual(1);
      expect(e.logs.join("\n")).toContain("job.lease_lost");
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("issuing");
      // the other worker's claim is stale too (we never completed it): it expires, is reclaimed and reconciles the grant
      e.clock.advance(130);
      await drive(e);
      const detail = await getLease(e.ctx, e.viewer, lease.id);
      expect(detail.state).toBe("active");
      expect(e.provider.grantCount()).toBe(1);
    } finally {
      await e.drop();
    }
  });

  it("a revoke job whose lease is no longer revoking is completed without effects", async () => {
    const e = await makeEnv();
    try {
      const lease = await requestApprove(e, { task_ref: "stray-revoke" });
      await drive(e);
      await e.ctx.db.query(
        "INSERT INTO jobs (id, workspace_id, lease_id, type, priority, state, next_attempt_at, deduplication_key, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'revoke', 0, 'queued', $3, 'stray', $3, $3)",
        [e.workspaceId, lease.id, e.clock()],
      );
      const job = await claimJob(e.ctx.db, "w", e.clock, 120);
      expect(job?.type).toBe("revoke");
      expect(await processRevoke(e.ctx, job as NonNullable<typeof job>)).toBe("skipped");
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("active");
      await revokeLease(e.ctx, e.operator, lease.id, { reason: "cleanup" });
      await drive(e);
    } finally {
      await e.drop();
    }
  });

  it("the worker loop runs passes, reports them, survives failures and stops on abort", async () => {
    const e = await makeEnv({ settings: { workerPollMs: 20 } });
    try {
      await requestApprove(e, { task_ref: "loop" });
      const controller = new AbortController();
      const passes: number[] = [];
      let failures = 0;
      const originalQuery = e.ctx.db.query;
      const loop = runWorker(e.ctx, {
        signal: controller.signal,
        pollMs: 20,
        workerId: "loop-worker",
        onPass: (report) => {
          passes.push(report.jobsProcessed);
          if (passes.length === 2) {
            // make the next pass throw once: the loop must log it and keep going
            e.ctx.db.query = async () => {
              failures += 1;
              e.ctx.db.query = originalQuery;
              throw new Error("transient database error");
            };
          }
          if (passes.length >= 4) controller.abort();
        },
      });
      await loop;
      expect(passes[0]).toBeGreaterThanOrEqual(1);
      expect(failures).toBe(1);
      expect(e.logs.join("\n")).toContain("worker.pass_failed");
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await runWorker(e.ctx, { signal: alreadyAborted.signal });
    } finally {
      await e.drop();
    }
  });

  it("a provider call that never answers times out: revocation becomes REVOCATION_UNCONFIRMED with a retry and other leases still progress (R-004)", async () => {
    const e = await makeEnv({ settings: { providerCallTimeoutMs: 60, providerRevokeTimeoutMs: 60 } });
    try {
      const hung = await requestApprove(e, { task_ref: "hung-provider" }, 3600);
      const other = await requestApprove(e, { task_ref: "healthy-neighbour" }, 3600);
      await drive(e);
      await revokeLease(e.ctx, e.operator, hung.id, { reason: "silent provider" });
      const originalRevoke = e.provider.revoke.bind(e.provider);
      e.provider.revoke = async (target) => (target.leaseId === hung.id ? new Promise<never>(() => undefined) : originalRevoke(target));
      await closeLease(e.ctx, e.operator, other.id, { reason: "done" });
      const pass = await runWorkerOnce(e.ctx, { workerId: "w" });
      expect(pass.jobsProcessed).toBeGreaterThanOrEqual(2);
      const stuck = await getLease(e.ctx, e.viewer, hung.id);
      expect(stuck.state).toBe("revocation_unconfirmed");
      expect(stuck.next_retry_at).not.toBeNull();
      expect(stuck.attempts[0]).toMatchObject({ result: "provider_error", detail: { error_code: "provider_timeout" } });
      expect((await getLease(e.ctx, e.viewer, other.id)).state).toBe("revoked_verified");
      e.provider.revoke = originalRevoke;
      e.clock.advance(10);
      await drive(e);
      expect((await getLease(e.ctx, e.viewer, hung.id)).state).toBe("revoked_verified");
    } finally {
      await e.drop();
    }
  });

  it("a failed revocation step can never end verified, even when introspection says absent and the probe is denied (R-005)", async () => {
    const e = await makeEnv();
    try {
      const lease = await requestApprove(e, { task_ref: "failed-step" }, 3600);
      await drive(e);
      const originalRevoke = e.provider.revoke.bind(e.provider);
      e.provider.revoke = async (target) => {
        const result = await originalRevoke(target);
        return { ...result, steps: [...result.steps, { step: "terminate_sessions", ok: false, detail: "session still running" }] };
      };
      await revokeLease(e.ctx, e.operator, lease.id, { reason: "x" });
      await drive(e);
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("revocation_unconfirmed");
      e.provider.revoke = originalRevoke;
      e.clock.advance(10);
      await drive(e);
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("revoked_verified");
    } finally {
      await e.drop();
    }
  });

  it("a job whose provider is not configured retries visibly and doctor warns about it", async () => {
    const e = await makeEnv();
    try {
      const lease = await requestApprove(e, { task_ref: "no-provider" });
      (e.ctx.providers as unknown as { providers: Map<string, unknown> }).providers.delete("synthetic");
      await runWorkerOnce(e.ctx, { workerId: "w" });
      const job = (await e.ctx.db.query<{ last_error: string }>("SELECT last_error FROM jobs WHERE lease_id = $1", [lease.id])).rows[0];
      expect(job?.last_error).toBe("provider_disconnected");
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("approved");
      const report = await runDoctor(e.ctx);
      expect(report.checks.find((c) => c.name === "jobs")).toMatchObject({ status: "warn", message: expect.stringContaining("provider_disconnected") });
      (e.ctx.providers as unknown as { register(p: unknown): void }).register(e.provider);
      e.clock.advance(30);
      await drive(e);
      expect((await getLease(e.ctx, e.viewer, lease.id)).state).toBe("active");
      const running = await claimJob(e.ctx.db, "x", e.clock, 10);
      expect(running).toBeNull();
    } finally {
      await e.drop();
    }
  });
});

describe("retention (90 days by default, configurable by admins)", () => {
  it("purges only verified-revoked leases past the window, with all of their history, and never unresolved or live ones", async () => {
    const e = await makeEnv();
    try {
      const old = await requestApprove(e, { task_ref: "old-verified" });
      await drive(e);
      await closeLease(e.ctx, e.operator, old.id, { reason: "done" });
      await drive(e);
      const live = await requestApprove(e, { task_ref: "still-active" }, 8 * 3600);
      await drive(e);
      e.provider.faults.always("revoke", "outage");
      const stuck = await requestApprove(e, { task_ref: "stuck-unconfirmed" }, 8 * 3600);
      await drive(e);
      await revokeLease(e.ctx, e.operator, stuck.id, { reason: "outage" });
      await drive(e);
      await requestLease(e.ctx, e.operator, goodRequest({ task_ref: "just-requested", expires_at: iso(e.clock, 8 * 3600) }));
      await requestLease(e.ctx, e.operator, goodRequest({ scopes: ["*"] })).catch(() => undefined); // leaves a workspace-level audit row

      expect(await purgeExpiredEvidence(e.ctx)).toEqual({ leases: 0, workspaceAudit: 0, imports: 0 });
      await setPolicy(e.ctx, e.admin, { retention_days: 30 });
      e.clock.advance(31 * 86_400);
      const report = await purgeExpiredEvidence(e.ctx);
      expect(report.leases).toBe(1);
      expect(report.workspaceAudit).toBeGreaterThanOrEqual(1);
      const remaining = (await listLeases(e.ctx, e.viewer, { limit: 100 })).items.map((l) => l.task_ref).sort();
      expect(remaining).toEqual(["just-requested", "still-active", "stuck-unconfirmed"]);
      for (const table of ["audit_events", "events", "approvals", "provider_grants", "lease_secrets", "jobs", "revocation_attempts"]) {
        expect((await e.ctx.db.query(`SELECT 1 FROM ${table} WHERE lease_id = $1`, [old.id])).rows, table).toHaveLength(0);
      }
      expect((await e.ctx.db.query("SELECT 1 FROM audit_events WHERE lease_id = $1", [live.id])).rows.length).toBeGreaterThan(0);
      // the append-only triggers still refuse deletes outside the retention transaction
      await expect(e.ctx.db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
      // the worker runs the purge by itself, at most hourly
      const logsBefore = e.logs.length;
      e.clock.advance(31 * 86_400);
      await runWorkerOnce(e.ctx, { workerId: "w" });
      await runWorkerOnce(e.ctx, { workerId: "w" });
      expect(e.logs.slice(logsBefore).join("\n")).not.toContain("retention.failed");
    } finally {
      await e.drop();
    }
  });

  it("purges old restored evidence imports and reports retention failures without stopping the worker", async () => {
    const e = await makeEnv();
    try {
      await e.ctx.db.query(
        "INSERT INTO evidence_imports (id, workspace_id, bundle_hash, source_workspace_id, schema_version, exported_at, imported_at, imported_by, lease_count) VALUES (gen_random_uuid(), $1, 'h', $1, 1, $2, $2, 'cli:local', 0)",
        [e.workspaceId, e.clock()],
      );
      e.clock.advance(100 * 86_400);
      expect((await purgeExpiredEvidence(e.ctx)).imports).toBe(1);
      const failing = { ...e.ctx, db: { ...e.ctx.db, query: async () => Promise.reject(new Error("db down")) } } as unknown as Ctx;
      await expect(runWorkerOnce(failing)).rejects.toThrow();
    } finally {
      await e.drop();
    }
  });
});

describe("doctor against a real provider cluster", () => {
  const providerUrl = testProviderUrl();
  const port = Number(new URL(providerUrl).port);

  it("accepts a privileged, separate cluster and refuses a non-privileged admin or the metadata cluster", async () => {
    const good = new PostgresRoleProvider({ adminUrl: providerUrl, allowlist: ["127.0.0.1"] });
    const e = await makeEnv({ providers: [good] });
    try {
      const report = await runDoctor(e.ctx);
      expect(report.checks.find((c) => c.name === "provider:postgres-role")).toMatchObject({ status: "ok" });
      expect(report.checks.find((c) => c.name === "provider:privileges")).toMatchObject({ status: "ok" });
      expect(report.checks.find((c) => c.name === "provider:separation")).toMatchObject({ status: "ok" });
      expect(report.exitCode).toBe(0);

      const roleName = `al_doc_${randomBytes(3).toString("hex")}`;
      const root = new pg.Client({ connectionString: providerUrl });
      await root.connect();
      await root.query(`CREATE ROLE ${roleName} LOGIN PASSWORD 'doctor-test-password-1' NOSUPERUSER`);
      try {
        const weak = new PostgresRoleProvider({ adminUrl: `postgres://${roleName}:doctor-test-password-1@127.0.0.1:${port}/postgres`, allowlist: ["127.0.0.1"] });
        const weakEnv = { ...e.ctx, providers: new ProviderRegistry([weak], "postgres-role") };
        const weakReport = await runDoctor(weakEnv);
        expect(weakReport.checks.find((c) => c.name === "provider:privileges")).toMatchObject({ status: "fail" });
        expect(weakReport.exitCode).toBe(1);
      } finally {
        await root.query(`DROP ROLE IF EXISTS ${roleName}`);
        await root.end();
      }

      const same = new PostgresRoleProvider({ adminUrl: testDatabaseUrl(), allowlist: ["127.0.0.1"] });
      const sameCtx = { ...e.ctx, providers: new ProviderRegistry([same], "postgres-role") };
      const sameReport = await runDoctor(sameCtx);
      expect(sameReport.checks.find((c) => c.name === "provider:separation")).toMatchObject({ status: "fail", message: expect.stringContaining("IS the metadata cluster") });
      expect(sameReport.exitCode).toBe(1);
    } finally {
      await e.drop();
    }
  });

  it("refuses a provider without native TTL and reports a provider that throws unexpectedly", async () => {
    const noTtl = new SyntheticProvider();
    const e = await makeEnv({ providers: [noTtl] });
    const honest = noTtl.capabilities.bind(noTtl);
    noTtl.capabilities = () => ({ ...honest(), nativeTtl: false });
    expect(() => new ProviderRegistry([noTtl])).toThrow("no native TTL");
    try {
      expect((await runDoctor(e.ctx)).checks.find((c) => c.name === "provider:synthetic")).toMatchObject({ status: "fail", message: expect.stringContaining("no native TTL") });
      const broken: Provider = new PostgresRoleProvider({ adminUrl: providerUrl, allowlist: ["127.0.0.1"] });
      broken.ping = async () => {
        throw new Error("unexpected");
      };
      const ctx = { ...e.ctx, providers: new ProviderRegistry([broken], "postgres-role") };
      expect((await runDoctor(ctx)).checks.find((c) => c.name === "provider:postgres-role")).toMatchObject({ status: "fail" });
    } finally {
      await e.drop();
    }
  });
});

describe("small contracts", () => {
  it("builds exactly the configured provider and requires an admin URL for the live one", () => {
    const base = { ACCESSLEASE_DATABASE_URL: "postgres://u:p@meta.example.test:5432/db", ACCESSLEASE_SECRET_KEY: Buffer.alloc(32, 3).toString("base64") };
    expect(buildProviders(loadConfig(base)).map((p) => p.kind)).toEqual(["synthetic"]);
    const live = loadConfig({ ...base, ACCESSLEASE_PROVIDER: "postgres-role", ACCESSLEASE_PROVIDER_ADMIN_URL: "postgres://root@sandbox.example.test:5432/postgres" });
    expect(buildProviders(live).map((p) => p.kind)).toEqual(["postgres-role"]);
    expect(() => buildProviders({ ...live, providerAdminUrl: null })).toThrow("ACCESSLEASE_PROVIDER_ADMIN_URL is required");
  });

  it("exports the whole service contract from the barrel", async () => {
    const barrel = await import("../../../src/services/index.js");
    expect(Object.keys(barrel.services).sort()).toEqual(
      [
        "approveLease", "bootstrapAdmin", "cliPrincipal", "closeLease", "contextFromConfig", "exportBundle", "getLease", "getPolicy", "getReportData",
        "importBundle", "listLeases", "loadConfig", "migrate", "pullEvents", "requestLease", "retrieveCredential", "revokeLease", "runDemo", "runDoctor",
        "runWorker", "runWorkerOnce", "setPolicy", "sweepOverdue", "unresolvedCount", "verifyBundle",
      ].sort(),
    );
    for (const fn of Object.values(barrel.services)) expect(typeof fn).toBe("function");
    expect(await barrel.migrate(env.ctx)).toEqual({ applied: [] });
    expect(typeof barrel.addMember).toBe("function");
    expect(typeof barrel.getLeaseEvidence).toBe("function");
    expect(typeof barrel.migrationStatus).toBe("function");
  });

  it("logs to stderr by default and revokes user sessions by e-mail", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      createLogger()({ level: "info", event: "stderr.test", token: "abc" });
      expect(String(spy.mock.calls[0]?.[0])).toContain('"event":"stderr.test"');
      expect(String(spy.mock.calls[0]?.[0])).not.toContain("abc");
    } finally {
      spy.mockRestore();
    }
    const first = await login(env.ctx, "viewer-main@example.test", "synthetic-password-123");
    const second = await login(env.ctx, "viewer-main@example.test", "synthetic-password-123", env.workspaceId);
    expect(first.token).not.toBe(second.token);
    expect(await revokeUserSessions(env.ctx, "Viewer-Main@example.test")).toBe(2);
    expect(await revokeUserSessions(env.ctx, "nobody@example.test")).toBe(0);
    expect((await listMembers(env.ctx, env.admin)).map((m) => m.role).sort()).toEqual(["admin", "operator", "viewer"]);
    await expect(listMembers(env.ctx, env.operator)).rejects.toMatchObject({ status: 403 });
    await expect(login(env.ctx, "viewer-main@example.test", "synthetic-password-123", env.other.workspaceId)).rejects.toMatchObject({ status: 401 });
  });

  it("lists jobs with status unknown when a running job's lease expired", async () => {
    const e = await makeEnv();
    try {
      await requestApprove(e, { task_ref: "job-status" });
      await claimJob(e.ctx.db, "w", e.clock, 10);
      expect((await listJobs(e.ctx, e.operator))[0]?.status).toBe("running");
      e.clock.advance(11);
      expect((await listJobs(e.ctx, e.operator))[0]?.status).toBe("unknown");
      await expect(listJobs(e.ctx, e.viewer)).rejects.toMatchObject({ status: 403 });
      const queued = fixedClock(e.clock());
      expect(queued().toISOString()).toBe(e.clock().toISOString());
      queued.set("2030-01-01T00:00:00Z");
      expect(queued().toISOString()).toBe("2030-01-01T00:00:00.000Z");
    } finally {
      await e.drop();
    }
  });

  it("an isolated database helper really isolates (sanity for the test harness)", async () => {
    const a = await freshDatabase("al_iso");
    try {
      await a.db.query("CREATE TABLE t (id int)");
      expect((await a.db.query("SELECT to_regclass('t') AS t")).rows[0]).toMatchObject({ t: "t" });
      await sleep(1);
    } finally {
      await a.drop();
    }
  });
});
