import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Throwaway-database helpers. Every test file gets uniquely named databases and roles, so concurrent agents and
 * concurrent test files that share a disposable server never collide. Servers come from scripts/test-db.sh.
 */

export function metadataAdminUrl(): string {
  const url = process.env.ACCESSLEASE_TEST_DATABASE_URL;
  if (!url) throw new Error("ACCESSLEASE_TEST_DATABASE_URL is required: integration tests run against real PostgreSQL (see scripts/test-db.sh and scripts/verify-quality.sh)");
  return url;
}

export function providerAdminUrl(): string {
  const url = process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL;
  if (!url) throw new Error("ACCESSLEASE_TEST_PROVIDER_DATABASE_URL is required: live provider tests need the disposable provider cluster (see scripts/test-db.sh)");
  return url;
}

export const hasProviderCluster = (): boolean => Boolean(process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL);

export function withDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Short unique suffix, lowercase hex; safe inside SQL identifiers. */
export const uniqueSuffix = (): string => randomBytes(6).toString("hex");

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface ThrowawayDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** A fresh, uniquely named database on the metadata server, dropped (FORCE) afterwards. */
export async function freshMetadataDatabase(): Promise<ThrowawayDatabase> {
  const adminUrl = metadataAdminUrl();
  const name = `al_meta_${uniqueSuffix()}`;
  await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE ${name}`));
  return {
    name,
    url: withDatabase(adminUrl, name),
    drop: () => withAdmin(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => undefined),
  };
}

export interface ProviderTarget {
  /** Database on the provider cluster that holds the protected sample tables. */
  database: string;
  /** Superuser URL pointing at that database: what the real provider is configured with. */
  adminUrl: string;
  /** Superuser URL for the cluster's maintenance database (role facts are cluster-wide). */
  clusterUrl: string;
  schema: string;
  table: string;
  /** Prefix test roles must use so cleanup can find them. */
  rolePrefix: string;
  /** Rows seeded into the sample table. */
  seededRows: number;
  /** Connection URL for an issued credential against this target. */
  roleUrl(role: string, password: string): string;
  /** Roles on the cluster whose names start with this target's prefix (live view, from pg_roles). */
  listRoles(): Promise<string[]>;
  drop(): Promise<void>;
}

const likePrefix = (prefix: string): string => `${prefix.replace(/_/g, "\\_")}%`;

/**
 * A fresh database on the disposable provider cluster with one protected sample table, plus two sibling tables used to
 * prove scope narrowness (a grant on `records` must not reach `other_records` or `secrets_vault`).
 */
export async function freshProviderTarget(): Promise<ProviderTarget> {
  const clusterUrl = providerAdminUrl();
  const suffix = uniqueSuffix();
  const database = `al_prov_${suffix}`;
  const schema = "app";
  const table = "records";
  const rolePrefix = `alt_${suffix}_`;
  await withAdmin(clusterUrl, (c) => c.query(`CREATE DATABASE ${database}`));
  const adminUrl = withDatabase(clusterUrl, database);
  await withAdmin(adminUrl, async (c) => {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`CREATE TABLE ${schema}.${table} (id serial PRIMARY KEY, body text NOT NULL)`);
    await c.query(`CREATE TABLE ${schema}.other_records (id serial PRIMARY KEY, body text NOT NULL)`);
    await c.query(`CREATE TABLE ${schema}.secrets_vault (id serial PRIMARY KEY, body text NOT NULL)`);
    await c.query(`INSERT INTO ${schema}.${table}(body) VALUES ('synthetic-row-1'), ('synthetic-row-2'), ('synthetic-row-3')`);
    await c.query(`INSERT INTO ${schema}.other_records(body) VALUES ('synthetic-other-1')`);
    await c.query(`INSERT INTO ${schema}.secrets_vault(body) VALUES ('synthetic-vault-1')`);
  });
  return {
    database,
    adminUrl,
    clusterUrl,
    schema,
    table,
    rolePrefix,
    seededRows: 3,
    roleUrl: (role, password) => {
      const u = new URL(adminUrl);
      u.username = role;
      u.password = password;
      return u.toString();
    },
    listRoles: () => withAdmin(clusterUrl, async (c) => (await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ORDER BY rolname`, [likePrefix(rolePrefix)])).rows.map((r) => r.rolname)),
    drop: async () => {
      await withAdmin(clusterUrl, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        const roles = await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [likePrefix(rolePrefix)]);
        for (const r of roles.rows) await c.query(`DROP ROLE IF EXISTS "${r.rolname}"`).catch(() => undefined);
      });
    },
  };
}

export interface ConnectOutcome {
  ok: boolean;
  /** SQLSTATE or network error code when the attempt failed. */
  code?: string;
  message?: string;
}

const failure = (error: unknown): ConnectOutcome => {
  const e = error as { code?: string; message?: string };
  return { ok: false, code: e.code, message: e.message };
};

/** Attempt a real connection with a credential; always closes it. */
export async function tryConnect(url: string, query = "SELECT 1"): Promise<ConnectOutcome> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query(query);
    return { ok: true };
  } catch (error) {
    return failure(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface HeldSession {
  pid: number;
  query(sql: string): Promise<ConnectOutcome & { rows?: unknown[] }>;
  close(): Promise<void>;
}

/** Open a session and keep it open: models a contractor session that outlives the grant. */
export async function openSession(url: string): Promise<HeldSession> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  client.on("error", () => undefined);
  await client.connect();
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  return {
    pid,
    async query(sql) {
      try {
        const r = await client.query(sql);
        return { ok: true, rows: r.rows };
      } catch (error) {
        return failure(error);
      }
    },
    close: () => client.end().catch(() => undefined),
  };
}

/** Read-only fact lookups on the provider cluster, used as an independent oracle (not the code under test). */
export async function roleFacts(clusterUrl: string, role: string): Promise<{ exists: boolean; canLogin: boolean | null; validUntil: Date | null; sessions: number }> {
  return withAdmin(clusterUrl, async (c) => {
    const r = await c.query<{ rolcanlogin: boolean; rolvaliduntil: Date | null }>(`SELECT rolcanlogin, rolvaliduntil FROM pg_roles WHERE rolname = $1`, [role]);
    const s = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE usename = $1`, [role]);
    const row = r.rows[0];
    return { exists: Boolean(row), canLogin: row?.rolcanlogin ?? null, validUntil: row?.rolvaliduntil ?? null, sessions: Number(s.rows[0]!.n) };
  });
}

export async function tableCount(url: string, qualified: string): Promise<number> {
  return withAdmin(url, async (c) => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qualified}`)).rows[0]!.n));
}
