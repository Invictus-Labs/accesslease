import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshProviderTarget, openSession, roleFacts, tryConnect, type ProviderTarget } from "../helpers/db.js";
import { sleep } from "../helpers/clock.js";

/**
 * Oracle tests: they pin down the PostgreSQL behavior the real `postgres-role` provider relies on, independently of the
 * AccessLease code. If one of these fails, the provider contract's assumptions (native TTL, residual-access window,
 * revocation order) are wrong, whatever the implementation does. Runs against the disposable provider cluster.
 */
describe("PostgreSQL provider semantics (independent oracle)", () => {
  let target: ProviderTarget;
  const admin = () => new pg.Client({ connectionString: target.adminUrl });
  const password = () => randomBytes(12).toString("hex");

  beforeAll(async () => {
    target = await freshProviderTarget();
  });
  afterAll(async () => {
    await target.drop();
  });

  async function createRole(name: string, pw: string, ttlSeconds: number, grants: string[]): Promise<void> {
    const c = admin();
    await c.connect();
    try {
      await c.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      // VALID UNTIL takes a literal, so compute it on the server's own clock.
      await c.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE "${name}" VALID UNTIL %L', (now() + interval '${ttlSeconds} seconds')::text); END $$`);
      await c.query(`GRANT CONNECT ON DATABASE ${target.database} TO "${name}"`);
      await c.query(`GRANT USAGE ON SCHEMA ${target.schema} TO "${name}"`);
      for (const grant of grants) await c.query(grant.replace("$ROLE", `"${name}"`));
    } finally {
      await c.end();
    }
  }

  it("native VALID UNTIL blocks new logins after expiry but does not end an already-open session", async () => {
    const role = `${target.rolePrefix}ttl`;
    const pw = password();
    // Use the server's own clock so test-runner skew cannot matter.
    const c = admin();
    await c.connect();
    const ttl = 3;
    await c.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await c.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE "${role}" VALID UNTIL %L', (now() + interval '${ttl} seconds')::text); END $$`);
    await c.query(`GRANT CONNECT ON DATABASE ${target.database} TO "${role}"`);
    await c.query(`GRANT USAGE ON SCHEMA ${target.schema} TO "${role}"`);
    await c.query(`GRANT SELECT ON ${target.schema}.${target.table} TO "${role}"`);
    const facts = await roleFacts(target.clusterUrl, role);
    await c.end();
    expect(facts.validUntil).not.toBeNull();

    const url = target.roleUrl(role, pw);
    // Allowed during the lease: a real connection and a real read.
    const during = await openSession(url);
    expect((await during.query(`SELECT count(*) FROM ${target.schema}.${target.table}`)).ok).toBe(true);

    // Wait until after valid-until according to the server.
    const until = facts.validUntil!.getTime();
    await sleep(Math.max(0, until - Date.now()) + 1500);

    // New logins are denied by the provider natively.
    const fresh = await tryConnect(url);
    expect(fresh.ok).toBe(false);
    expect(fresh.code).toMatch(/^28/);

    // Residual access: the pre-existing session still works. This is the documented risk AccessLease must close.
    const residual = await during.query(`SELECT count(*) FROM ${target.schema}.${target.table}`);
    expect(residual.ok).toBe(true);

    // Revocation ends it: terminate sessions, then disable login.
    const killer = admin();
    await killer.connect();
    await killer.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]);
    await killer.query(`ALTER ROLE "${role}" NOLOGIN`);
    await killer.end();
    const after = await during.query(`SELECT 1`);
    expect(after.ok).toBe(false);
    await during.close();
    expect((await roleFacts(target.clusterUrl, role)).sessions).toBe(0);
  });

  it("scope grants are table-and-privilege narrow: sibling tables and other privileges stay denied", async () => {
    const role = `${target.rolePrefix}scope`;
    const pw = password();
    await createRole(role, pw, 600, [`GRANT SELECT ON ${target.schema}.${target.table} TO $ROLE`]);
    const session = await openSession(target.roleUrl(role, pw));
    expect((await session.query(`SELECT count(*) FROM ${target.schema}.${target.table}`)).ok).toBe(true);
    const sibling = await session.query(`SELECT count(*) FROM ${target.schema}.other_records`);
    expect(sibling.ok).toBe(false);
    expect(sibling.code).toBe("42501");
    const vault = await session.query(`SELECT count(*) FROM ${target.schema}.secrets_vault`);
    expect(vault.code).toBe("42501");
    const write = await session.query(`INSERT INTO ${target.schema}.${target.table}(body) VALUES ('x')`);
    expect(write.code).toBe("42501");
    const ddl = await session.query(`CREATE TABLE ${target.schema}.pwned (id int)`);
    expect(ddl.ok).toBe(false);
    await session.close();
  });

  it("the full revocation sequence (terminate, NOLOGIN, REVOKE, DROP OWNED, DROP ROLE) removes every trace and is idempotent to re-run", async () => {
    const role = `${target.rolePrefix}drop`;
    const pw = password();
    await createRole(role, pw, 600, [`GRANT SELECT, INSERT ON ${target.schema}.${target.table} TO $ROLE`]);
    const session = await openSession(target.roleUrl(role, pw));
    expect((await session.query(`SELECT 1`)).ok).toBe(true);

    const c = admin();
    await c.connect();
    await c.query(`ALTER ROLE "${role}" NOLOGIN`);
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]);
    await c.query(`REVOKE ALL ON ${target.schema}.${target.table} FROM "${role}"`);
    await c.query(`REVOKE USAGE ON SCHEMA ${target.schema} FROM "${role}"`);
    await c.query(`REVOKE CONNECT ON DATABASE ${target.database} FROM "${role}"`);
    await c.query(`DROP OWNED BY "${role}"`);
    await c.query(`DROP ROLE "${role}"`);
    // Re-running the sequence must be safe.
    await c.query(`DROP ROLE IF EXISTS "${role}"`);
    await c.end();

    expect((await session.query(`SELECT 1`)).ok).toBe(false);
    await session.close();
    expect(await roleFacts(target.clusterUrl, role)).toMatchObject({ exists: false, sessions: 0 });
    const denied = await tryConnect(target.roleUrl(role, pw));
    expect(denied.ok).toBe(false);
  });
});
