# AccessLease HTTP API contract (v1) - FROZEN at M0

Owner: `accesslease-backend`. Consumers: CLI/UI/adapters (surface), QA. Changes after M0 are announced by message.
Machine-readable schemas: `schemas/*.json` (generated from `src/domain/schemas.ts`; a unit test fails on drift).
Types: `src/domain/types.ts`. Service functions behind the routes: `src/services/contract.ts`.
State machine: `docs/contracts/state-machine.md`. Providers: `docs/contracts/provider.md`.
Residual-access window: `docs/contracts/residual-access.md`.

All routes live under `/api/v1`. Request and response bodies are JSON (`application/json`), timestamps are UTC ISO-8601
(`2026-01-01T00:00:00.000Z`), IDs are UUIDs, JSON members are `snake_case`. The server never returns HTML; every response
carries `x-content-type-options: nosniff` and a restrictive `content-security-policy`, so hostile text in any field is data.

## 1. States (exact; no others)

`REQUESTED -> APPROVED -> ISSUING -> ACTIVE | ISSUE_UNKNOWN`; expiry, task closure or operator revocation
`-> REVOKING -> REVOKED_VERIFIED | REVOCATION_UNCONFIRMED`. **Wire values are lowercase** (coordinator decision, matching the PRD example
`state:"requested"`): `requested, approved, issuing, active, issue_unknown, revoking, revoked_verified, revocation_unconfirmed`. This applies to
every API response, the evidence bundle, report data, `by_state` keys and the audit `from`/`to` metadata; the `GET /leases?state=` filter takes the
lowercase value (UPPER_SNAKE is tolerated). The database enum and the in-process `LeaseState` type stay UPPER_SNAKE; `toWireState` converts at the boundary.
`revocation_status` is derived: `none | pending | verified | unconfirmed`; `verified` appears only with `REVOKED_VERIFIED`.
`warning` is non-null for `ISSUE_UNKNOWN`, `REVOKING`, `REVOCATION_UNCONFIRMED`: render it, never as green/success.
`next_retry_at` is set while `REVOCATION_UNCONFIRMED` (and while `ISSUE_UNKNOWN` is being reconciled).
Every lease carries `provider: {kind, label, live}`; `label` is `SYNTHETIC` for the simulator and `LIVE_LOCAL_POSTGRES` for the
real local PostgreSQL provider. A SYNTHETIC lease is never live evidence.

## 2. Authentication, sessions, CSRF, roles

- No default password. The first admin is created with the CLI (`bootstrap-admin`, service `bootstrapAdmin`). Further users are
  added by an admin with `POST /members`.
- `POST /auth/login` sets `accesslease_session` (`HttpOnly; SameSite=Strict; Path=/`; `Secure` unless the public URL is plain
  http) and returns a CSRF token. Every non-GET request must send `x-csrf-token: <token>`; a missing/invalid token is `403 csrf_invalid`.
  The CSRF token is a MAC of the session token and is also returned by `GET /auth/session`. Sessions are revocable
  (`POST /auth/logout`, expiry, membership removal).
- Roles per workspace: `viewer` (redacted reads), `operator` (leases, approvals, revocation, credential retrieval, evidence export,
  jobs), `admin` (policy, members, evidence import, everything an operator can do). Role is checked on every query, job and download.
- A foreign or non-existent object id returns `404 not_found` with an identical body (no existence leak) and never changes state.
  A malformed id is also `404`.

| Method and path | Role | Notes |
| --- | --- | --- |
| `GET /health/live` | none | `{status:"ok"}` |
| `GET /health/ready` | none | `{status:"ready"}` or `503 not_ready` when the database is down or any migration is missing/failed/modified |
| `POST /auth/login` | none | `{email,password,workspace_id?}` -> `{user,csrf_token}`; rate limited (429) |
| `GET /auth/session` | any | `{user,csrf_token}` |
| `POST /auth/logout` | any | `{ok:true}` |
| `GET /members` | admin | list members |
| `POST /members` | admin | `{email,password,role}` -> 201 (password >= 12 chars) |
| `GET /policy` | viewer | policy incl. `policy_hash` |
| `PUT /policy` | admin | partial `PolicyUpdate` (+`expected_version`); only admins change TTL/scope policy |
| `GET /provider` | operator | provider label, capabilities, `connected` (explicit `false` + `code` when disconnected) |
| `POST /leases` | operator | request a lease |
| `GET /leases` | viewer | cursor pagination |
| `GET /leases/{id}` | viewer | `LeaseDetail` |
| `POST /leases/{id}/approve` | operator | bind approval to `plan_hash` |
| `POST /leases/{id}/revoke` | operator | `{reason}` |
| `POST /leases/{id}/close` | operator | task closure `{reason?}` |
| `POST /leases/{id}/credential` | operator | one-time credential retrieval |
| `GET /leases/{id}/evidence` | viewer | redacted evidence document for the lease |
| `GET /evidence/export` | operator | versioned bundle download (`?lease_ids=a,b` optional) |
| `POST /evidence/verify` | operator | verify a bundle without importing: `BundleVerification` |
| `POST /evidence/import` | admin | transactional import into this installation |
| `GET /imports` | viewer | imported bundles |
| `GET /imports/{import_id}/leases/{lease_id}` | viewer | imported lease evidence, hash re-verified on read |
| `GET /jobs` | operator | queued/running/dead jobs with `last_error`, `next_attempt_at` |
| `GET /events?after=&limit=` | viewer | versioned event envelopes, at-least-once pull |
| `GET /report` | viewer | `ReportData` (redacted) |

## 3. Leases

### `POST /leases` -> `201`
Body (strict; unknown members are `422`): `{task_ref, subject_ref, resource_ref, scopes[], expires_at?}`.
`expires_at` is an absolute UTC instant (offsets are rejected); omitted means now + policy default TTL (default 1 h).
Response `201 {id, state:"requested", plan_hash, lease, replayed}`.

Policy (AC-01), evaluated against the workspace policy at request time and again at approval and issuance:
- TTL = `expires_at - now` must satisfy `min_ttl_seconds <= TTL <= max_ttl_seconds` (defaults 60 s / 8 h; default TTL 1 h).
  Over max: `422 ttl_exceeds_max`; below min: `422 ttl_below_min`; in the past: `422 expires_in_past`.
- Scopes are exact grants; wildcard and admin-class scopes are refused before any provider is contacted:
  `422 scope_wildcard` (`*`, `%`, `?`, `all`, `any`, `full`, ...), `422 scope_forbidden` (admin, root, superuser, owner, ddl,
  createrole/createdb, grant, replication, bypassrls, drop, truncate, delete ...; deny-prefixes from policy; not on the allow
  list), `422 invalid_scope` (does not match the provider grammar). `postgres-role` grammar:
  `pg:<schema>.<table>:<select|insert|update>` (no `ALL`, no `*`). A resource that fails the provider's check is `422 invalid_scope`.
- Free-text refs (`task_ref`, `subject_ref`, `resource_ref`, scopes) are redacted at intake: token-shaped values and
  `password=...` style assignments are replaced with `[REDACTED]` before storage, so they can never reach logs, audit, exports or
  reports. The stored (redacted) values are what `plan_hash` binds.
- Admin-only policy values: `default_ttl_seconds`, `max_ttl_seconds` (<= 24 h: a documented deployment safety cap above the PRD default of 8 h; an admin can change default and max anywhere below it),
  `min_ttl_seconds`, `approval_ttl_seconds`, `retention_days`, `scope_allow_prefixes`, `scope_deny_prefixes`.
  An operator calling `PUT /policy` gets `403`.

`plan_hash` = SHA-256 (lowercase hex) of the canonical JSON of
`{task_ref, subject_ref, resource_ref, scopes (sorted ascending, de-duplicated), expires_at (UTC ISO, ms precision), policy_hash}`.
Canonical JSON: object keys sorted by code unit order, no whitespace, `undefined` omitted, dates as UTC ISO strings
(`src/domain/canonical.ts`). `policy_hash` is the SHA-256 of the canonical JSON of the policy rules.

### `POST /leases/{id}/approve {plan_hash, expected_version?}` -> `202`
Approval binds exact subject, resource, scopes, expiry and policy (AC-02). Rules, all with no state change on failure:
- `plan_hash` differs from the lease's: `409 plan_hash_mismatch`.
- Lease `expires_at` is no longer in the future by at least `min_ttl_seconds`, or the policy changed since the request
  (`policy_hash` differs) and the request no longer satisfies it: `409 stale_plan` (policy tightened -> `422` policy code).
- Lease not `REQUESTED`: `409 invalid_transition` (an exact replay with the same `Idempotency-Key` returns the stored receipt).
- A provider that does not report native TTL (AC-03): `422 provider_no_native_ttl` (also at `POST /leases`); a live provider that is disconnected: `503 provider_unavailable`. Nothing changes.
Success: lease `APPROVED`, an `approvals` row with its own expiry (`approval_ttl_seconds`, default 15 min) and an `issue` job in the
transactional outbox. Issuance is asynchronous (worker). At issuance the worker re-derives the plan hash from the stored lease
and refuses (`close_reason: plan_mismatch`) when it differs from the approval, or when the approval or the lease has expired
(`approval_expired`): an expired or changed approval cannot issue access.

### `POST /leases/{id}/revoke {reason}` and `POST /leases/{id}/close {reason?}` -> `202`
Both enter `REVOKING` (`close_reason` `operator_revoked` / `task_closed`) and queue a `revoke` job. Idempotent: a lease already
`REVOKING`, `REVOCATION_UNCONFIRMED` or `REVOKED_VERIFIED` returns its current state (on `REVOCATION_UNCONFIRMED` it also makes
the next retry immediate). A lease that never issued is closed through the same path and ends `REVOKED_VERIFIED` only after the
provider independently shows no grant exists. The worker also moves expired leases into `REVOKING` (`expired`) within one poll
interval (default 5 s) of `expires_at` (AC-04 target: request within 30 s).

### `GET /leases/{id}` -> `200 LeaseDetail`
`LeaseView` (+ `provider_grant`, `attempts[]` (append-only revocation attempts with `result`, `verification_ref`, `next_retry_at`),
`audit[]`). `last_verified_at` is the last independently verified check. The server never returns a credential here.

### `GET /leases?state=&cursor=&limit=` -> `200 {items, next_cursor}`
Newest first. `limit` default 50, **capped at 100** (a larger value is clamped; non-numeric or < 1 is `422`). `next_cursor` is opaque
and `null` at the end. Workspace-scoped.

### `POST /leases/{id}/credential` -> `200 CredentialDelivery`
One-time retrieval. Authenticated, CSRF-protected, role operator+, workspace-scoped, `cache-control: no-store`. Allowed only while
`ACTIVE`; the secret is decrypted for this response, then purged: a second call is `409 credential_already_retrieved`; in any other
state `409 credential_unavailable`. The secret is never in a URL, query string, log, audit row, event, export, report, list or detail
response.

## 4. Errors

`{error:{code, message, request_id}}`. `request_id` is a UUID, also in logs. Codes and statuses are the frozen `ERROR_CODES` table
in `src/domain/types.ts`. Summary: `400` malformed JSON/cookie; `401` unauthenticated; `403` forbidden role or CSRF; `404` inaccessible
object; `409` version/idempotency/transition/approval conflicts; `413` oversize payload (body limit 64 KiB; 25 MB metadata for
import); `422` schema, policy or bundle rejection; `429` rate limit (`retry-after`); `503` dependency unavailable / not ready.
Raw errors (SQL, paths, secrets) are never echoed.

## 5. Idempotency

Mutating lease routes (`POST /leases`, approve, revoke, close) accept `Idempotency-Key` (evidence import is naturally idempotent on
`bundle_hash`; adding the same member twice is a `409`)
(8-128 chars `[A-Za-z0-9_.:-]`). Scope is workspace + actor + route (method + path template + object id). Same key and
same canonical body returns the stored receipt (`idempotent-replayed: true`, same status); same key with a different body is
`409 idempotency_conflict`. Keys are retained 7 days (purged by the worker after 8). Version-sensitive operations also accept
`expected_version` (lease `version`; mismatch `409 version_conflict`) or require `plan_hash`.

## 6. Evidence bundle (AC-10)

`GET /evidence/export` returns a single JSON document (`application/json`, `content-disposition: attachment`), schema
`schemas/evidence-bundle.json`:
`{schema_version:1, kind:"accesslease.evidence-bundle", exported_at, generator, source:{workspace_id, workspace_name, provider_labels},
manifest:{files:[{path, sha256, bytes}], file_count, total_bytes, manifest_hash}, files:{<path>: <json doc>}, bundle_hash}`.
- `files` holds `policy.json`, `summary.json` and `leases/<lease_id>.json` (lease, approval, provider grant, revocation attempts, audit
  events, events; redacted: no credentials, no ciphertext, no secrets).
- Each file's `sha256` is the SHA-256 of its canonical JSON; `manifest_hash` hashes the canonical `manifest.files` array;
  `bundle_hash` hashes the canonical JSON of the whole bundle without `bundle_hash`.
- Verification and import (`verifyBundle`, `POST /evidence/verify`, `POST /evidence/import`, CLI `verify-bundle`/`import`) run in
  this order and stop at the first failure: size cap (25 MB metadata default; explicit override to 250 MB) -> JSON parse
  (`bundle_truncated`/`bundle_malformed`) -> `kind`/`schema_version` (`bundle_unsupported_version` for any version other than 1)
  -> schema -> path safety (`bundle_unsafe_path`: absolute, `..`, backslash, drive letters, symlink-like names, odd characters)
  and file count <= 1000 (`bundle_too_many_files`) -> every file hash and the manifest (`bundle_hash_mismatch`,
  `bundle_manifest_mismatch`) -> internal references (`bundle_reference_broken`: ids inside a lease file must match its path and the
  bundle workspace). Import then runs in **one transaction**: any failure leaves no imported rows. Importing the same
  `bundle_hash` again returns the existing receipt (`already_imported: true`).
- Imported leases are read-only evidence (tables `evidence_imports`, `imported_leases`); they are never re-activated and the worker
  never acts on them. Reads re-verify the stored document hash. A restored backup of the live database is separate (AC-13) and keeps
  all references because IDs and foreign keys are database-internal.
- Bundles work offline; nothing in export/import/verify performs network I/O.

## 7. Events (pull)

`GET /events?after=<cursor>&limit=` -> `{items: EventEnvelope[], next_cursor}`; oldest first; cursor is the last delivered sequence
(initially `0`). Envelope `{schema_version:1, event_id, source:"accesslease", resource_id (lease id), event_type, occurred_at,
revision (lease version), evidence_ref (e.g. "lease:<id>@<revision>"), correlation_id?}`.
`event_type` in `lease.requested | lease.approved | lease.issuing | lease.active | lease.issue_unknown | lease.revoking |
lease.revoked_verified | lease.revocation_unconfirmed`. Rows are written in the same transaction as the state change
(transactional outbox). Delivery is at least once; consumers dedupe `event_id`, reject unsupported `schema_version` major,
keep `revision` ordering and never infer the current state from an old event. No credentials appear in events.

## 8. Jobs and the worker (operations)

Jobs `issue`, `reconcile`, `revoke` live in the `jobs` table: bounded claims (`FOR UPDATE SKIP LOCKED`, at most `maxJobsPerPass` = 25 per pass,
`maxConcurrentJobs` = 4 in flight), a lease per claim
(`jobLeaseSeconds`), fenced completion (a stale worker cannot commit), per-lease serialization, deduplication keys. A worker
restart reclaims jobs whose lease expired; the provider outcome of an interrupted `issue` is never discarded: the lease stays
`ISSUING`/`ISSUE_UNKNOWN` and reconciliation looks the grant up by its deterministic provider reference. Revocation and
reconciliation retry without an attempt ceiling (exponential backoff capped at `retryCapSeconds`); they never become "dead" and
never become success without verification. `GET /jobs` exposes `queued | running | done | dead` with `last_error` and `next_attempt_at`.

## 8b. Retention, backup and restore

- Redacted evidence is retained `retention_days` (policy, default 90, admin-configurable 1-3650) after verified revocation. The worker purges
  `REVOKED_VERIFIED` leases past the window (with their audit events, attempts, outbox events, jobs, approvals, grants and secrets), workspace-level
  audit rows and restored evidence imports at least hourly, so primary deletion completes well within 24 hours. Unresolved (`ISSUE_UNKNOWN`,
  `REVOCATION_UNCONFIRMED`), active and pending leases are never purged. The append-only triggers allow `DELETE` only inside this transaction.
  Rotated backups expire on the operator's schedule (documented default: 30 days). The production operator must approve these defaults
  before customer data ingestion (PRD section 6).
- A restored backup (a database dump or physical copy) keeps every reference: IDs and composite workspace foreign keys are database-internal;
  the outbox cursor and pending jobs continue. After a restore, stop side-effect workers, run `doctor`, let one worker pass reconcile
  (an `ISSUING` lease is reconciled by provider lookup, `ISSUE_UNKNOWN` and `REVOCATION_UNCONFIRMED` continue their retries), then enable writes.
  A restored database cannot undo effects at the provider; the live provider's own state is the truth the worker re-reads.
- `ACCESSLEASE_SECRET_KEY` must be the key of the restored data; with a different key encrypted credentials cannot be decrypted (the lease then
  cannot deliver a credential, but revocation never needs the stored credential: the probe secret is re-derived from the key and lease id).

## 9. Security, limits, resources

Body limit 64 KiB (bundle import: 25 MB metadata default); strict schemas; NUL characters rejected; secrets are encrypted at
rest with `ACCESSLEASE_SECRET_KEY` (AES-256-GCM, key outside the database); the credential secret is derived from the key and
the lease id so retries reuse it, stored encrypted, purged on retrieval, and the probe copy is purged after verified revocation.
Egress: provider endpoints are admin-configured and must pass `ACCESSLEASE_EGRESS_ALLOWLIST` (redirects and every DNS result).
Logs are JSON lines with request id, route and status only; headers, cookies and bodies are never logged and all fields are
redacted. No telemetry exists.
