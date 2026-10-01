import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, migrationStatus } from "../../src/services/index.js";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, sleep, waitFor } from "../helpers/clock.js";
import { freshMetadataDatabase, metadataAdminUrl, roleFacts } from "../helpers/db.js";
import { providerRoleFor, sql, tableCounts, tableFingerprint } from "../helpers/oracle.js";
import { repoRoot, spawnChild, waitForLine } from "../helpers/process.js";
import { pauseProvider, unpauseProvider } from "../helpers/docker.js";

/**
 * AC-13: a worker restart reclaims leased jobs without discarding uncertain external outcomes; failed migrations stop readiness;
 * a restored backup preserves references. The worker is a real OS process killed with SIGKILL in the middle of a real provider
 * operation (frozen cluster) and after a real provider commit (blocked outcome write).
 */
export function restartAndRestore(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let resource: string;
  const base = { task_ref: "TASK-AC13", subject_ref: "contractor-crash@example.invalid" };
  const LOCK = 424242;

  beforeAll(async () => {
    h = await createHarness({ provider: "postgres-role", fixedClock: false });
    ws = await h.workspace("ac13");
    resource = h.target!.database;
  });
  afterAll(async () => {
    unpauseProvider();
    await h.close();
    await h.target!.drop();
    await h.database.drop();
  });

  const childEnv = (extra: Record<string, string> = {}) => ({
    ACCESSLEASE_DATABASE_URL: h.database.url,
    ACCESSLEASE_SECRET_KEY: h.secretKey,
    ACCESSLEASE_PROVIDER: "postgres-role",
    ACCESSLEASE_PROVIDER_ADMIN_URL: h.target!.adminUrl,
    ACCESSLEASE_PUBLIC_URL: "http://localhost:8791",
    ACCESSLEASE_EGRESS_ALLOWLIST: "127.0.0.1,localhost",
    ACCESSLEASE_TTL_MIN_SECONDS: "1",
    QA_POLL_MS: "100",
    ...extra,
  });
  const workerScript = join(repoRoot, "tests/helpers/worker-child.mjs");
  const newLease = (ttl = 900) => requestLease(h, ws, { ...base, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), ttl) });
  const approve = (id: string, plan_hash: string) => h.client.post(ws.operator.session, `/leases/${id}/approve`, { plan_hash });
  const rolesNamed = async (id: string) => (await sql(h.target!.clusterUrl, "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [providerRoleFor(id)]))[0]!.n as number;

  it("a worker killed while the provider call is in flight leaves the job reclaimable: the next worker reconciles by lookup and issues exactly one grant", async () => {
    const created = await newLease();
    await approve(created.id, created.plan_hash);
    // The provider cluster is frozen, so the worker is stuck inside its provider call when it is killed.
    pauseProvider();
    const workerA = spawnChild(process.execPath, [workerScript], childEnv({ QA_JOB_LEASE_SECONDS: "3", QA_WORKER_ID: "qa-A" }));
    try {
      await waitForLine(workerA, /^READY$/);
      await waitFor("job claimed and lease in ISSUING", async () => {
        const rows = await sql(h.database.url, "SELECT j.state AS job, l.state AS lease FROM jobs j JOIN leases l ON l.id = j.lease_id WHERE j.lease_id = $1 AND j.type = 'issue'", [created.id]);
        return rows[0]?.job === "running" && rows[0]?.lease === "ISSUING";
      }, 20_000, 50);
    } finally {
      await workerA.kill("SIGKILL"); // crash: no cleanup, no acknowledgement
    }
    unpauseProvider();
    // The crashed worker's outcome was never recorded: the lease is still ISSUING, the job still 'running' until its lease runs out.
    const mid = await getLease(h, ws.operator.session, created.id);
    expect(["issuing", "issue_unknown"]).toContain(mid.state);
    await sleep(3500);
    const workerB = spawnChild(process.execPath, [workerScript], childEnv({ QA_JOB_LEASE_SECONDS: "3", QA_WORKER_ID: "qa-B" }));
    try {
      await waitForLine(workerB, /^READY$/);
      await waitFor("lease ACTIVE after reclaim", async () => (await getLease(h, ws.operator.session, created.id)).state === "active", 60_000, 250);
      const reports = workerB.stdout.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
      expect(reports.some((r) => r.sweep?.jobsReclaimed >= 1), `worker B reports: ${workerB.stdout.join(" ")}`).toBe(true);
    } finally {
      await workerB.kill("SIGTERM");
    }
    const detail = await getLease(h, ws.operator.session, created.id);
    expect(detail.provider_grant?.provider_ref).toBe(providerRoleFor(created.id));
    expect(await rolesNamed(created.id)).toBe(1);
    expect(detail.audit.map((a) => a.action).join(" ")).toMatch(/issue\.interrupted|issue\.reconcile|issue\.unknown/);
    await h.client.post(ws.operator.session, `/leases/${created.id}/revoke`, { reason: "cleanup" });
    await h.drain();
  }, 180_000);

  it("a worker killed AFTER the provider committed the grant but before recording it does not lose that outcome: the next worker adopts the existing grant", async () => {
    const created = await newLease();
    const role = providerRoleFor(created.id);
    // Test-side fault injection in the metadata database only: recording the issued grant blocks on an advisory lock that this test holds.
    const gate = new pg.Client({ connectionString: h.database.url });
    await gate.connect();
    await gate.query(`CREATE OR REPLACE FUNCTION al_qa_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_lock(${LOCK}); PERFORM pg_advisory_unlock(${LOCK}); RETURN NEW; END $$`);
    await gate.query("CREATE TRIGGER al_qa_block BEFORE UPDATE ON provider_grants FOR EACH ROW EXECUTE FUNCTION al_qa_block()");
    await gate.query(`SELECT pg_advisory_lock(${LOCK})`);
    await approve(created.id, created.plan_hash);
    const workerA = spawnChild(process.execPath, [workerScript], childEnv({ QA_JOB_LEASE_SECONDS: "3", QA_WORKER_ID: "qa-A2" }));
    try {
      await waitForLine(workerA, /^READY$/);
      await waitFor("grant committed at the provider while the outcome write is blocked", async () => (await rolesNamed(created.id)) === 1, 20_000, 25);
      await waitFor("worker blocked recording the outcome", async () => {
        const waiting = await sql(h.database.url, "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        return (waiting[0]!.n as number) > 0;
      }, 10_000, 25);
      expect((await getLease(h, ws.operator.session, created.id)).state).toBe("issuing"); // not recorded
    } finally {
      await workerA.kill("SIGKILL");
    }
    await gate.query("DROP TRIGGER al_qa_block ON provider_grants");
    await gate.query(`SELECT pg_advisory_unlock(${LOCK})`);
    await gate.end();
    expect(await rolesNamed(created.id), "the real grant exists although AccessLease never recorded it").toBe(1);
    await sleep(3500);
    const workerB = spawnChild(process.execPath, [workerScript], childEnv({ QA_JOB_LEASE_SECONDS: "3", QA_WORKER_ID: "qa-B2" }));
    try {
      await waitForLine(workerB, /^READY$/);
      await waitFor("lease ACTIVE", async () => (await getLease(h, ws.operator.session, created.id)).state === "active", 60_000, 250);
    } finally {
      await workerB.kill("SIGTERM");
    }
    const detail = await getLease(h, ws.operator.session, created.id);
    expect(detail.provider_grant?.provider_ref).toBe(role);
    expect(await rolesNamed(created.id), "adopted, not duplicated").toBe(1);
    const grants = await sql(h.target!.adminUrl, "SELECT privilege_type FROM information_schema.table_privileges WHERE grantee = $1 AND table_name = 'records'", [role]);
    expect(grants).toEqual([{ privilege_type: "SELECT" }]);
    expect(detail.audit.map((a) => a.action).join(" ")).toMatch(/issue\.(interrupted|reconciled)/);
    await h.client.post(ws.operator.session, `/leases/${created.id}/revoke`, { reason: "cleanup" });
    await h.drain();
  }, 180_000);

  it("a failed migration stops readiness: the service is not ready until every shipped migration is applied unmodified", async () => {
    expect((await h.client.get(null, "/health/ready")).status).toBe(200);
    const original = await sql(h.database.url, "SELECT version, checksum FROM schema_migrations ORDER BY version LIMIT 1");
    expect(original.length).toBe(1);
    await sql(h.database.url, "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = $1", [original[0]!.version]);
    const modified = await h.client.get(null, "/health/ready");
    expect(modified.status).toBe(503);
    expect(modified.body.error.code).toBe("not_ready");
    expect((await h.client.get(null, "/health/live")).status).toBe(200);
    await sql(h.database.url, "UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [original[0]!.version, original[0]!.checksum]);
    expect((await h.client.get(null, "/health/ready")).status).toBe(200);
    await sql(h.database.url, "DELETE FROM schema_migrations WHERE version = $1", [original[0]!.version]);
    expect((await h.client.get(null, "/health/ready")).status).toBe(503);
    await sql(h.database.url, "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1, $2, now())", [original[0]!.version, original[0]!.checksum]);
    expect((await h.client.get(null, "/health/ready")).status).toBe(200);
  });

  it("a migration that fails to apply aborts startup with no partial schema and the installation reports not ready", async () => {
    const fresh = await freshMetadataDatabase();
    const dir = mkdtempSync(join(tmpdir(), "al-migrations-"));
    try {
      copyFileSync(join(repoRoot, "migrations/001_initial.sql"), join(dir, "001_initial.sql"));
      writeFileSync(join(dir, "002_broken.sql"), "CREATE TABLE al_qa_partial (id int);\nALTER TABLE al_qa_does_not_exist ADD COLUMN x int;\n");
      const { migrate: migrateDir } = await import("../../src/db/migrate.js");
      const { openDatabase } = await import("../../src/db/index.js");
      const db = openDatabase(fresh.url);
      try {
        await expect(migrateDir(db, dir)).rejects.toThrow(/002_broken\.sql failed/);
        const applied = await sql(fresh.url, "SELECT version FROM schema_migrations ORDER BY version");
        expect(applied.map((r) => r.version)).toEqual(["001_initial.sql"]);
        const partial = await sql(fresh.url, "SELECT to_regclass('public.al_qa_partial') AS t");
        expect(partial[0]!.t, "the failed migration must roll back completely").toBeNull();
        // The shipped migration set (without the broken one) is complete, so the DB is ready; remove 001 to model "not applied".
        await sql(fresh.url, "DELETE FROM schema_migrations");
        const status = await migrationStatus(db);
        expect(status.ok).toBe(false);
        expect(status.problem).toMatch(/pending migrations/);
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
    void migrate;
  });

  it("a restored backup preserves every reference: ids, foreign keys, hashes and decryptable secrets", async () => {
    const active = await newLease();
    await approve(active.id, active.plan_hash);
    const closed = await newLease();
    await approve(closed.id, closed.plan_hash);
    await waitFor("both ACTIVE", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, active.id)).state === "active" && (await getLease(h, ws.operator.session, closed.id)).state === "active";
    }, 30_000, 200);
    await h.client.post(ws.operator.session, `/leases/${closed.id}/close`, { reason: "done" });
    await h.drain();
    const sourceCounts = await tableCounts(h.database.url);
    const tables = Object.keys(sourceCounts).filter((t) => !/^(sessions|schema_migrations)$/.test(t));
    const sourceDetail = await getLease(h, ws.viewer.session, closed.id);

    const container = process.env.ACCESSLEASE_TEST_META_CONTAINER;
    expect(container, "ACCESSLEASE_TEST_META_CONTAINER is required for the backup/restore test").toBeTruthy();
    const restored = await freshMetadataDatabase();
    try {
      const user = decodeURIComponent(new URL(metadataAdminUrl()).username);
      const dump = spawnSync("docker", ["exec", container!, "pg_dump", "-U", user, "-Fc", "-d", h.database.name, "-f", "/tmp/al-backup.dump"], { encoding: "utf8" });
      expect(dump.status, dump.stderr).toBe(0);
      const restore = spawnSync("docker", ["exec", container!, "pg_restore", "-U", user, "--no-owner", "--clean", "--if-exists", "-d", restored.name, "/tmp/al-backup.dump"], { encoding: "utf8" });
      expect([0, 1], restore.stderr).toContain(restore.status);
      spawnSync("docker", ["exec", container!, "rm", "-f", "/tmp/al-backup.dump"]);

      expect(await tableCounts(restored.url)).toEqual(sourceCounts);
      expect(await tableFingerprint(restored.url, tables)).toEqual(await tableFingerprint(h.database.url, tables));
      const orphans = await sql(restored.url, "SELECT count(*)::int AS n FROM revocation_attempts r LEFT JOIN leases l ON l.id = r.lease_id WHERE l.id IS NULL");
      expect(orphans[0]!.n).toBe(0);

      const second = await createHarness({ provider: "postgres-role", fixedClock: false, database: restored, target: h.target!, env: { ACCESSLEASE_SECRET_KEY: h.secretKey } });
      try {
        const login = await second.client.login(ws.operator.email, "synthetic-test-password-123", ws.id);
        expect(await getLease(second, login, closed.id)).toEqual(sourceDetail);
        const delivery = await second.client.post(login, `/leases/${active.id}/credential`);
        expect(delivery.status).toBe(200);
        expect(delivery.body.credential.secret).toBeTruthy();
        expect(await roleFacts(h.target!.clusterUrl, providerRoleFor(active.id))).toMatchObject({ exists: true });
        await second.client.post(login, `/leases/${active.id}/revoke`, { reason: "cleanup" });
        await second.drain();
        expect((await getLease(second, login, active.id)).state).toBe("revoked_verified");
      } finally {
        await second.close();
      }
    } finally {
      await restored.drop();
    }
  }, 120_000);
}
