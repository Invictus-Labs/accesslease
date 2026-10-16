# AccessLease

**Make temporary task access expire, and prove revocation.**

AccessLease issues one narrowly scoped provider grant with a hard expiry, then independently verifies that revocation happened and keeps a redacted audit receipt. It is a self-hosted service (API, worker, web UI and CLI) with no account, license server, telemetry or paid provider required.

> **Status: pre-release, under development.** Nothing here is a release or a security guarantee. The human fresh-operator drill (acceptance criterion AC-11) has **not** been run: it is recorded as `PENDING_HUMAN_RECEIPT`. Live claims are limited to the real local PostgreSQL role provider; the SYNTHETIC provider never counts as live evidence. Each acceptance criterion's current evidence is in `docs/qa/`. License: MIT (see `LICENSE`); publication clearance of the license and product name is still an owner decision.

## What it does, and what it does not

| It does | It does not |
| --- | --- |
| Rejects wildcard and admin scopes and durations over the policy maximum (default 1 hour, hard maximum 8 hours; only admins change it) | Act as an identity provider or a general secrets vault |
| Binds a human approval to the exact subject, resource, scopes and expiry | Issue root or admin grants, or provide break-glass access |
| Requires a **provider-enforced** expiry and never creates a duplicate grant when an issue is uncertain | Intercept browser sessions |
| Revokes on expiry, task closure or request, then verifies by provider introspection **and** a denied-use probe | Promise instantaneous revocation of sessions a provider has already cached (see the residual-access window in `docs/runbook/diagnosis.md`) |
| Shows `ISSUE_UNKNOWN` and `REVOCATION_UNCONFIRMED` as warnings with the next retry, never as green | Treat the passage of time as proof of revocation |
| Exports a versioned evidence bundle you can verify and read in a clean installation | Require any other product at runtime |

## The lease states

`REQUESTED` → `APPROVED` → `ISSUING` → `ACTIVE` or `ISSUE_UNKNOWN`. Expiry, task closure or revocation → `REVOKING` → `REVOKED_VERIFIED` or `REVOCATION_UNCONFIRMED`.

| State | Meaning | Shown as |
| --- | --- | --- |
| `ISSUE_UNKNOWN` | The provider did not confirm whether the grant exists. It may. | Warning |
| `REVOKING` | Revocation requested, not yet verified. | In progress |
| `REVOKED_VERIFIED` | Independently verified, with a verification time. | The only green |
| `REVOCATION_UNCONFIRMED` | Revocation could not be verified. Access may still exist. | Warning, with next retry |

An expired time alone is never "revoked". Details for every state, and what to do about it: [docs/runbook/diagnosis.md](docs/runbook/diagnosis.md).

## Try it in five minutes (synthetic, no network)

You need Docker with Compose v2. This proves the deterministic core works with **no route to the internet**, using the SYNTHETIC provider and fake data.

```bash
cp .env.example .env && chmod 600 .env
# replace the two placeholders in .env with generated values:
#   openssl rand -base64 24    -> POSTGRES_PASSWORD
#   openssl rand -base64 32    -> ACCESSLEASE_SECRET_KEY
docker compose -p accesslease-offline -f compose.offline.yaml up --build --abort-on-container-exit --exit-code-from smoke
docker compose -p accesslease-offline -f compose.offline.yaml down -v
```

Look for `OFFLINE SMOKE PASSED`. The demo deliberately leaves uncertain leases and exits with code 4 so you can see how unresolved states look; the smoke accepts that. The full procedure for a fresh operator (including the web UI and the real local provider) is [docs/runbook/smoke.md](docs/runbook/smoke.md).

## Run it

```bash
cp .env.example .env && chmod 600 .env      # fill in the placeholders
docker compose up -d --build
docker compose exec accesslease node dist/src/cli.js bootstrap-admin --workspace "My Workspace" --email admin@example.test
```

Open `http://localhost:8791`. The app listens on `127.0.0.1`, which means **this computer only**; it is not a hosted service. Bind semantics, TLS, native installs and the real PostgreSQL provider are in [docs/runbook/install.md](docs/runbook/install.md).

## Command line

`accesslease <command>` (`node dist/src/cli.js <command>`; add `--help` to any command).

| Command | Purpose |
| --- | --- |
| `serve` | API, worker and web UI. Binds `127.0.0.1` by default. |
| `worker` | The background worker alone (`--once` for a single pass). |
| `migrate` | Apply database migrations. |
| `bootstrap-admin` | Create a workspace and its first administrator. No default password. |
| `demo --out DIR` | SYNTHETIC demo with a fixed clock: static report plus evidence bundle, no network. |
| `export`, `import`, `verify-bundle` | Versioned evidence bundles. A bad bundle is rejected with no partial state. |
| `report` | Static HTML report: escaped, no scripts. |
| `doctor` | Checks configuration, database, migrations, provider and unresolved leases, with next steps. |
| `events` | Event envelopes for the optional ecosystem adapter ([docs/ADAPTERS.md](docs/ADAPTERS.md)). |

| Exit code | Meaning |
| --- | --- |
| `0` | OK, and no unresolved uncertain state |
| `1` | Runtime error |
| `2` | Invalid input or refused by policy |
| `3` | Dependency unavailable, or a live connector is disconnected (explicit failure) |
| `4` | `ISSUE_UNKNOWN` or `REVOCATION_UNCONFIRMED` present, or a `report` that lists only some of the workspace's leases: **not success** |

Evidence directories and files are created owner-only.

## Documentation

- Operators: [docs/runbook/](docs/runbook/README.md): install, smoke, upgrade, backup, restore, failure diagnosis.
- Contracts: `docs/contracts/` (HTTP API, state machine, provider, residual access), `schemas/` (JSON Schemas).
- Product requirements and the Definition of Done: `docs/prd/accesslease.md`, `docs/DOD.md`. Quality evidence: `docs/qa/`.
- Ecosystem events: [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Security notes

- Credentials are delivered once through an authenticated, CSRF-protected endpoint, encrypted at rest with a key that lives outside the database, and never appear in URLs, browser storage, logs, events, exports or reports.
- Free text is HTML-escaped everywhere; hostile markup renders as text. Credential-shaped text is replaced with `[redacted]`.
- Outbound endpoints (provider, adapter) are admin-configured and checked against an allowlist, including DNS results and redirects. The deterministic core makes no outbound calls.
- Sessions are revocable HttpOnly cookies with CSRF protection; roles are admin, operator and viewer; a lease from another workspace looks like a missing one (`404`).

## Development

Node.js 22.12 or newer (the toolchain needs 22.22.2+, 24.15+ or 26+), PostgreSQL 17 for the integration tests, Docker for throwaway databases.

```bash
npm ci
npm run typecheck
npm test                  # unit and render tests (the lease view, report, CLI and adapter tests live in tests/unit/surface and tests/web)
npm run build             # server (dist/) and web UI (dist/web)
bash scripts/verify-quality.sh
```

The local gate is `scripts/verify-quality.sh`. There are no GitHub Actions workflows. Work on `codex/` branches and open a pull request.

## Known limitations

- The free-text reason you type when you revoke a lease or close a task is stored with the lease but is **not shown** anywhere: not in the API, the audit trail, the evidence bundle or the report. The audit trail shows the structured reason (`operator_revoked`, `task_closed`, `expired`) instead. Put what matters in your own ticket.
- A restored database cannot undo remote effects; reconcile with the provider before enabling the worker ([docs/runbook/backup-restore.md](docs/runbook/backup-restore.md)).
- A session that is already open when a PostgreSQL role expires survives until AccessLease revokes it ([docs/runbook/diagnosis.md](docs/runbook/diagnosis.md), residual-access window).

## Not shipped (yet)

Hosted operation, providers other than the local PostgreSQL role provider and the SYNTHETIC simulator, single sign-on, invitations, break-glass access, a published release, and the human fresh-operator receipt. Validation that operators have this problem is still open: the PRD records it as a product hypothesis, not demand.
