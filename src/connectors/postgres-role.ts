import pg from "pg";
import { sha256Hex } from "../domain/canonical.js";
import { genericScopeCheck, isPgDatabaseName, isSystemSchema, normalizeScopes, parsePgScope } from "../domain/scopes.js";
import { REVOCATION_REQUEST_SLA_SECONDS } from "../domain/types.js";
import { EgressDeniedError, type Resolver, checkEndpoint, systemResolver } from "../lib/egress.js";
import {
  type GrantTarget,
  type IssueRequest,
  type IssueResult,
  type LookupResult,
  type ProbeResult,
  type Provider,
  type ProviderCapabilities,
  ProviderRejectedError,
  ProviderUnavailableError,
  type RevokeResult,
  type RevokeStep,
  type ScopeCheck,
} from "./provider.js";

/**
 * REAL local provider: grants one narrow, time-limited login role on a separate (disposable) PostgreSQL cluster.
 * See docs/contracts/provider.md and docs/contracts/residual-access.md.
 *
 * Native TTL is `VALID UNTIL`, which PostgreSQL checks only at authentication: an already-open session survives expiry
 * until AccessLease terminates it. Revocation therefore is: ALTER ROLE NOLOGIN, pg_terminate_backend, DROP OWNED, DROP ROLE;
 * verification is pg_roles/pg_stat_activity introspection AND a denied-use probe (a real login attempt).
 */

export interface PostgresRoleOptions {
  /** Admin URL of the target cluster (superuser, or CREATEROLE + pg_signal_backend). Never the metadata database. */
  adminUrl: string;
  /** Egress allowlist entries; the admin host must be on it (DNS results are re-checked on every connection). */
  allowlist: readonly string[];
  /** Host shown to grantees (default: host of the admin URL). */
  publicHost?: string | null;
  resolver?: Resolver;
  connectTimeoutMs?: number;
  /** Per-statement timeout (client query_timeout and server statement_timeout). */
  queryTimeoutMs?: number;
  /** Per-role CONNECTION LIMIT. */
  connectionLimit?: number;
  /** Bounded wait for sessions to terminate during revocation. */
  terminateWaitMs?: number;
}

const DENIED_CODES = new Set(["28000", "28P01"]);

const isConnectionError = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  if (!code) return true;
  return /^(E[A-Z]+|08|53|57P|58|XX)/.test(code);
};

const roleNameFor = (leaseId: string): string => `al_${sha256Hex(leaseId).slice(0, 24)}`;

export class PostgresRoleProvider implements Provider {
  readonly kind = "postgres-role" as const;
  private readonly admin: URL;
  private readonly resolver: Resolver;
  private readonly timeout: number;
  private readonly queryTimeout: number;
  private serverVersion = "unknown";

  constructor(private readonly options: PostgresRoleOptions) {
    this.admin = new URL(options.adminUrl);
    this.resolver = options.resolver ?? systemResolver;
    this.timeout = options.connectTimeoutMs ?? 5000;
    this.queryTimeout = options.queryTimeoutMs ?? 15_000;
  }

  capabilities(): ProviderCapabilities {
    return {
      kind: "postgres-role",
      label: "LIVE_LOCAL_POSTGRES",
      live: true,
      nativeTtl: true,
      revocation: true,
      introspection: true,
      deniedUseProbe: true,
      maxResidualAccessSeconds: REVOCATION_REQUEST_SLA_SECONDS,
      scopeGrammar: "pg:<schema>.<table>:<select|insert|update>",
      version: `postgres-role/1 (server ${this.serverVersion})`,
    };
  }

  providerRefFor(leaseId: string): string {
    return roleNameFor(leaseId);
  }

  validateScope(scope: string): ScopeCheck {
    const generic = genericScopeCheck(scope);
    if (!generic.ok) return generic;
    const parsed = parsePgScope(scope);
    if (!parsed) return { ok: false, code: "invalid_scope", message: "scope must match pg:<schema>.<table>:<select|insert|update>" };
    if (isSystemSchema(parsed.schema)) return { ok: false, code: "scope_forbidden", message: "system and AccessLease control schemas cannot be granted" };
    return { ok: true };
  }

  validateResource(resource: string) {
    return isPgDatabaseName(resource) ? ({ ok: true } as const) : ({ ok: false, message: "resource must be a PostgreSQL database name (lowercase letters, digits, underscore)" } as const);
  }

  // ---- connections (egress allowlist + DNS pinning on every connect) ----

  private async clientConfig(database: string | null, user?: string, password?: string): Promise<pg.ClientConfig> {
    const host = this.admin.hostname.replace(/^\[|\]$/g, "");
    const port = this.admin.port ? Number(this.admin.port) : 5432;
    let addresses: string[];
    try {
      addresses = await checkEndpoint({ host, port }, this.options.allowlist, this.resolver);
    } catch (error) {
      // checkEndpoint only ever throws EgressDeniedError (resolver failures are reported as dns_failure).
      throw new ProviderUnavailableError("provider_disconnected", `egress check failed: ${(error as EgressDeniedError).reason}`);
    }
    const sslmode = this.admin.searchParams.get("sslmode");
    return {
      host: addresses[0],
      port,
      user: user ?? decodeURIComponent(this.admin.username),
      password: password ?? decodeURIComponent(this.admin.password),
      database: database ?? (decodeURIComponent(this.admin.pathname.slice(1)) || "postgres"),
      connectionTimeoutMillis: this.timeout,
      // A connection that goes silent after connect must fail, not hang: client-side query timeout, server-side statement timeout, TCP keep-alive.
      query_timeout: this.queryTimeout,
      statement_timeout: this.queryTimeout,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
      application_name: "accesslease",
      ...(sslmode && sslmode !== "disable" ? { ssl: { rejectUnauthorized: sslmode !== "require", servername: host } } : {}),
    };
  }

  private async connect(database: string | null): Promise<pg.Client> {
    const client = new pg.Client(await this.clientConfig(database));
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      // The server answered: the resource database does not exist. Nothing was or can be created: a definite refusal.
      if ((error as { code?: string }).code === "3D000") throw new ProviderRejectedError("database_missing", "the target database does not exist");
      throw this.unavailable(error);
    }
    return client;
  }

  private unavailable(error: unknown): ProviderUnavailableError {
    if (error instanceof ProviderUnavailableError) return error;
    const code = (error as { code?: string }).code ?? "";
    const timeout = code === "ETIMEDOUT" || /timeout/i.test((error as Error).message ?? "");
    return new ProviderUnavailableError(timeout ? "provider_timeout" : "provider_unavailable", `postgres provider unreachable (${code || "connection error"})`);
  }

  private async withAdmin<T>(database: string | null, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = await this.connect(database);
    try {
      return await fn(client);
    } catch (error) {
      if (error instanceof ProviderUnavailableError || error instanceof ProviderRejectedError) throw error;
      if (isConnectionError(error)) throw this.unavailable(error);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async ping(): Promise<void> {
    await this.withAdmin(null, async (client) => {
      const version = await client.query<{ server_version: string }>("SHOW server_version");
      this.serverVersion = version.rows[0]?.server_version ?? "unknown";
    });
  }

  /** Superuser/CREATEROLE sanity for `doctor`: returns facts, throws ProviderUnavailableError when disconnected. */
  async inspectAdmin(): Promise<{ serverVersion: string; superuser: boolean; createRole: boolean; canSignal: boolean; systemIdentifier: string | null }> {
    return this.withAdmin(null, async (client) => {
      const me = await client.query<{ v: string; rolsuper: boolean; rolcreaterole: boolean; signal: boolean }>(
        `SELECT current_setting('server_version') AS v, r.rolsuper, r.rolcreaterole,
                (r.rolsuper OR pg_has_role(current_user, 'pg_signal_backend', 'member')) AS signal
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      const row = me.rows[0];
      this.serverVersion = row?.v ?? "unknown";
      let systemIdentifier: string | null = null;
      try {
        systemIdentifier = String((await client.query<{ id: string }>("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0]?.id ?? "") || null;
        /* v8 ignore next 3 -- pg_control_system() is permitted for every role on PostgreSQL 17; guard for hardened or older servers */
      } catch {
        systemIdentifier = null;
      }
      return { serverVersion: this.serverVersion, superuser: Boolean(row?.rolsuper), createRole: Boolean(row?.rolcreaterole), canSignal: Boolean(row?.signal), systemIdentifier };
    });
  }

  /** Explicitly provisioned in each resource database; never create control objects on a live call. */
  private async lockTerminalFence(client: pg.Client, target: GrantTarget, terminal: boolean): Promise<void> {
    const control = await client.query<{ schema_owner: string; table_owner: string; schema_version: string | null; table_version: string | null; kind: string; private_acl: boolean; durable: boolean; no_rls: boolean }>(
      `SELECT pg_get_userbyid(n.nspowner) AS schema_owner, pg_get_userbyid(c.relowner) AS table_owner,
              obj_description(n.oid, 'pg_namespace') AS schema_version,
              obj_description(c.oid, 'pg_class') AS table_version, c.relkind AS kind,
              c.relpersistence = 'p' AS durable, NOT (c.relrowsecurity OR c.relforcerowsecurity) AS no_rls,
              (NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a WHERE a.grantee <> n.nspowner)
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee <> c.relowner)
               AND NOT EXISTS (SELECT 1 FROM pg_attribute x, LATERAL aclexplode(x.attacl) a WHERE x.attrelid = c.oid AND a.grantee <> c.relowner)) AS private_acl
         FROM pg_namespace n JOIN pg_class c ON c.relnamespace = n.oid
        WHERE n.nspname = 'accesslease_control' AND c.relname = 'terminal_fences'`,
    );
    const owner = (await client.query<{ name: string }>("SELECT current_user AS name")).rows[0]?.name;
    const facts = control.rows[0];
    if (!owner || !facts || facts.schema_owner !== owner || facts.table_owner !== owner || facts.kind !== "r" ||
        !facts.private_acl || !facts.durable || !facts.no_rls ||
        facts.schema_version !== "accesslease:provider-control:v1" || facts.table_version !== "accesslease:terminal-fences:v1") {
      throw new ProviderUnavailableError("provider_unavailable", "provider control schema/table is missing, unsupported, publicly accessible or not privately owned by the configured administrator");
    }
    const ref = roleNameFor(target.leaseId);
    // Same resource database and key for issue/revoke. Acquired before touching the role, retained through COMMIT.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`accesslease:terminal-fence:${ref}`]);
    const existing = await client.query<{ lease_id: string; resource_ref: string }>(
      "SELECT lease_id::text, resource_ref FROM accesslease_control.terminal_fences WHERE provider_ref = $1", [ref],
    );
    const fence = existing.rows[0];
    if (fence && (fence.lease_id !== target.leaseId || fence.resource_ref !== target.resource)) {
      throw new ProviderUnavailableError("provider_unavailable", "terminal fence identity does not match this lease");
    }
    if (!terminal && fence) throw new ProviderRejectedError("grant_terminal", "this lease was terminally closed at the provider; it cannot issue again");
    if (terminal && !fence) {
      await client.query(
        "INSERT INTO accesslease_control.terminal_fences (provider_ref, lease_id, resource_ref) VALUES ($1,$2,$3)",
        [ref, target.leaseId, target.resource],
      );
    }
  }

  // ---- issue (create or align, one transaction) ----

  async issue(request: IssueRequest): Promise<IssueResult> {
    const role = roleNameFor(request.leaseId);
    const db = request.resource;
    if (!isPgDatabaseName(db)) throw new ProviderRejectedError("invalid_resource", "invalid database name");
    const grants: { schema: string; table: string; privilege: string }[] = [];
    for (const scope of request.scopes) {
      const verdict = this.validateScope(scope);
      if (!verdict.ok) throw new ProviderRejectedError(verdict.code, verdict.message);
      const parsed = parsePgScope(scope);
      if (parsed) grants.push({ schema: parsed.schema, table: parsed.table, privilege: parsed.privilege });
    }
    if (grants.length === 0) throw new ProviderRejectedError("invalid_scope", "at least one scope is required");
    if (request.expiresAt.getTime() <= Date.now()) throw new ProviderRejectedError("expired", "expires_at is in the past for the provider");
    if (request.credentialSecret.length < 16) throw new ProviderRejectedError("weak_secret", "credential secret too short");
    const marker = `accesslease:lease:${request.leaseId}`;

    const client = await this.connect(db);
    let begun = false;
    try {
      const q = (id: string) => client.escapeIdentifier(id);
      const lit = (value: string) => client.escapeLiteral(value);
      // Do not inherit REPEATABLE READ: the fence read after a waited lock needs the latest committed row.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      begun = true;
      await this.lockTerminalFence(client, request, false);
      if (request.expiresAt.getTime() <= Date.now()) throw new ProviderRejectedError("expired", "expires_at elapsed while waiting for the provider fence");
      const existing = await client.query<{ comment: string | null }>("SELECT shobj_description(oid, 'pg_authid') AS comment FROM pg_roles WHERE rolname = $1", [role]);
      const alreadyExisted = existing.rows.length > 0;
      if (alreadyExisted && existing.rows[0]?.comment !== marker) throw new ProviderRejectedError("role_collision", "a role with the derived name exists and was not created by this lease");
      const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT ${this.options.connectionLimit ?? 5} PASSWORD ${lit(request.credentialSecret)} VALID UNTIL ${lit(request.expiresAt.toISOString())}`;
      if (alreadyExisted) {
        await client.query(`ALTER ROLE ${q(role)} ${attrs}`);
        // Align by resetting every privilege this role holds in this database before re-granting exactly the requested set.
        await client.query(`DROP OWNED BY ${q(role)}`);
      } else {
        await client.query(`CREATE ROLE ${q(role)} ${attrs}`);
        await client.query(`COMMENT ON ROLE ${q(role)} IS ${lit(marker)}`);
      }
      await client.query(`GRANT CONNECT ON DATABASE ${q(db)} TO ${q(role)}`);
      for (const schema of new Set(grants.map((g) => g.schema))) await client.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
      for (const g of grants) {
        await client.query(`GRANT ${g.privilege.toUpperCase()} ON TABLE ${q(g.schema)}.${q(g.table)} TO ${q(role)}`);
        if (g.privilege !== "insert") continue;
        // An INSERT that uses a serial/identity default needs USAGE (and nothing more) on the sequences the table owns.
        const owned = await client.query<{ seq: string }>(
          `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS seq
             FROM pg_depend d JOIN pg_class c ON c.oid = d.objid AND c.relkind = 'S' JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE d.refobjid = to_regclass($1) AND d.deptype IN ('a', 'i')`,
          [`${q(g.schema)}.${q(g.table)}`],
        );
        for (const { seq } of owned.rows) await client.query(`GRANT USAGE ON SEQUENCE ${seq} TO ${q(role)}`);
      }
      await client.query("COMMIT");
      begun = false;
      return {
        providerRef: role,
        validUntil: request.expiresAt,
        alreadyExisted,
        connection: {
          host: this.options.publicHost ?? this.admin.hostname.replace(/^\[|\]$/g, ""),
          port: this.admin.port ? Number(this.admin.port) : 5432,
          database: db,
          username: role,
        },
      };
    } catch (error) {
      if (begun) await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ProviderRejectedError || error instanceof ProviderUnavailableError) throw error;
      if (isConnectionError(error)) throw new ProviderUnavailableError("provider_ambiguous", "connection lost while issuing; the outcome is unknown");
      const code = (error as { code?: string }).code ?? "";
      // SQL error with a SQLSTATE inside the transaction: everything was rolled back, nothing was created.
      throw new ProviderRejectedError(`sql_${code || "error"}`, `provider refused the grant (${code || "error"})`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  // ---- introspection ----

  async lookup(target: GrantTarget): Promise<LookupResult> {
    const role = roleNameFor(target.leaseId);
    return this.withAdmin(null, async (client) => {
      const found = await client.query<{
        oid: number;
        rolcanlogin: boolean;
        rolvaliduntil: Date | null;
        login_allowed: boolean;
        rolsuper: boolean;
        comment: string | null;
      }>(
        `SELECT oid, rolcanlogin, rolvaliduntil, rolsuper, shobj_description(oid, 'pg_authid') AS comment,
                (rolcanlogin AND (rolvaliduntil IS NULL OR rolvaliduntil > now())) AS login_allowed
           FROM pg_roles WHERE rolname = $1`,
        [role],
      );
      const row = found.rows[0];
      if (!row) return { state: "absent", validUntil: null, loginAllowed: false, activeSessions: 0, scopes: null, detail: { provider: "postgres-role", role_exists: false } };
      const sessions = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [role]);
      let scopes: string[] | null = null;
      try {
        scopes = await this.grantedScopes(target.resource, role);
      } catch {
        scopes = null;
      }
      return {
        state: "present",
        validUntil: row.rolvaliduntil,
        loginAllowed: row.login_allowed,
        activeSessions: sessions.rows[0]?.n ?? 0,
        scopes,
        detail: { provider: "postgres-role", role_exists: true, can_login: row.rolcanlogin, superuser: row.rolsuper, owned_by_accesslease: Boolean(row.comment?.startsWith("accesslease:lease:")) },
      };
    });
  }

  private async grantedScopes(database: string, role: string): Promise<string[]> {
    return this.withAdmin(database, async (client) => {
      const grants = await client.query<{ table_schema: string; table_name: string; privilege_type: string }>(
        `SELECT table_schema, table_name, privilege_type FROM information_schema.table_privileges
          WHERE grantee = $1 AND privilege_type IN ('SELECT','INSERT','UPDATE') ORDER BY 1, 2, 3`,
        [role],
      );
      return normalizeScopes(grants.rows.map((g) => `pg:${g.table_schema}.${g.table_name}:${g.privilege_type.toLowerCase()}`));
    });
  }

  // ---- revocation ----

  async revoke(target: GrantTarget): Promise<RevokeResult> {
    // The durable terminal record commits even when cleanup is partial. A later retry can finish cleanup,
    // but no delayed issue (including after restart or restored stale metadata) can resurrect this role.
    try {
      return await this.revokeWithFence(target);
    } catch (error) {
      if (!(error instanceof ProviderRejectedError) || error.code !== "database_missing") throw error;
      // The server definitively answered that the resource database does not exist, so no fence can be written there and
      // no issue can commit there. Settle only when the cluster-wide role is also absent; a surviving role (database dropped
      // after issuance) has no fence and stays unconfirmed. Residual risk: the same database is later created and provisioned
      // and stale metadata replays an issue for this lease (docs/contracts/provider.md, "Terminal issuance barrier").
      const present = await this.withAdmin(null, async (client) =>
        (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleNameFor(target.leaseId)])).rows.length > 0,
      );
      if (present) throw error;
      return { steps: [{ step: "resource_database_absent", ok: true }, { step: "role_absent", ok: true }], sessionsTerminated: 0 };
    }
  }

  private async revokeWithFence(target: GrantTarget): Promise<RevokeResult> {
    return this.withAdmin(target.resource, async (client) => {
      // Do not inherit REPEATABLE READ: the fence read after a waited lock needs the latest committed row.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await this.lockTerminalFence(client, target, true);
        const result = await this.revokeFenced(target);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async revokeFenced(target: GrantTarget): Promise<RevokeResult> {
    const role = roleNameFor(target.leaseId);
    const steps: RevokeStep[] = [];
    let terminated = 0;
    const step = async (name: string, fn: () => Promise<string | undefined>) => {
      try {
        steps.push({ step: name, ok: true, detail: await fn() });
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error;
        steps.push({ step: name, ok: false, detail: `sqlstate ${(error as { code?: string }).code ?? "unknown"}` });
      }
    };
    const owned = await this.withAdmin(null, async (client) => {
      const r = await client.query<{ comment: string | null }>("SELECT shobj_description(oid, 'pg_authid') AS comment FROM pg_roles WHERE rolname = $1", [role]);
      return r.rows.length === 0 ? "absent" : r.rows[0]?.comment === `accesslease:lease:${target.leaseId}` ? "ours" : "foreign";
    });
    if (owned === "absent") {
      steps.push({ step: "role_absent", ok: true });
      return { steps, sessionsTerminated: 0 };
    }
    if (owned === "foreign") {
      steps.push({ step: "role_not_owned", ok: false, detail: "refusing to touch a role this lease did not create" });
      return { steps, sessionsTerminated: 0 };
    }
    // 1. block new logins immediately (VALID UNTIL only covers authentication, so do it explicitly as well)
    await step("disable_login", () =>
      this.withAdmin(null, async (client) => {
        await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} NOLOGIN`);
        return undefined;
      }),
    );
    // 2. terminate every established session (repeat: a login that raced the ALTER may appear)
    await step("terminate_sessions", () =>
      this.withAdmin(null, async (client) => {
        const deadline = Date.now() + (this.options.terminateWaitMs ?? 5000);
        for (;;) {
          const killed = await client.query<{ pid: number }>(
            "SELECT pid, pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
            [role],
          );
          terminated += killed.rows.length;
          if (killed.rows.length === 0) return `terminated ${terminated}`;
          if (Date.now() > deadline) throw Object.assign(new Error("sessions persist"), { code: "SESSIONS" });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }),
    );
    // A session that could not be terminated must stay visible: stop here, leave the role NOLOGIN but present, so introspection
    // reports it and the lease stays REVOCATION_UNCONFIRMED instead of the role being dropped over a live session.
    if (!steps[steps.length - 1]?.ok) return { steps, sessionsTerminated: terminated };
    // 3. remove the grants in the resource database
    await step("revoke_grants", () =>
      this.withAdmin(target.resource, async (client) => {
        await client.query(`DROP OWNED BY ${client.escapeIdentifier(role)}`);
        return undefined;
      }),
    );
    // 4. drop the role itself
    await step("drop_role", () =>
      this.withAdmin(null, async (client) => {
        await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(role)}`);
        return undefined;
      }),
    );
    return { steps, sessionsTerminated: terminated };
  }

  // ---- denied-use probe ----

  async probeUse(target: GrantTarget & { credentialSecret: string }): Promise<ProbeResult> {
    const role = roleNameFor(target.leaseId);
    let client: pg.Client | null = null;
    try {
      const config = await this.clientConfig(target.resource, role, target.credentialSecret);
      client = new pg.Client(config);
      client.on("error", () => undefined);
      await client.connect();
      await client.query("SELECT 1");
      return "allowed";
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (DENIED_CODES.has(code)) return "denied";
      return "unknown";
    } finally {
      if (client) await client.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {}
}
