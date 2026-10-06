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

## Terminal issuance barrier (PostgreSQL provider)

Role absence plus a denied login is terminal evidence only after every prior issuance is ordered before revocation, or prevented from committing afterward. A custom provider must supply an equivalent durable provider-side barrier before it can claim verified terminal revocation. An application deadline does not cancel a provider operation; process-local pending sets and discarded late answers do not provide this guarantee.

The PostgreSQL connector requires an explicitly provisioned, administrator-owned `accesslease_control.terminal_fences` table in **each immutable resource database**. Both issue and revoke explicitly use READ COMMITTED (never an inherited Repeatable Read snapshot) and acquire the same transaction-scoped advisory lock for the deterministic lease reference. Issue checks the durable terminal record after acquiring that lock and rechecks expiry before any role mutation. Revoke writes the record while holding the lock and commits it before any cleanup starts, so a cleanup step that fails part-way (including with `ProviderUnavailableError`) can never roll the record back; cleanup then runs and the attempt stays unconfirmed until it succeeds. A delayed issue connection therefore sees the committed terminal record; an issue already holding the lock must settle before revoke can inspect absence. Retries and process restarts use the same provider record. Worker timeouts or failed fence commits remain unconfirmed, even if an independent observation temporarily sees absence and denial. Partial cleanup retains the committed fence and remains unconfirmed until cleanup succeeds.

One narrow exception: when the server definitively reports that the resource database does not exist (SQLSTATE `3D000`), no fence can be written and no issue can commit there, so revoke settles (`resource_database_absent`, `role_absent`) only if the cluster-wide role is also absent; a surviving role (for example after the database was renamed) is still disabled, its sessions terminated and a drop attempted, but the attempt records a failed `terminal_fence` step and stays unconfirmed; once the role is gone a later attempt takes the role-absent branch and settles. Residual risk: the same database is later created and provisioned and stale metadata replays an issue for that lease.

Version and ownership markers are mandatory. Missing objects, unsupported markers, unexpected ownership or reference collisions fail closed; permission errors cannot produce verified revocation. The schema is forbidden in grant scopes. No automatic terminal-record deletion or pruning is permitted: removing records, restoring an older provider database, or moving a lease to a different resource can remove the barrier. Provider database durability/backup policy and any deliberate retirement require an operator decision; metadata restoration alone must retain the provider control records.

Provisioning: see [provider-control.md](../runbook/provider-control.md). Synthetic transaction tests establish application ordering only. PostgreSQL advisory-lock, catalog, commit-loss, permission, restart and session-termination behavior still require the dedicated live provider gate and pilot acceptance.
