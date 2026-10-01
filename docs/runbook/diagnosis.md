# Failure diagnosis

Start here when something looks wrong. Everything points back to three questions: *is the service healthy*, *what does each lease's state really mean*, and *can the provider be reached*.

## 1. Start with `doctor` and the exit code

```bash
docker compose exec accesslease node dist/src/cli.js doctor        # native: node dist/src/cli.js doctor
echo "exit code: $?"
```

`doctor` checks configuration, the database, migrations, the provider connection and whether unresolved leases exist, and prints a **next step** for each problem.

| Exit code | Meaning | What to do |
| --- | --- | --- |
| `0` | Command succeeded and **no unresolved uncertain state** is present. | Nothing. |
| `1` | Runtime error (for example a failed migration, or a bug). The message is printed. | Read the message; check logs; see section 2. |
| `2` | Invalid input or refused by policy (bad flag, bad file, rejected bundle, scope or TTL rejected, adapter disabled). Nothing changed. | Fix the input; the message says what. |
| `3` | A dependency is unavailable or a live connector is disconnected (database down, provider cluster unreachable). The operation **failed explicitly**; nothing was assumed. | Restore the dependency, run again. |
| `4` | The command worked, but an **unresolved uncertain state** (`ISSUE_UNKNOWN` or `REVOCATION_UNCONFIRMED`) is present. **Do not read this as success.** | Section 3. |

HTTP equivalents: `400` malformed input, `401` not signed in, `403` forbidden role or CSRF, `404` not found **or not yours** (a lease from another workspace looks identical to a missing one), `409` conflict (stale plan, already retrieved, wrong state), `413` too large, `422` schema or policy rejection, `429` rate limited, `503` dependency unavailable or not ready. Error bodies are `{"error":{"code","message","request_id"}}`; the `request_id` is also in the server log line.

## 2. The service is not healthy

| Symptom | Likely cause | Check and fix |
| --- | --- | --- |
| `curl .../api/v1/health/live` fails | The process is not running or the port is not published. | `docker compose ps`, `docker compose logs accesslease`. Compose publishes only `127.0.0.1:8791`; use `localhost` from the same computer. |
| `/health/ready` returns `503 not_ready` | Database unreachable, or a migration is missing, failed or modified. | `doctor` names it. A **modified** migration or one unknown to this build stops startup on purpose: restore the right build or the right database, never edit an applied migration. |
| `configuration problem: missing required configuration: ...` (exit 2) | A required variable is unset or still a placeholder. | Copy `.env.example` to `.env`, fill it in; for native installs export the variables. |
| `ACCESSLEASE_PROVIDER_ADMIN_URL must point to a separate PostgreSQL cluster` | The provider URL equals the metadata database. | Use a different, disposable cluster ([install.md](install.md) section 4). |
| Login fails with 429 | Rate limit on sign-in attempts. | Wait for the `retry-after` period. |
| Login works but actions fail with `403 csrf_invalid` | Cookie or CSRF token lost (private window closed, proxy stripped headers). | Reload and sign in again; a reverse proxy must pass `x-csrf-token` and cookies. |
| Cookies not kept behind a proxy | `ACCESSLEASE_PUBLIC_URL` says `https://` so cookies are `Secure`, but you browse over plain http. | Browse the https address, or use `http://localhost:8791` for local demos. |
| Worker not doing anything | `serve --no-worker` and no separate `worker`, or the worker crashed. | Start `worker`; `GET /api/v1/jobs` (operator) lists queued, running and dead jobs with `last_error` and `next_attempt_at`. |

## 3. What every lease state means, and what to do

States are exactly these eight. There is deliberately no "expired", "failed" or "cancelled" state.

| State (UI label) | What it means | What you do |
| --- | --- | --- |
| **REQUESTED** | Waiting for human approval. **No access exists.** | Review the exact subject, resource, scopes and expiry, then approve, or let it lapse. |
| **APPROVED** | Approved and bound to that exact plan; waiting for the worker. | Nothing. If it stays here, the worker is not running (section 2). An approval has its own expiry (default 15 minutes): past it, issuance is refused. |
| **ISSUING** | The worker is creating the provider grant. | Nothing, briefly. |
| **ACTIVE** | The grant exists with a provider-enforced expiry. | Nothing. It is revoked at expiry, on task closure or on explicit revoke. |
| **ISSUE_UNKNOWN** (warning) | The provider did not confirm whether the grant was created (timeout, dropped connection, outage). **Access may exist.** | Section 3.1. |
| **REVOKING** (notice) | Revocation was requested and is being verified. **This is not revoked yet.** | Nothing, briefly. If it lingers, see `GET /api/v1/jobs`. |
| **REVOKED_VERIFIED** (green, with a verification time) | Independent verification passed: the provider shows no grant (or no login and zero sessions) **and** a real connection attempt with the issued credential was denied. | Nothing. A record that says verified but has no verification time is shown as an **inconsistency**, not green. |
| **REVOCATION_UNCONFIRMED** (warning) | Revocation could not be verified (outage, a surviving session, stale or unknown introspection, a probe that was not clearly denied). **Access may still exist.** | Section 3.2. |

Expiry alone never produces `REVOKED_VERIFIED`: elapsed time moves a lease into `REVOKING` with reason `expired`, and only verification ends it. The lease page shows the reason (`expired`, `task_closed`, `operator_revoked`, or a refusal reason) so "revoked a live grant" and "no grant ever existed" can be told apart; both end verified only after the provider independently shows no grant.

### 3.1 ISSUE_UNKNOWN

1. **Do not create or delete anything by hand.** The system reconciles by looking up the grant by its **deterministic reference** (for the PostgreSQL provider: `al_` plus the first 24 hex characters of the SHA-256 of the lease id). A retry identifies the same grant; it never creates a second one. Reconciliation retries without an attempt ceiling.
2. Check why the provider is unreachable: `doctor` (exit 3 means disconnected), then the provider's own logs.
3. See what exists, read-only, on the provider cluster:
   ```sql
   SELECT rolname, rolcanlogin, rolvaliduntil FROM pg_roles WHERE rolname = 'al_<first 24 hex of the lease id hash>';
   SELECT usename, state, backend_start FROM pg_stat_activity WHERE usename LIKE 'al\_%';
   ```
4. Outcomes: the grant exists, so the lease is adopted as `ACTIVE`; the grant is absent, so issuance is retried by the same reference; the lease expires first, so it is revoked and any possible orphan is removed.
5. If you cannot wait: revoke the lease (Revoke now). It moves to `REVOKING` and ends verified only after the provider shows nothing exists.

### 3.2 REVOCATION_UNCONFIRMED

The lease shows `next_retry_at`; retries use exponential backoff capped at five minutes by default and have **no attempt ceiling**. They never become "dead" and never become success without verification.

1. Read the **attempts** table on the lease: every failed attempt is kept (append-only) with its result (`unverified` or `provider_error`) and verification reference.
2. Restore what failed: provider reachable (`doctor`), session still open, or login still enabled.
3. "Retry revocation now" on the lease page makes the next retry immediate.
4. For the PostgreSQL provider, emergency manual cleanup (only if retries cannot succeed): terminate the role's sessions, disable login, drop the role, in that order:
   ```sql
   ALTER ROLE "al_..." NOLOGIN;
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'al_...';
   DROP OWNED BY "al_..."; DROP ROLE "al_...";
   ```
   Then click "Retry revocation now": the system verifies independently. **Never** mark a lease verified yourself; there is no way to, by design.
5. If the provider is gone for good, the lease stays `REVOCATION_UNCONFIRMED`. That is the honest state. Record your own out-of-band resolution in your ticketing system.

## 4. The residual-access window (real PostgreSQL provider)

This is the most important limit to understand before a live pilot.

- **At expiry.** The role is created with `VALID UNTIL '<expires_at>'`. PostgreSQL checks that time **only when someone authenticates**, so from `expires_at` onwards **new logins are refused**.
- **But open sessions survive.** A session that connected before `expires_at` stays connected until it is terminated. `VALID UNTIL` does not close it. AccessLease closes it during revocation: it disables login, terminates the role's sessions, removes the grants and the role, then verifies by introspection and by a denied-use probe.
- **The window.** The longest time a pre-existing session can outlive `expires_at` is the time until revocation completes. The worker moves an overdue lease into `REVOKING` within one poll interval (default 5 seconds, `ACCESSLEASE_WORKER_POLL_MS`); the target is to **request** revocation within 30 seconds of expiry under healthy conditions, and each report shows the measured worst delay (*"Longest delay between expiry and the first revocation request"*). If the provider or the worker is down, the window grows until recovery. Early local revocation (before `expires_at`) shortens it for task closure.
- **Privileges the target already grants to everyone** (`PUBLIC`) are outside AccessLease's control. Keep the throwaway cluster's `PUBLIC` privileges minimal.
- **Cached sessions in other systems** (connection pools, application-level tokens) are outside what AccessLease can see. It does not promise instantaneous revocation across cached sessions.

The backend contract documents and tests the derived maximum for the shipped provider in `docs/contracts/` (residual-access). Read it, and decide whether that window is acceptable **before** a live pilot; that decision is the operator's.

## 5. Evidence, bundles and reports

| Symptom | Cause | Fix |
| --- | --- | --- |
| `verify-bundle` / `import` exits 2 with `bundle REJECTED (code)` | The bundle is truncated, tampered, an unsupported version, too large (default 25 MB; `--allow-large` up to 250 MB), too many files (over 1,000), has unsafe paths or broken references. | Nothing was imported or accepted. Get a good copy; the code (`bundle_truncated`, `bundle_hash_mismatch`, `bundle_unsupported_version`, ...) says which check failed. |
| `report` exits 4 | Unresolved leases exist (shown in an orange box), **or** the report is incomplete: it lists only the newest 1,000 leases of a larger workspace. An incomplete report shows "Incomplete report: showing N of M leases" in a red box and whole-workspace counts, and never reads as success because a lease that is not listed may be unresolved. | Section 3. For an incomplete report, list the rest through the UI or the API (`GET /api/v1/leases?state=...`). |
| `report --from-data` exits 2 | The saved report-data file is not valid JSON or not the expected shape. | Re-export it; do not edit it by hand. |
| A report shows text like `&lt;script&gt;` | A lease field contained HTML. | Working as intended: hostile text renders as text. |
| `[redacted]` appears in a report | A free-text field looked like a credential. | Working as intended: credential-shaped text is never printed. |

## 6. Known limitations

- **The revoke or close reason text is not visible.** The free-text reason typed in the UI (or sent as `reason`) is stored with the lease, but the API, the audit trail, evidence bundles and reports do not show it. They show the structured reason only: `operator_revoked`, `task_closed`, `expired` and the refusal reasons. Record your own reasoning in your ticketing system.
- **`bootstrap-admin` for an existing email is refused** (`User is already a member of this workspace`, exit code 2). Nothing changes and no password is printed.
- **The demo bundle hash is stable per build and per fixed inputs, not across builds.**

## 7. Collecting information for a bug report

Run `doctor --json`, `report --format json --out report.json` and note the lease ids and `request_id` values from error messages. Do **not** include `.env`, the secret key, issued credentials, dumps or bundles unless you have checked them: bundles are redacted, dumps are not.
