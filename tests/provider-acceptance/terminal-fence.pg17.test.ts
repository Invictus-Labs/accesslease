/** Opt-in disposable PG17 acceptance. Never included in the ordinary unit suite. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresRoleProvider } from "../../src/connectors/postgres-role.js";
import type { GrantTarget, IssueRequest } from "../../src/connectors/provider.js";

const base = process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL;
if (process.env.ACCESSLEASE_TERMINAL_FENCE_LIVE_ACK !== "disposable-pg17" || !base) {
  throw new Error("Explicit disposable-pg17 acknowledgement and test provider URL required; no skip or live default");
}
const endpoint = new URL(base);
if (!["127.0.0.1", "localhost"].includes(endpoint.hostname) || endpoint.pathname !== "/postgres" || endpoint.username !== "al_admin") {
  throw new Error("Acceptance requires loopback disposable al_admin maintenance database; existing provider targets forbidden");
}
const COORDINATION_WAIT_MS = 5000;
async function boundedWait(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Coordination wait timed out: ${label}`)), COORDINATION_WAIT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { wait: (label: string) => boundedWait(promise, label), resolve };
};
async function connect(database = "postgres") {
  const url = new URL(base!); url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, statement_timeout: 8000, query_timeout: 9000 });
  client.on("error", () => undefined); await client.connect(); return client;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  while (cleanup.length) {
    try { await cleanup.pop()!(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Owned fixture cleanup failed");
});
/** Register gates before launch; always release and settle started operations before afterEach. */
async function coordinated(run: (scope: {
  gate(): ReturnType<typeof deferred>;
  track<T>(start: () => Promise<T>): Promise<T>;
}) => Promise<void>) {
  const releases: (() => void)[] = [];
  const operations: Promise<unknown>[] = [];
  let closing = false;
  const releaseAndDrain = async () => {
    closing = true;
    for (const release of releases) release();
    await Promise.allSettled(operations);
  };
  // Vitest timeout does not cancel the case: afterEach must drain before DB callbacks too.
  cleanup.push(releaseAndDrain);
  try {
    await run({
      gate() { const gate = deferred(); releases.push(gate.resolve); return gate; },
      track<T>(start: () => Promise<T>) {
        if (closing) throw new Error("Coordination is closing; refusing another provider launch");
        const operation = start();
        operations.push(operation);
        // Handle rejection immediately even if readiness/assertions fail before the await.
        void operation.catch(() => undefined);
        return operation;
      },
    });
  } finally {
    await releaseAndDrain();
  }
}

async function fresh(provision = true) {
  const database = `al_tf_${randomBytes(6).toString("hex")}`;
  const leaseId = randomUUID(); const target: GrantTarget = { leaseId, resource: database };
  const admin = await connect();
  const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
  if (version < 170000 || version >= 180000) { await admin.end(); throw new Error("PostgreSQL17 server required"); }
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
  const role = new PostgresRoleProvider({ adminUrl: base!, allowlist: ["127.0.0.1", "localhost"], queryTimeoutMs: 8000 }).providerRefFor(leaseId);
  cleanup.push(async () => {
    try {
      const owner = (await admin.query("SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1", [role])).rows[0];
      if (owner && owner.marker !== `accesslease:lease:${leaseId}`) throw new Error("Cleanup refuses foreign role ownership");
      if (owner) {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()", [role]);
        await admin.query(`DROP DATABASE ${pg.escapeIdentifier(database)} WITH (FORCE)`);
        await admin.query(`DROP ROLE ${pg.escapeIdentifier(role)}`);
      } else await admin.query(`DROP DATABASE ${pg.escapeIdentifier(database)} WITH (FORCE)`);
    } finally { await admin.end(); }
  });
  // Only this freshly named database changes its inherited default. Existing database/role settings are untouched.
  await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(database)} SET default_transaction_isolation = 'repeatable read'`);
  const db = await connect(database); cleanup.push(() => db.end());
  const migration = await readFile(new URL("../../provider-migrations/001_terminal_fences.sql", import.meta.url), "utf8");
  if (provision) await db.query(migration);
  await db.query("CREATE SCHEMA app; CREATE TABLE app.orders(id integer PRIMARY KEY)");
  const provider = () => new PostgresRoleProvider({ adminUrl: base!, allowlist: ["127.0.0.1", "localhost"], queryTimeoutMs: 8000 });
  const request = (): IssueRequest => ({ ...target, attempt: 1, subject: "synthetic-operator", scopes: ["pg:app.orders:select"], expiresAt: new Date(Date.now()+60_000), credentialSecret: "synthetic-terminal-fence-password" });
  return { database, target, db, admin, role, migration, provider, request,
    absent: async () => expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role])).rows).toHaveLength(0),
    fenced: async () => expect((await db.query("SELECT lease_id::text FROM accesslease_control.terminal_fences WHERE provider_ref=$1",[role])).rows).toEqual([{lease_id:leaseId}]),
  };
}
/** Intercept one actual connected client query; SQL before/after the pause still runs on the PG17 server. */
function instrument(provider: PostgresRoleProvider, hook: (client: pg.Client, sql: string) => Promise<void>) {
  const internal = provider as unknown as { connect(database:string|null):Promise<pg.Client> };
  const original = internal.connect.bind(provider);
  internal.connect = async (database) => {
    const client = await original(database); const query = client.query.bind(client);
    client.query = (async (...args: any[]) => { await hook(client,String(args[0])); return (query as any)(...args); }) as typeof client.query;
    return client;
  };
}
async function advisoryWait(env: Awaited<ReturnType<typeof fresh>>) {
  const deadline = Date.now()+5000;
  do {
    const rows = await env.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='accesslease' AND wait_event='advisory'",[env.database]);
    if (rows.rows.length) return;
    await new Promise((done)=>setTimeout(done,20));
  } while(Date.now()<deadline);
  throw new Error("Expected queued advisory lock was not observed");
}

describe("PostgreSQL17 provider terminal fences — opt-in real SQL acceptance", () => {
  it("refuses missing provisioning, then provisions owned objects and retains the fence across a fresh provider", async () => {
    const env=await fresh(false);const provider=env.provider();
    await expect(provider.issue(env.request())).rejects.toMatchObject({code:"provider_unavailable"});
    await expect(provider.revoke(env.target)).rejects.toMatchObject({code:"provider_unavailable"});await env.absent();
    await env.db.query(env.migration);await provider.issue(env.request());
    expect((await provider.revoke(env.target)).steps.every(s=>s.ok)).toBe(true);await env.absent();await env.fenced();
    expect(await env.provider().probeUse({...env.target,credentialSecret:env.request().credentialSecret})).toBe("denied");
    await expect(env.provider().issue(env.request())).rejects.toMatchObject({code:"grant_terminal"});
  });
  it("rejects an issuer queued after its catalog query under an inherited Repeatable Read default", async () => {
    const env=await fresh();const revoker=env.provider();const issuing=env.provider();
    await coordinated(async scope => {
      const paused=scope.gate();const resume=scope.gate();
      expect((await env.db.query("SHOW default_transaction_isolation")).rows[0].default_transaction_isolation).toBe("repeatable read");
      instrument(revoker,async (_client,sql)=>{if(sql==="COMMIT"){paused.resolve();await resume.wait("revoke commit resume");}});
      const revoked=scope.track(() => revoker.revoke(env.target));await paused.wait("revoke commit ready");
      const issued=scope.track(() => issuing.issue(env.request()));
      await advisoryWait(env);resume.resolve();
      expect((await revoked).steps.every(s=>s.ok)).toBe(true);
      await expect(issued).rejects.toMatchObject({code:"grant_terminal"});await env.absent();await env.fenced();
    });
  });
  it("rejects an issue whose actual connection arrives after terminal revoke commits", async () => {
    const env=await fresh();const issuer=env.provider();
    await coordinated(async scope => {
      const ready=scope.gate();const resume=scope.gate();
      const internal=issuer as unknown as {connect(database:string|null):Promise<pg.Client>};const original=internal.connect.bind(issuer);
      internal.connect=async database=>{ready.resolve();await resume.wait("issuer connection resume");return original(database);};
      const issued=scope.track(() => issuer.issue(env.request()));await ready.wait("issuer connection ready");
      expect((await scope.track(() => env.provider().revoke(env.target))).steps.every(s=>s.ok)).toBe(true);resume.resolve();
      await expect(issued).rejects.toMatchObject({code:"grant_terminal"});await env.absent();await env.fenced();
    });
  });
  it("orders revoke after an issuance already paused before real commit", async () => {
    const env=await fresh();const issuer=env.provider();
    await coordinated(async scope => {
      const ready=scope.gate();const resume=scope.gate();
      instrument(issuer,async (_client,sql)=>{if(sql==="COMMIT"){ready.resolve();await resume.wait("issuer commit resume");}});
      const issued=scope.track(() => issuer.issue(env.request()));await ready.wait("issuer commit ready");
      const revoked=scope.track(() => env.provider().revoke(env.target));
      await advisoryWait(env);resume.resolve();
      await issued;expect((await revoked).steps.every(s=>s.ok)).toBe(true);await env.absent();await env.fenced();
    });
  });
  it("propagates a lost fence commit answer while persisted terminal record blocks fresh reissue", async () => {
    const env=await fresh();const revoker=env.provider();
    // Replace query at connection boundary so COMMIT reaches PG once and then reports ambiguity.
    const internal=revoker as unknown as {connect(database:string|null):Promise<pg.Client>};const connectOriginal=internal.connect.bind(revoker);
    internal.connect=async database=>{const client=await connectOriginal(database);const query=client.query.bind(client);
      client.query=(async(...args:any[])=>{const result=await (query as any)(...args);if(args[0]==="COMMIT")throw Object.assign(new Error("synthetic lost committed answer"),{code:"08006"});return result;}) as typeof client.query;return client;};
    await expect(revoker.revoke(env.target)).rejects.toMatchObject({code:"provider_unavailable"});await env.fenced();await env.absent();
    await expect(env.provider().issue(env.request())).rejects.toMatchObject({code:"grant_terminal"});
  });
  it("retains the fence through a rejected actual session termination and then reconciles cleanup", async () => {
    const env=await fresh();await env.provider().issue(env.request());const revoker=env.provider();
    const session=new pg.Client({host:endpoint.hostname,port:Number(endpoint.port||5432),database:env.database,user:env.role,password:env.request().credentialSecret,connectionTimeoutMillis:5000});
    session.on("error",()=>undefined);await session.connect();cleanup.push(()=>session.end());
    instrument(revoker,async(client,sql)=>{if(sql.includes("pg_terminate_backend"))await client.query("SELECT 1/0");});
    const result=await revoker.revoke(env.target);expect(result.steps.some(s=>s.step==="terminate_sessions"&&!s.ok)).toBe(true);await env.fenced();
    const present=await env.provider().lookup(env.target);expect(present.state).toBe("present");expect(present.loginAllowed).toBe(false);expect(present.activeSessions).toBeGreaterThan(0);
    expect((await session.query("SELECT 1 AS allowed")).rows[0].allowed).toBe(1);
    await expect(env.provider().issue(env.request())).rejects.toMatchObject({code:"grant_terminal"});
    expect((await env.provider().revoke(env.target)).steps.every(s=>s.ok)).toBe(true);await env.absent();await env.fenced();
  });
});
