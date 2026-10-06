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
  const provider = new PostgresRoleProvider({ adminUrl: "postgres://admin:synthetic@localhost/reporting", allowlist: ["localhost"] });
  const target: GrantTarget = { leaseId: randomUUID(), resource: "al_missing_database" };
  const roleQueries: unknown[][] = [];
  const connect = async (database: string | null) => {
    if (database === target.resource) throw new ProviderRejectedError("database_missing", "the target database does not exist");
    if (options.clusterFailure) throw new ProviderUnavailableError("provider_unavailable", "synthetic outage");
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM pg_roles")) {
        roleQueries.push(values);
        return { rows: options.rolePresent ? [{ "?column?": 1 }] : [] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    };
    return { query, escapeIdentifier: pg.escapeIdentifier, escapeLiteral: pg.escapeLiteral, end: async () => undefined } as unknown as pg.Client;
  };
  (provider as unknown as { connect: typeof connect }).connect = connect;
  return { provider, target, roleQueries };
}

describe("revoke against a resource database that does not exist", () => {
  it("settles with explicit steps when the server says the database is missing and no role exists", async () => {
    const h = harness({ rolePresent: false });
    const result = await h.provider.revoke(h.target);
    expect(result).toEqual({ steps: [{ step: "resource_database_absent", ok: true }, { step: "role_absent", ok: true }], sessionsTerminated: 0 });
    expect(h.roleQueries).toHaveLength(1);
    expect(String(h.roleQueries[0]?.[0])).toMatch(/^al_[0-9a-f]{24}$/);
  });

  it("negative control: a surviving role (database dropped after issuance) has no fence and stays fail-closed", async () => {
    const h = harness({ rolePresent: true });
    await expect(h.provider.revoke(h.target)).rejects.toMatchObject({ code: "database_missing" });
  });

  it("negative control: a cluster outage while checking the role is surfaced, never settled", async () => {
    const h = harness({ rolePresent: false, clusterFailure: true });
    await expect(h.provider.revoke(h.target)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
