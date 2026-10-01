import { PostgresRoleProvider } from "../connectors/postgres-role.js";
import { ProviderUnavailableError } from "../connectors/provider.js";
import type { Ctx } from "../context.js";
import { migrationStatus } from "../db/migrate.js";
import { SWEEP_STATES } from "../domain/state-machine.js";
import { REVOCATION_REQUEST_SLA_SECONDS } from "../domain/types.js";
import type { DoctorCheck, DoctorReport } from "./contract.js";
import { unresolvedCount } from "./unresolved.js";

/**
 * Failure diagnosis (AC-11): every check names what is wrong and what to do. Exit code: 1 any failure, 3 a live dependency is
 * disconnected, 4 unresolved states (ISSUE_UNKNOWN / REVOCATION_UNCONFIRMED) are present, otherwise 0.
 */
export async function runDoctor(ctx: Ctx): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => void checks.push(check);

  let dbOk = true;
  try {
    await ctx.db.query("SELECT 1");
    add({ name: "database", status: "ok", message: "metadata database reachable" });
  } catch {
    dbOk = false;
    add({ name: "database", status: "fail", message: "metadata database is unreachable", hint: "check ACCESSLEASE_DATABASE_URL, that PostgreSQL is running and that the network allows the connection" });
  }

  if (dbOk) {
    const status = await migrationStatus(ctx.db);
    add(
      status.ok
        ? { name: "migrations", status: "ok", message: `${status.applied.length} migration(s) applied` }
        : { name: "migrations", status: "fail", message: `not ready: ${status.problem}`, hint: "run `accesslease migrate`; a modified or unknown migration means this build does not match the database (restore a verified backup or use the matching version)" },
    );
  }

  try {
    const probe = ctx.key.decrypt("doctor", ctx.key.encrypt("doctor", "ok"));
    add({ name: "secret-key", status: probe === "ok" ? "ok" : "fail", message: "operator key can encrypt and decrypt secrets", hint: "ACCESSLEASE_SECRET_KEY must stay identical across restarts and restores; losing it makes stored credentials unreadable" });
  } catch {
    add({ name: "secret-key", status: "fail", message: "operator key failed an encryption round trip", hint: "provide ACCESSLEASE_SECRET_KEY (base64 of 32 random bytes)" });
  }

  for (const kind of ctx.providers.kinds()) {
    const provider = ctx.providers.require(kind);
    const caps = provider.capabilities();
    if (!caps.nativeTtl) {
      add({ name: `provider:${kind}`, status: "fail", message: "provider has no native TTL and is refused", hint: "AccessLease requires provider-enforced expiry (AC-03)" });
      continue;
    }
    if (!caps.live) {
      add({ name: `provider:${kind}`, status: "warn", message: "SYNTHETIC provider configured: no real access is granted and nothing here is live evidence", hint: "set ACCESSLEASE_PROVIDER=postgres-role with a disposable cluster for live use" });
      continue;
    }
    try {
      await provider.ping();
      add({ name: `provider:${kind}`, status: "ok", message: `live provider reachable (${provider.capabilities().version})` });
      if (provider instanceof PostgresRoleProvider) {
        const facts = await provider.inspectAdmin();
        add({
          name: "provider:privileges",
          status: facts.superuser || (facts.createRole && facts.canSignal) ? "ok" : "fail",
          message: facts.superuser ? "admin role is a superuser" : `createrole=${facts.createRole} pg_signal_backend=${facts.canSignal}`,
          hint: "the admin URL needs CREATEROLE and pg_signal_backend (or superuser) on the disposable target cluster",
        });
        if (dbOk && facts.systemIdentifier) {
          let local: string | null = null;
          try {
            local = (await ctx.db.query<{ id: string }>("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0]?.id ?? null;
          } catch {
            local = null;
          }
          if (local && local === facts.systemIdentifier) {
            add({ name: "provider:separation", status: "fail", message: "the provider cluster IS the metadata cluster", hint: "ACCESSLEASE_PROVIDER_ADMIN_URL must point to a separate disposable cluster" });
          } else {
            add({ name: "provider:separation", status: "ok", message: "provider cluster is separate from the metadata cluster" });
          }
        }
      }
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        add({ name: `provider:${kind}`, status: "unavailable", message: `live provider disconnected (${error.code})`, hint: "start the target cluster, check ACCESSLEASE_PROVIDER_ADMIN_URL and ACCESSLEASE_EGRESS_ALLOWLIST (host and port must be listed); live operations fail explicitly until it is reachable" });
      } else {
        add({ name: `provider:${kind}`, status: "fail", message: "provider check failed", hint: "inspect the provider configuration" });
      }
    }
  }

  let unresolved = { issueUnknown: 0, revocationUnconfirmed: 0 };
  if (dbOk && checks.find((c) => c.name === "migrations")?.status === "ok") {
    const now = ctx.clock();
    const overdue = await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM leases WHERE state = ANY($1::lease_state[]) AND expires_at < $2",
      [SWEEP_STATES, new Date(now.getTime() - REVOCATION_REQUEST_SLA_SECONDS * 1000)],
    );
    const nOverdue = overdue.rows[0]?.n ?? 0;
    add(
      nOverdue === 0
        ? { name: "overdue-leases", status: "ok", message: "no overdue grants waiting for the sweep" }
        : { name: "overdue-leases", status: "fail", message: `${nOverdue} lease(s) are overdue by more than ${REVOCATION_REQUEST_SLA_SECONDS}s and not yet in revocation`, hint: "the worker is not running: start `accesslease worker`; overdue leases are swept before any new issuance" },
    );
    const failing = await ctx.db.query<{ last_error: string; n: number }>("SELECT last_error, count(*)::int AS n FROM jobs WHERE state = 'queued' AND last_error IS NOT NULL GROUP BY last_error ORDER BY n DESC LIMIT 5");
    add(
      failing.rows.length === 0
        ? { name: "jobs", status: "ok", message: "no job is failing" }
        : { name: "jobs", status: "warn", message: `jobs retrying after errors: ${failing.rows.map((r) => `${r.last_error} x${r.n}`).join(", ")}`, hint: "provider_disconnected/provider_unavailable: restore the provider; lease_expired: a worker died and the job was reclaimed (normal after a restart)" },
    );
    unresolved = await unresolvedCount(ctx);
    const total = unresolved.issueUnknown + unresolved.revocationUnconfirmed;
    add(
      total === 0
        ? { name: "unresolved-states", status: "ok", message: "no ISSUE_UNKNOWN or REVOCATION_UNCONFIRMED lease" }
        : {
            name: "unresolved-states",
            status: "warn",
            message: `${unresolved.issueUnknown} ISSUE_UNKNOWN and ${unresolved.revocationUnconfirmed} REVOCATION_UNCONFIRMED lease(s): do not treat these as success`,
            hint: "run the worker; check `accesslease report` for next_retry_at; REVOCATION_UNCONFIRMED means access may still exist at the provider",
          },
    );
  }

  const failed = checks.some((c) => c.status === "fail");
  const unavailable = checks.some((c) => c.status === "unavailable");
  const hasUnresolved = unresolved.issueUnknown + unresolved.revocationUnconfirmed > 0;
  const exitCode: DoctorReport["exitCode"] = failed ? 1 : unavailable ? 3 : hasUnresolved ? 4 : 0;
  return { ok: exitCode === 0, checks, exitCode };
}
