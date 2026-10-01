import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { ProviderRegistry, ProviderRejectedError, ProviderUnavailableError } from "../../../src/connectors/provider.js";
import { type Ctx, defaultSettings, systemClock } from "../../../src/context.js";
import { ServerKey } from "../../../src/crypto.js";
import { migrate } from "../../../src/db/migrate.js";
import { AppError } from "../../../src/errors.js";
import { memoryLogger } from "../../../src/lib/log.js";
import { approveLease, getLease, requestLease, retrieveCredential, revokeLease } from "../../../src/services/leases.js";
import { runWorkerOnce } from "../../../src/workers/index.js";
import { freshDatabase, seedWorkspace, testProviderUrl, withDatabase } from "./helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET = "Fake-Provider-Secret-0123456789";

/** TCP proxy in front of the disposable provider cluster: lets tests inject outages and lost COMMIT answers on the real wire. */
function startProxy(targetPort: number) {
  const sockets = new Set<net.Socket>();
  let dropOn: string | null = null;
  let server: net.Server;
  const make = () =>
    net.createServer((client) => {
      const upstream = net.connect(targetPort, "127.0.0.1");
      let swallow = false;
      sockets.add(client);
      sockets.add(upstream);
      client.on("data", (chunk) => {
        upstream.write(chunk);
        if (dropOn && chunk.includes(dropOn)) {
          dropOn = null;
          swallow = true;
          // let the server execute the statement, then cut the line before the answer reaches the client
          setTimeout(() => {
            client.destroy();
            upstream.destroy();
          }, 200);
        }
      });
      upstream.on("data", (chunk) => {
        if (!swallow) client.write(chunk);
      });
      for (const s of [client, upstream]) {
        s.on("error", () => undefined);
        s.on("close", () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        });
      }
    });
  let port = 0;
  return {
    get port() {
      return port;
    },
    async up() {
      server = make();
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      port = (server.address() as net.AddressInfo).port;
    },
    async down() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
    dropNextCommit() {
      dropOn = "COMMIT";
    },
    /** Cut the connection the next time a client message contains `text`. */
    dropNextMatching(text: string) {
      dropOn = text;
    },
  };
}

const adminBase = testProviderUrl();
const baseUrl = new URL(adminBase);
const providerPort = Number(baseUrl.port);
let dbName: string;
let admin: pg.Client;

async function adminClient(database: string) {
  const client = new pg.Client({ connectionString: withDatabase(adminBase, database) });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

async function login(role: string, secret: string, port = providerPort, database = dbName): Promise<pg.Client> {
  const client = new pg.Client({ host: "127.0.0.1", port, user: role, password: secret, database });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

const createdRoles = new Set<string>();
const roleExists = async (role: string) => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rows.length > 0;

beforeAll(async () => {
  dbName = `al_prov_${randomBytes(5).toString("hex")}`;
  const maintenance = await adminClient("postgres");
  await maintenance.query(`CREATE DATABASE ${dbName}`);
  await maintenance.end();
  admin = await adminClient(dbName);
  await admin.query(await readFile(new URL("../../../provider-migrations/001_terminal_fences.sql", import.meta.url), "utf8"));
  await admin.query("CREATE SCHEMA app");
  await admin.query("CREATE TABLE app.orders (id int PRIMARY KEY, note text)");
  await admin.query("CREATE TABLE app.secrets (id int PRIMARY KEY, v text)");
  await admin.query("INSERT INTO app.orders VALUES (1, 'synthetic order'), (2, 'another')");
  await admin.query("INSERT INTO app.secrets VALUES (1, 'FAKE-NOT-A-REAL-SECRET')");
});

afterAll(async () => {
  for (const role of createdRoles) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]).catch(() => undefined);
    await admin.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
  }
  await admin.end().catch(() => undefined);
  const maintenance = await adminClient("postgres");
  await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await maintenance.end();
});

const direct = () => new PostgresRoleProvider({ adminUrl: adminBase, allowlist: ["127.0.0.1"] });
const issueRequest = (leaseId: string, overrides: Record<string, unknown> = {}) => ({
  leaseId,
  resource: dbName,
  attempt: 1,
  subject: "contractor-1",
  scopes: ["pg:app.orders:select"],
  expiresAt: new Date(Date.now() + 60_000),
  credentialSecret: SECRET,
  ...overrides,
});

describe("postgres-role provider (REAL PostgreSQL 17, disposable cluster)", () => {
  const provider = direct();

  it("an insert scope works on tables with serial/identity keys: USAGE on the owned sequences only (F-006)", async () => {
    await admin.query("CREATE TABLE IF NOT EXISTS app.records (id serial PRIMARY KEY, body text)");
    await admin.query("CREATE TABLE IF NOT EXISTS app.ident (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text)");
    const leaseId = randomUUID();
    const issued = await provider.issue(issueRequest(leaseId, { scopes: ["pg:app.records:insert", "pg:app.ident:insert", "pg:app.orders:select"] }));
    createdRoles.add(issued.providerRef);
    const session = await login(issued.providerRef, SECRET);
    await session.query("INSERT INTO app.records (body) VALUES ('from the lease')");
    await session.query("INSERT INTO app.ident (body) VALUES ('from the lease')");
    // nothing beyond insert: no read of the inserted table, no sequence reads, no other sequences, no update
    await expect(session.query("SELECT * FROM app.records")).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("SELECT last_value FROM app.records_id_seq")).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("UPDATE app.records SET body = 'x'")).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("SELECT setval('app.records_id_seq', 1000)")).rejects.toMatchObject({ code: "42501" });
    await session.end();
    expect((await provider.lookup({ leaseId, resource: dbName })).scopes).toEqual(["pg:app.ident:insert", "pg:app.orders:select", "pg:app.records:insert"]);
    const revoked = await provider.revoke({ leaseId, resource: dbName });
    expect(revoked.steps.every((s) => s.ok)).toBe(true);
    const leftover = await admin.query("SELECT 1 FROM pg_class c WHERE c.relkind = 'S' AND has_sequence_privilege($1, c.oid, 'USAGE')", [issued.providerRef]).catch(() => ({ rows: [] }));
    expect(leftover.rows).toEqual([]);
    expect(await roleExists(issued.providerRef)).toBe(false);
  });

  it("issues a narrow, time-limited login role and nothing more", async () => {
    const leaseId = randomUUID();
    const expiresAt = new Date(Date.now() + 120_000);
    const result = await provider.issue(issueRequest(leaseId, { expiresAt }));
    createdRoles.add(result.providerRef);
    expect(result).toMatchObject({ providerRef: provider.providerRefFor(leaseId), alreadyExisted: false, connection: { host: "127.0.0.1", port: providerPort, database: dbName, username: result.providerRef } });
    const attrs = (await admin.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin, rolconnlimit, rolvaliduntil FROM pg_roles WHERE rolname = $1", [result.providerRef])).rows[0];
    expect(attrs).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true, rolconnlimit: 5 });
    expect(Math.abs(new Date(attrs.rolvaliduntil).getTime() - expiresAt.getTime())).toBeLessThan(1000);

    const session = await login(result.providerRef, SECRET);
    expect((await session.query("SELECT count(*)::int AS n FROM app.orders")).rows[0].n).toBe(2);
    for (const forbidden of [
      "SELECT * FROM app.secrets",
      "INSERT INTO app.orders VALUES (9, 'x')",
      "UPDATE app.orders SET note = 'x'",
      "CREATE TABLE app.evil (id int)",
      "CREATE ROLE evil LOGIN",
      "SELECT * FROM pg_authid",
      "DROP TABLE app.orders",
    ]) {
      await expect(session.query(forbidden), forbidden).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|25006)$/) });
    }
    await session.end();

    const looked = await provider.lookup({ leaseId, resource: dbName });
    expect(looked).toMatchObject({ state: "present", loginAllowed: true, activeSessions: 0, scopes: ["pg:app.orders:select"] });
    expect(looked.validUntil && Math.abs(looked.validUntil.getTime() - expiresAt.getTime())).toBeLessThan(1000);
    expect(await provider.probeUse({ leaseId, resource: dbName, credentialSecret: SECRET })).toBe("allowed");
    expect(await provider.probeUse({ leaseId, resource: dbName, credentialSecret: `${SECRET}-wrong` })).toBe("denied");
    expect((await provider.revoke({ leaseId, resource: dbName })).steps.every((s) => s.ok)).toBe(true);
  });

  it("issue is idempotent on the lease: a retry identifies the same role and realigns scopes", async () => {
    const leaseId = randomUUID();
    const first = await provider.issue(issueRequest(leaseId));
    createdRoles.add(first.providerRef);
    const second = await provider.issue(issueRequest(leaseId, { scopes: ["pg:app.orders:select", "pg:app.orders:update"] }));
    expect([second.providerRef, second.alreadyExisted]).toEqual([first.providerRef, true]);
    expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [first.providerRef])).rows).toHaveLength(1);
    expect((await provider.lookup({ leaseId, resource: dbName })).scopes).toEqual(["pg:app.orders:select", "pg:app.orders:update"]);
    // narrowing a retry removes what is no longer requested
    await provider.issue(issueRequest(leaseId, { scopes: ["pg:app.secrets:select"] }));
    const session = await login(first.providerRef, SECRET);
    await expect(session.query("SELECT * FROM app.orders")).rejects.toMatchObject({ code: "42501" });
    expect((await session.query("SELECT count(*)::int AS n FROM app.secrets")).rows[0].n).toBe(1);
    await session.end();
    await provider.revoke({ leaseId, resource: dbName });
  });

  it("native TTL blocks new logins at expiry but an open session survives until revoked (residual access), then everything is gone", async () => {
    const leaseId = randomUUID();
    const expiresAt = new Date(Date.now() + 2500);
    const issued = await provider.issue(issueRequest(leaseId, { expiresAt }));
    createdRoles.add(issued.providerRef);
    const held = await login(issued.providerRef, SECRET);
    await held.query("SELECT 1");
    await sleep(expiresAt.getTime() - Date.now() + 400);
    await expect(login(issued.providerRef, SECRET)).rejects.toMatchObject({ code: "28P01" });
    expect(await provider.probeUse({ leaseId, resource: dbName, credentialSecret: SECRET })).toBe("denied");
    const during = await provider.lookup({ leaseId, resource: dbName });
    expect(during).toMatchObject({ state: "present", loginAllowed: false, activeSessions: 1 });
    // residual access: the established session still works after the grant expired
    expect((await held.query("SELECT count(*)::int AS n FROM app.orders")).rows[0].n).toBe(2);

    const started = Date.now();
    const revoked = await provider.revoke({ leaseId, resource: dbName });
    expect(revoked.steps.map((s) => [s.step, s.ok])).toEqual([
      ["disable_login", true],
      ["terminate_sessions", true],
      ["revoke_grants", true],
      ["drop_role", true],
    ]);
    expect(revoked.sessionsTerminated).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(held.query("SELECT 1")).rejects.toBeTruthy();
    expect(await provider.lookup({ leaseId, resource: dbName })).toMatchObject({ state: "absent", activeSessions: 0 });
    expect(await provider.probeUse({ leaseId, resource: dbName, credentialSecret: SECRET })).toBe("denied");
    expect(await roleExists(issued.providerRef)).toBe(false);
    // idempotent
    expect((await provider.revoke({ leaseId, resource: dbName })).steps).toEqual([{ step: "role_absent", ok: true }]);
  });

  it("refuses definitively and leaves nothing behind: missing database/table, wildcard scopes, bad input, role collisions", async () => {
    const id = randomUUID();
    await expect(provider.issue(issueRequest(id, { resource: "al_missing_db" }))).rejects.toMatchObject({ definite: true, code: "database_missing" });
    await expect(provider.issue(issueRequest(id, { scopes: ["pg:app.nope:select"] }))).rejects.toMatchObject({ definite: true, code: "sql_42P01" });
    expect(await roleExists(provider.providerRefFor(id))).toBe(false);
    await expect(provider.issue(issueRequest(id, { scopes: ["pg:app.*:select"] }))).rejects.toMatchObject({ code: "scope_wildcard" });
    await expect(provider.issue(issueRequest(id, { scopes: ["pg:app.orders:all"] }))).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(provider.issue(issueRequest(id, { scopes: [] }))).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(provider.issue(issueRequest(id, { resource: "Bad-Name" }))).rejects.toMatchObject({ code: "invalid_resource" });
    await expect(provider.issue(issueRequest(id, { expiresAt: new Date(Date.now() - 1000) }))).rejects.toMatchObject({ code: "expired" });
    await expect(provider.issue(issueRequest(id, { credentialSecret: "short" }))).rejects.toMatchObject({ code: "weak_secret" });
    expect(await roleExists(provider.providerRefFor(id))).toBe(false);

    // a pre-existing role that this lease did not create is never hijacked or touched
    const collide = randomUUID();
    const name = provider.providerRefFor(collide);
    createdRoles.add(name);
    await admin.query(`CREATE ROLE "${name}" NOLOGIN`);
    await expect(provider.issue(issueRequest(collide))).rejects.toMatchObject({ code: "role_collision" });
    expect((await provider.revoke({ leaseId: collide, resource: dbName })).steps).toEqual([{ step: "role_not_owned", ok: false, detail: expect.any(String) }]);
    expect(await roleExists(name)).toBe(true);
    expect(provider.validateScope("pg:app.orders:select")).toEqual({ ok: true });
    expect(provider.validateScope("pg:app.orders:delete")).toMatchObject({ ok: false });
    expect(provider.validateResource("template1")).toMatchObject({ ok: false });
    expect(provider.capabilities()).toMatchObject({ kind: "postgres-role", label: "LIVE_LOCAL_POSTGRES", live: true, nativeTtl: true });
  });

  it("a revoke on a role that never existed verifies absence and a lookup of a missing grant is absent", async () => {
    const id = randomUUID();
    expect((await provider.revoke({ leaseId: id, resource: dbName })).steps).toEqual([{ step: "role_absent", ok: true }]);
    expect(await provider.lookup({ leaseId: id, resource: dbName })).toMatchObject({ state: "absent" });
    expect(await provider.probeUse({ leaseId: id, resource: dbName, credentialSecret: SECRET })).toBe("denied");
  });

  it("explicit disconnection is reported, not hidden (AC-08)", async () => {
    const dead = new PostgresRoleProvider({ adminUrl: "postgres://postgres:x@127.0.0.1:1/postgres", allowlist: ["127.0.0.1"], connectTimeoutMs: 500 });
    await expect(dead.ping()).rejects.toMatchObject({ code: "provider_unavailable", definite: false });
    await expect(dead.issue(issueRequest(randomUUID()))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(dead.lookup({ leaseId: randomUUID(), resource: dbName })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(dead.revoke({ leaseId: randomUUID(), resource: dbName })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(await dead.probeUse({ leaseId: randomUUID(), resource: dbName, credentialSecret: SECRET })).toBe("unknown");
    // egress allowlist: not listed => refused before any connection
    const denied = new PostgresRoleProvider({ adminUrl: adminBase, allowlist: [] });
    await expect(denied.ping()).rejects.toMatchObject({ code: "provider_disconnected" });
    // DNS rebinding style: a host name resolving to loopback is refused unless explicitly allowed
    const rebind = new PostgresRoleProvider({ adminUrl: `postgres://postgres:x@rebind.example.test:${providerPort}/postgres`, allowlist: ["rebind.example.test"], resolver: async () => ["127.0.0.1"] });
    await expect(rebind.ping()).rejects.toMatchObject({ code: "provider_disconnected" });
    const resolvedPinned = new PostgresRoleProvider({ adminUrl: adminBase.replace("127.0.0.1", "pinned.example.test"), allowlist: ["pinned.example.test", "127.0.0.1"], resolver: async () => ["127.0.0.1"] });
    await expect(resolvedPinned.ping()).resolves.toBeUndefined();
    await expect(new PostgresRoleProvider({ adminUrl: `postgres://postgres:x@127.0.0.1:${providerPort}/postgres`, allowlist: ["127.0.0.1"], connectTimeoutMs: 2000 }).ping()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("a lost COMMIT answer is an ambiguous outcome; the grant exists and a retry finds the same role", async () => {
    const proxy = startProxy(providerPort);
    await proxy.up();
    try {
      const viaProxy = new PostgresRoleProvider({ adminUrl: adminBase.replace(`:${providerPort}`, `:${proxy.port}`), allowlist: ["127.0.0.1"] });
      const leaseId = randomUUID();
      const role = viaProxy.providerRefFor(leaseId);
      createdRoles.add(role);
      proxy.dropNextCommit();
      await expect(viaProxy.issue(issueRequest(leaseId))).rejects.toMatchObject({ code: "provider_ambiguous", definite: false });
      expect(await roleExists(role)).toBe(true);
      expect(await direct().lookup({ leaseId, resource: dbName })).toMatchObject({ state: "present", scopes: ["pg:app.orders:select"] });
      const retry = await direct().issue(issueRequest(leaseId));
      expect([retry.providerRef, retry.alreadyExisted]).toEqual([role, true]);
      expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rows).toHaveLength(1);
      await direct().revoke({ leaseId, resource: dbName });
    } finally {
      await proxy.down();
    }
  });

  it("a role with privileges in another database cannot be dropped: the failed step is reported and the role stays NOLOGIN (never verified)", async () => {
    const leaseId = randomUUID();
    const issued = await provider.issue(issueRequest(leaseId));
    createdRoles.add(issued.providerRef);
    const other = await adminClient("postgres");
    await other.query("CREATE TABLE IF NOT EXISTS public.al_elsewhere (id int)");
    await other.query(`GRANT SELECT ON public.al_elsewhere TO "${issued.providerRef}"`);
    try {
      const revoked = await provider.revoke({ leaseId, resource: dbName });
      const dropStep = revoked.steps.find((s) => s.step === "drop_role");
      expect(dropStep).toMatchObject({ ok: false, detail: "sqlstate 2BP01" });
      expect(revoked.steps.find((s) => s.step === "disable_login")?.ok).toBe(true);
      const look = await provider.lookup({ leaseId, resource: dbName });
      expect(look).toMatchObject({ state: "present", loginAllowed: false });
      expect(await provider.probeUse({ leaseId, resource: dbName, credentialSecret: SECRET })).toBe("denied");
    } finally {
      await other.query(`REVOKE ALL ON public.al_elsewhere FROM "${issued.providerRef}"`);
      await other.query("DROP TABLE IF EXISTS public.al_elsewhere");
      await other.end();
    }
    expect((await provider.revoke({ leaseId, resource: dbName })).steps.every((s) => s.ok)).toBe(true);
    expect(await roleExists(issued.providerRef)).toBe(false);
  });

  it("when sessions cannot be terminated the role is NOT dropped: it stays NOLOGIN and present so the lease is never verified (R-005)", async () => {
    const stubborn = new PostgresRoleProvider({ adminUrl: adminBase, allowlist: ["127.0.0.1"], terminateWaitMs: -1 });
    const leaseId = randomUUID();
    const issued = await stubborn.issue(issueRequest(leaseId));
    createdRoles.add(issued.providerRef);
    const held = await login(issued.providerRef, SECRET);
    const revoked = await stubborn.revoke({ leaseId, resource: dbName });
    expect(revoked.steps.map((s) => [s.step, s.ok])).toEqual([
      ["disable_login", true],
      ["terminate_sessions", false],
    ]);
    expect(await roleExists(issued.providerRef)).toBe(true);
    expect(await stubborn.lookup({ leaseId, resource: dbName })).toMatchObject({ state: "present", loginAllowed: false });
    await held.end().catch(() => undefined);
    expect((await provider.revoke({ leaseId, resource: dbName })).steps.every((s) => s.ok)).toBe(true);
    expect(await roleExists(issued.providerRef)).toBe(false);
  });

  it("introspection tolerates a missing resource database and reports unreachable or SSL-less servers as unavailable", async () => {
    const leaseId = randomUUID();
    const issued = await provider.issue(issueRequest(leaseId));
    createdRoles.add(issued.providerRef);
    const blind = await provider.lookup({ leaseId, resource: "al_missing_db" });
    expect(blind).toMatchObject({ state: "present", scopes: null });
    await provider.revoke({ leaseId, resource: dbName });

    const proxy = startProxy(providerPort);
    await proxy.up();
    try {
      const viaProxy = new PostgresRoleProvider({ adminUrl: adminBase.replace(`:${providerPort}`, `:${proxy.port}`), allowlist: ["127.0.0.1"] });
      proxy.dropNextMatching("pg_stat_activity");
      await expect(viaProxy.lookup({ leaseId: randomUUID(), resource: dbName })).resolves.toMatchObject({ state: "absent" });
      const existing = randomUUID();
      const created = await provider.issue(issueRequest(existing));
      createdRoles.add(created.providerRef);
      proxy.dropNextMatching("pg_stat_activity");
      await expect(viaProxy.lookup({ leaseId: existing, resource: dbName })).rejects.toMatchObject({ code: "provider_unavailable", definite: false });
      await provider.revoke({ leaseId: existing, resource: dbName });
    } finally {
      await proxy.down();
    }
    const ssl = new PostgresRoleProvider({ adminUrl: `${adminBase}?sslmode=require`, allowlist: ["127.0.0.1"], connectTimeoutMs: 2000 });
    await expect(ssl.ping()).rejects.toBeInstanceOf(ProviderUnavailableError);
    const sslOff = new PostgresRoleProvider({ adminUrl: `${adminBase}?sslmode=disable`, allowlist: ["127.0.0.1"], publicHost: "db.example.test" });
    await expect(sslOff.ping()).resolves.toBeUndefined();
    const hostedLease = randomUUID();
    const hosted = await sslOff.issue(issueRequest(hostedLease));
    createdRoles.add(hosted.providerRef);
    expect(hosted.connection.host).toBe("db.example.test");
    await sslOff.revoke({ leaseId: hostedLease, resource: dbName });
  });

  it("inspects the target for doctor: superuser/signal rights, server version and cluster identity", async () => {
    const facts = await provider.inspectAdmin();
    expect(facts).toMatchObject({ superuser: true, canSignal: true });
    expect(facts.serverVersion).toMatch(/^17/);
    expect(facts.systemIdentifier).toMatch(/^\d+$/);
    await provider.ping();
    expect(provider.capabilities().version).toContain("17");
    await provider.close();
  });
});

describe("AccessLease on the real provider (AC-03..AC-07, AC-13 against live PostgreSQL)", () => {
  let ctx: Ctx;
  let principals: Awaited<ReturnType<typeof seedWorkspace>>;
  let proxy: ReturnType<typeof startProxy>;
  let drop: () => Promise<void>;
  let logs: string[];

  beforeAll(async () => {
    const fresh = await freshDatabase("al_live");
    drop = fresh.drop;
    await migrate(fresh.db);
    proxy = startProxy(providerPort);
    await proxy.up();
    const { log, lines } = memoryLogger();
    logs = lines;
    const provider = new PostgresRoleProvider({ adminUrl: adminBase.replace(`:${providerPort}`, `:${proxy.port}`), allowlist: ["127.0.0.1"], connectTimeoutMs: 1500 });
    ctx = {
      db: fresh.db,
      clock: systemClock,
      key: ServerKey.generate(),
      settings: { ...defaultSettings, secureCookies: false, retryBaseSeconds: 1, retryCapSeconds: 2, initialPolicy: { defaultTtlSeconds: 60, maxTtlSeconds: 3600, minTtlSeconds: 1, retentionDays: 90 } },
      providers: new ProviderRegistry([provider], "postgres-role"),
      log,
    };
    principals = await seedWorkspace(ctx, "live");
  });
  afterAll(async () => {
    await proxy.down().catch(() => undefined);
    for (const row of (await ctx.db.query<{ provider_ref: string }>("SELECT provider_ref FROM provider_grants")).rows) createdRoles.add(row.provider_ref);
    await drop();
  });

  const lease = async (ttlSeconds: number, task: string) => {
    const created = await requestLease(ctx, principals.operator, {
      task_ref: task,
      subject_ref: "contractor-1",
      resource_ref: dbName,
      scopes: ["pg:app.orders:select"],
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
    await approveLease(ctx, principals.operator, created.id, { plan_hash: created.plan_hash });
    return created;
  };
  const pass = () => runWorkerOnce(ctx, { workerId: "live-worker" });
  const waitFor = async (id: string, state: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await pass();
      const detail = await getLease(ctx, principals.viewer, id);
      if (detail.state === state) return detail;
      if (Date.now() > deadline) throw new Error(`lease stuck in ${detail.state}, expected ${state}`);
      await sleep(300);
    }
  };

  it("AC-07: allowed during the lease, denied after expiry and after explicit revocation; the residual-access window is measured", async () => {
    const created = await lease(4, "live-expiry");
    const active = await waitFor(created.id, "active");
    expect(active.provider).toEqual({ kind: "postgres-role", label: "LIVE_LOCAL_POSTGRES", live: true });
    const credential = await retrieveCredential(ctx, principals.operator, created.id);
    const { username, secret, port } = credential.credential;
    expect(logs.join("\n")).not.toContain(secret);
    const held = await login(username, secret, port);
    expect((await held.query("SELECT count(*)::int AS n FROM app.orders")).rows[0].n).toBe(2);
    const expiresAt = Date.parse(active.expires_at);
    await sleep(Math.max(0, expiresAt - Date.now()) + 300);
    // denied for new logins by the provider's native TTL; the open session still works until the worker revokes it
    await expect(login(username, secret, port)).rejects.toMatchObject({ code: "28P01" });
    let residual = true;
    try {
      await held.query("SELECT 1");
    } catch {
      residual = false;
    }
    const detail = await waitFor(created.id, "revoked_verified");
    const row = (await ctx.db.query<{ close_requested_at: Date; revoked_at: Date }>("SELECT close_requested_at, revoked_at FROM leases WHERE id = $1", [created.id])).rows[0] as { close_requested_at: Date; revoked_at: Date };
    const requestDelayMs = row.close_requested_at.getTime() - expiresAt;
    const verifiedAfterMs = row.revoked_at.getTime() - expiresAt;
    console.info(`RESIDUAL_ACCESS_WINDOW open_session_survived_expiry=${residual} revocation_requested_after_ms=${requestDelayMs} verified_after_ms=${verifiedAfterMs}`);
    expect(residual).toBe(true);
    expect(requestDelayMs).toBeLessThan(30_000);
    expect(verifiedAfterMs).toBeLessThan(30_000);
    expect(detail.attempts[0]).toMatchObject({ result: "verified", verification_ref: "introspection:absent+probe:denied" });
    await expect(held.query("SELECT 1")).rejects.toBeTruthy();
    await expect(login(username, secret, port)).rejects.toMatchObject({ code: "28P01" });
    expect(await roleExists(username)).toBe(false);

    // explicit revocation
    const second = await lease(120, "live-explicit");
    await waitFor(second.id, "active");
    const cred2 = (await retrieveCredential(ctx, principals.operator, second.id)).credential;
    const held2 = await login(cred2.username, cred2.secret, cred2.port);
    await revokeLease(ctx, principals.operator, second.id, { reason: "task finished" });
    const done = await waitFor(second.id, "revoked_verified");
    expect(done.close_reason).toBe("operator_revoked");
    await expect(held2.query("SELECT 1")).rejects.toBeTruthy();
    await expect(login(cred2.username, cred2.secret, cred2.port)).rejects.toMatchObject({ code: "28P01" });
    expect(await roleExists(cred2.username)).toBe(false);
  });

  it("AC-05: a provider outage during revocation is REVOCATION_UNCONFIRMED with a retry, never green; recovery verifies", async () => {
    const created = await lease(120, "live-outage");
    await waitFor(created.id, "active");
    const ref = (await getLease(ctx, principals.viewer, created.id)).provider_grant?.provider_ref as string;
    await proxy.down();
    await revokeLease(ctx, principals.operator, created.id, { reason: "outage drill" });
    await pass();
    let detail = await getLease(ctx, principals.viewer, created.id);
    expect(detail.state).toBe("revocation_unconfirmed");
    expect(detail.revocation_status).toBe("unconfirmed");
    expect(detail.warning).toContain("NOT verified");
    expect(detail.next_retry_at).not.toBeNull();
    expect(detail.attempts[0]?.result).toBe("provider_error");
    expect(await roleExists(ref)).toBe(true);
    await proxy.up();
    await sleep(1200);
    detail = await waitFor(created.id, "revoked_verified");
    expect(detail.attempts.map((a) => a.result)).toEqual(expect.arrayContaining(["provider_error", "verified"]));
    expect(await roleExists(ref)).toBe(false);
  });

  it("AC-03: a lost issue answer is ISSUE_UNKNOWN; reconciliation adopts the one existing role (no duplicate grant)", async () => {
    proxy.dropNextCommit();
    const created = await lease(120, "live-ambiguous");
    await pass();
    let detail = await getLease(ctx, principals.viewer, created.id);
    expect(detail.state).toBe("issue_unknown");
    expect(detail.warning).toContain("WARNING");
    const ref = detail.provider_grant?.provider_ref as string;
    expect(await roleExists(ref)).toBe(true);
    await sleep(1200);
    detail = await waitFor(created.id, "active");
    expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ref])).rows).toHaveLength(1);
    expect(detail.provider_grant?.status).toBe("issued");
    await revokeLease(ctx, principals.operator, created.id, { reason: "cleanup" });
    await waitFor(created.id, "revoked_verified");
  });

  it("AC-06: after scheduler downtime the overdue grant is swept before the next issuance and the retry identifies the same grant", async () => {
    const overdue = await lease(2, "live-downtime");
    await waitFor(overdue.id, "active");
    const ref = (await getLease(ctx, principals.viewer, overdue.id)).provider_grant?.provider_ref as string;
    await sleep(3200); // the scheduler is down; the lease expires, the grant is still in place
    expect(await roleExists(ref)).toBe(true);
    const fresh = await lease(60, "live-after-downtime");
    const report = await pass();
    expect(report.sweep.expiredToRevoking).toBeGreaterThanOrEqual(1);
    await waitFor(fresh.id, "active");
    const overdueDone = await getLease(ctx, principals.viewer, overdue.id);
    expect(overdueDone.state).toBe("revoked_verified");
    const seq = async (leaseId: string, action: string) => ((await ctx.db.query<{ seq: number }>("SELECT seq FROM audit_events WHERE lease_id = $1 AND action = $2", [leaseId, action])).rows[0]?.seq ?? 0) as number;
    expect(await seq(overdue.id, "sweep.expired")).toBeLessThan(await seq(fresh.id, "issue.started"));
    expect(await roleExists(ref)).toBe(false);
    await revokeLease(ctx, principals.operator, fresh.id, { reason: "cleanup" });
    await waitFor(fresh.id, "revoked_verified");
  });

  it("AC-08: approving a live lease while the provider is disconnected fails explicitly and changes nothing", async () => {
    const created = await requestLease(ctx, principals.operator, {
      task_ref: "live-disconnected",
      subject_ref: "contractor-1",
      resource_ref: dbName,
      scopes: ["pg:app.orders:select"],
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
    await proxy.down();
    try {
      await approveLease(ctx, principals.operator, created.id, { plan_hash: created.plan_hash });
      throw new Error("expected provider_unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect([(error as AppError).status, (error as AppError).code]).toEqual([503, "provider_unavailable"]);
    }
    expect((await getLease(ctx, principals.viewer, created.id)).state).toBe("requested");
    await proxy.up();
    await revokeLease(ctx, principals.operator, created.id, { reason: "cleanup" });
    await waitFor(created.id, "revoked_verified");
  });
});

describe("wired from environment configuration (what `serve` and `worker` do)", () => {
  it("runs request -> approve -> issue -> use -> revoke -> verify over HTTP against the real provider", async () => {
    const { loadConfig, contextFromConfig } = await import("../../../src/config.js");
    const { buildApp } = await import("../../../src/server.js");
    const { bootstrapAdmin } = await import("../../../src/services/auth.js");
    const fresh = await freshDatabase("al_cfg");
    const config = loadConfig({
      ACCESSLEASE_DATABASE_URL: fresh.url,
      ACCESSLEASE_SECRET_KEY: randomBytes(32).toString("base64"),
      ACCESSLEASE_PROVIDER: "postgres-role",
      ACCESSLEASE_PROVIDER_ADMIN_URL: adminBase,
      ACCESSLEASE_EGRESS_ALLOWLIST: "127.0.0.1",
      ACCESSLEASE_TTL_MIN_SECONDS: "1",
      ACCESSLEASE_TTL_DEFAULT_SECONDS: "60",
      ACCESSLEASE_PUBLIC_URL: "http://localhost:8791",
    });
    const wired = contextFromConfig(config);
    try {
      expect(wired.providers.kinds()).toEqual(["postgres-role"]);
      await migrate(wired.db);
      await bootstrapAdmin(wired, { email: "ops@example.test", password: "a-long-synthetic-password", workspaceName: "Ops" });
      const app = await buildApp(wired);
      const loginRes = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ops@example.test", password: "a-long-synthetic-password" } });
      const cookie = String(loginRes.headers["set-cookie"]).split(";")[0] as string;
      const headers = { cookie, "x-csrf-token": loginRes.json().csrf_token as string };
      const status = (await app.inject({ method: "GET", url: "/api/v1/provider", headers })).json();
      expect(status).toMatchObject({ provider: { label: "LIVE_LOCAL_POSTGRES", live: true }, connected: true });
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/v1/leases",
          headers,
          payload: { task_ref: "wired", subject_ref: "contractor-1", resource_ref: dbName, scopes: ["pg:app.orders:select"], expires_at: new Date(Date.now() + 60_000).toISOString() },
        })
      ).json();
      expect(created.state).toBe("requested");
      expect((await app.inject({ method: "POST", url: `/api/v1/leases/${created.id}/approve`, headers, payload: { plan_hash: created.plan_hash } })).statusCode).toBe(202);
      let state = "";
      for (let i = 0; i < 20 && state !== "active"; i += 1) {
        await runWorkerOnce(wired, { workerId: "wired-worker" });
        state = (await app.inject({ method: "GET", url: `/api/v1/leases/${created.id}`, headers })).json().state;
      }
      expect(state).toBe("active");
      const delivery = (await app.inject({ method: "POST", url: `/api/v1/leases/${created.id}/credential`, headers, payload: {} })).json();
      expect(delivery.credential).toMatchObject({ kind: "postgres-role", host: "127.0.0.1", port: providerPort, database: dbName });
      createdRoles.add(delivery.credential.username);
      const session = await login(delivery.credential.username, delivery.credential.secret);
      expect((await session.query("SELECT count(*)::int AS n FROM app.orders")).rows[0].n).toBe(2);
      await app.inject({ method: "POST", url: `/api/v1/leases/${created.id}/revoke`, headers, payload: { reason: "wired test" } });
      for (let i = 0; i < 20 && state !== "revoked_verified"; i += 1) {
        await runWorkerOnce(wired, { workerId: "wired-worker" });
        state = (await app.inject({ method: "GET", url: `/api/v1/leases/${created.id}`, headers })).json().state;
      }
      expect(state).toBe("revoked_verified");
      await expect(session.query("SELECT 1")).rejects.toBeTruthy();
      await expect(login(delivery.credential.username, delivery.credential.secret)).rejects.toMatchObject({ code: "28P01" });
      await app.close();
    } finally {
      await wired.providers.closeAll();
      await wired.db.close();
      await fresh.drop();
    }
  });
});
