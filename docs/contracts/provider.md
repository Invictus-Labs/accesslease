# Provider contract - FROZEN at M0

Code: `src/connectors/provider.ts` (interface, errors, registry). Implementations: `src/connectors/synthetic.ts`,
`src/connectors/postgres-role.ts`. Only `postgres-role` can satisfy live criteria; `synthetic` is labelled `SYNTHETIC` in code, API, reports and
evidence and never produces live evidence.

## Interface (summary)

| Member | Meaning |
| --- | --- |
| `capabilities()` | `{kind, label, live, nativeTtl, revocation, introspection, deniedUseProbe, maxResidualAccessSeconds, scopeGrammar, version}`. A provider with `nativeTtl:false` is refused at registration (AC-03). |
| `providerRefFor(leaseId)` | Pure, deterministic. `postgres-role`: `al_` + first 24 hex of SHA-256(lease id). `synthetic`: `syn_` + the same. |
| `validateScope(scope)` / `validateResource(resource)` | Provider grammar. Also enforced inside `issue` (defense in depth). |
| `ping()` | Throws `ProviderUnavailableError` when disconnected/unreachable. Used by `doctor`, `GET /provider` and approval of live leases. |
| `issue(req)` | "Create or align" on the deterministic reference: a retry identifies the same grant (`alreadyExisted:true`). Sets the native expiry (`expiresAt`). |
| `lookup(target)` | Independent introspection: `present/absent/unknown`, `validUntil`, `loginAllowed`, `activeSessions`, granted `scopes`. |
| `revoke(target)` | Idempotent; returns the steps taken. Safe on already-removed grants. |
| `probeUse({target, credentialSecret})` | A real use attempt with the issued credential: `denied`, `allowed` or `unknown`. |

Errors: `ProviderRejectedError` = the provider knows nothing was created (definite). `ProviderUnavailableError` = outcome possibly
unknown (timeout/outage/disconnect). Callers reconcile by `lookup`; there is no blind retry of a remote write.

## `postgres-role` (REAL, local PostgreSQL 17 cluster, separate from the metadata database)

- Target: `ACCESSLEASE_PROVIDER_ADMIN_URL`, a superuser (or CREATEROLE + `pg_signal_backend`) URL for a disposable cluster. Refused at
  startup when it points to the same host:port as the metadata database. It must pass the egress allowlist (DNS resolved and pinned).
- `resource_ref` = database name in the target cluster. Scopes: `pg:<schema>.<table>:<select|insert|update>`; identifiers
  `[a-z_][a-z0-9_]{0,62}`; no `ALL`, no `*`. Grants: `CONNECT` on the database, `USAGE` on the schema, and exactly the listed table privileges. An `insert` scope also grants `USAGE` (and nothing else) on the sequences owned by that table (serial or identity
  primary keys), otherwise `INSERT` fails with `permission denied for sequence`; those sequence grants are removed by `DROP OWNED` at revocation.
  Role attributes: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5 VALID UNTIL '<expires_at>'`.
  The role is never an owner and holds no DDL privileges. Privileges the target already grants to `PUBLIC` are outside AccessLease's control and are
  documented in the residual-access contract.
- Native TTL: `VALID UNTIL` rejects new logins at `expires_at`; it is checked only at authentication, so an already-open session survives expiry
  until AccessLease terminates it. That is the residual-access window (`docs/contracts/residual-access.md`).
- Revocation order (each step idempotent, failures recorded, never skipped silently): `ALTER ROLE ... NOLOGIN` (blocks new logins at once),
  `pg_terminate_backend` for every session of the role (repeated until none remain, bounded), `DROP OWNED BY` (removes the grants in the resource
  database), `DROP ROLE IF EXISTS`.
- If `terminate_sessions` fails (no `pg_signal_backend`, or a session persists past `terminateWaitMs`), revocation stops there: the role is NOT
  dropped, stays `NOLOGIN` and present, introspection reports it, and the lease stays `REVOCATION_UNCONFIRMED`. The worker also refuses
  `REVOKED_VERIFIED` whenever any revocation step reported failure.
- Deadlines: every provider connection sets `query_timeout`/`statement_timeout` (15 s) and TCP keep-alive, and the worker wraps each provider call
  in a hard deadline (`providerCallTimeoutMs` 20 s, `providerRevokeTimeoutMs` 40 s, both below the 120 s job lease) that reports `provider_timeout`:
  a silent provider yields `ISSUE_UNKNOWN` (reconcile by lookup) or `REVOCATION_UNCONFIRMED` (retry) and never stalls other leases.
- Verification after revocation: introspection (`pg_roles`, `pg_stat_activity`: role gone or no-login, zero sessions) AND a denied-use probe
  (a real connection attempt with the issued credential must fail with SQLSTATE 28000/28P01). `allowed`, other errors or unreachable cluster are
  `unknown` and the lease stays `REVOCATION_UNCONFIRMED`.

## `synthetic` (SYNTHETIC, deterministic, in-process)

Same interface, driven by an injectable clock. Fault injection (`faults.next(op, fault)`): `outage`, `timeout`, `ambiguous` (the write
happens but the call fails), `reject`, `partial_revoke` (grant removed but a session survives), `stale_introspection` (lookup keeps
answering `present`), `probe_unknown`. Used by the offline demo, state-machine fault tests and the no-cluster path.
Reports `kind:"synthetic"`, `label:"SYNTHETIC"`, `live:false`.
