import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { ProviderRejectedError, ProviderUnavailableError, type GrantTarget } from "../../../src/connectors/provider.js";

/**
 * Synthetic model of a resource database that the server reports as missing (SQLSTATE 3D000 -> database_missing).
 * Exercises the provider's settle-or-fail-closed rule, not PostgreSQL acceptance (AC-03 covers the live case).
 */
function harness(options: { rolePresent: boolean; clusterFailure?: boolean }) {
  const provider = new PostgresRoleProvider({ adminUrl: "postgres://admin:synthetic@localhost/reporting", allowlist: ["localhost"], terminateWaitMs: 0 });
  const target: GrantTarget = { leaseId: randomUUID(), resource: "al_missing_database" };
  const roleQueries: unknown[][] = [];
  const statements: string[] = [];
  let role = options.rolePresent;
  const connect = async (database: string | null) => {
    if (database === target.resource) throw new ProviderRejectedError("database_missing", "the target database does not exist");
    if (options.clusterFailure) throw new ProviderUnavailableError("provider_unavailable", "synthetic outage");
    const query = async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (sql === "SELECT 1 FROM pg_roles WHERE rolname = $1") {
        roleQueries.push(values);
        return { rows: role ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("shobj_description")) return { rows: role ? [{ comment: `accesslease:lease:${target.leaseId}` }] : [] };
      if (sql.startsWith("ALTER ROLE") && sql.endsWith("NOLOGIN")) return { rows: [] };
      if (sql.includes("pg_terminate_backend")) return { rows: [] };
      if (sql.startsWith("DROP ROLE")) { role = false; return { rows: [] }; }
      throw new Error(`unexpected statement: ${sql}`);
    };
    return { query, escapeIdentifier: pg.escapeIdentifier, escapeLiteral: pg.escapeLiteral, end: async () => undefined } as unknown as pg.Client;
  };
  (provider as unknown as { connect: typeof connect }).connect = connect;
  return { provider, target, roleQueries, statements, get role() { return role; } };
}

describe("revoke against a resource database that does not exist", () => {
  it("settles with explicit steps when the server says the database is missing and no role exists", async () => {
    const h = harness({ rolePresent: false });
    const result = await h.provider.revoke(h.target);
    expect(result).toEqual({ steps: [{ step: "resource_database_absent", ok: true }, { step: "role_absent", ok: true }], sessionsTerminated: 0 });
    expect(h.roleQueries).toHaveLength(1);
    expect(String(h.roleQueries[0]?.[0])).toMatch(/^al_[0-9a-f]{24}$/);
  });

  it("a surviving role (database renamed or dropped after issuance) is still disabled and dropped, but without a fence never settles", async () => {
    const h = harness({ rolePresent: true });
    const result = await h.provider.revoke(h.target);
    // Cluster-wide cleanup ran: logins blocked, sessions terminated, role dropped.
    expect(h.statements.some((s) => s.startsWith("ALTER ROLE") && s.endsWith("NOLOGIN"))).toBe(true);
    expect(h.statements.some((s) => s.startsWith("DROP ROLE"))).toBe(true);
    expect(h.role).toBe(false);
    // The missing fence is a failed step, so the worker can never record this attempt as verified.
    expect(result.steps[0]).toMatchObject({ step: "terminal_fence", ok: false });
    expect(result.steps.find((s) => s.step === "disable_login")).toMatchObject({ ok: true });
    expect(result.steps.every((s) => s.ok)).toBe(false);
  });

  it("negative control: a cluster outage while checking the role is surfaced, never settled", async () => {
    const h = harness({ rolePresent: false, clusterFailure: true });
    await expect(h.provider.revoke(h.target)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
