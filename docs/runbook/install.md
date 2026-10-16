# Install

Two supported ways: Docker Compose (recommended) or a native Node.js install against your own PostgreSQL. Both need no account, license server, telemetry endpoint or paid provider.

**Prerequisites**

| | Docker Compose install | Native install |
| --- | --- | --- |
| Software | Docker with Compose v2 | Node.js 22.12 or newer (22, 24 or 26), PostgreSQL 17 |
| For the real local provider | Nothing extra (`compose.provider.yaml` starts a throwaway cluster) | A **separate** disposable PostgreSQL 17 cluster |
| Tools used below | `openssl`, `curl` | `openssl`, `curl`, `npm` |

## 1. Understand bind addresses first

`127.0.0.1` is the loopback address, also written `localhost`. It means "this computer only". It is not a hosted AccessLease server and not an address belonging to the maintainers. A program that listens on `127.0.0.1` cannot be reached from any other machine.

`0.0.0.0` means "every network interface of this computer". A service listening on it can be reached from other machines that can route to you.

| Where | Setting | Default | Effect |
| --- | --- | --- | --- |
| Native | `ACCESSLEASE_HOST` (or `serve --host`) | `127.0.0.1` | Reachable from this computer only. |
| Container | `ACCESSLEASE_HOST` inside the image | `0.0.0.0` | Required so Docker can publish the port. This is the container's interface, not your computer's. |
| Compose | `ports: "127.0.0.1:8791:8791"` | loopback only | The host exposes the app on this computer only. |

To let other computers reach AccessLease, put a TLS reverse proxy in front of it (it must forward to the app) and set `ACCESSLEASE_PUBLIC_URL` to the `https://` address people use. Do not publish the plain app port to a network. `serve` prints a warning when you bind `0.0.0.0` or `::`.

All example URLs in this runbook use `http://localhost:8791`.

## 2. Docker Compose install

```bash
# from the repository root
cp .env.example .env
chmod 600 .env
```

Replace the two placeholders in `.env` with generated values (the placeholders are deliberately invalid, so the stack refuses to start until you do):

```bash
# macOS/Linux: edit .env, or generate and paste:
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 32   # ACCESSLEASE_SECRET_KEY
```

Keep `ACCESSLEASE_PROVIDER=synthetic` for a first run. Then start it:

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://localhost:8791/api/v1/health/ready ; echo
```

`ready` appears only when the database is reachable and **every shipped migration is applied and unmodified**. A failed or modified migration keeps the service not ready (it answers `503 not_ready`) and stops startup; see [diagnosis.md](diagnosis.md).

### Create the first administrator

There is **no default password** and no open registration. Create the first administrator from the command line. The password is generated and shown once:

```bash
docker compose exec accesslease node dist/src/cli.js bootstrap-admin \
  --workspace "Demo Workspace" --email admin@example.test
```

The command prints the workspace id and `generated password (shown once, copy it now): ...`. Copy it into a password manager now; the terminal scrollback is the only other place it exists. If you would rather not print it:

```bash
# write a generated password to a new owner-only file inside the container, read it once, then delete it
docker compose exec accesslease node dist/src/cli.js bootstrap-admin \
  --workspace "Demo Workspace" --email admin@example.test --password-out /tmp/admin-password.txt
docker compose exec accesslease cat /tmp/admin-password.txt
docker compose exec accesslease rm /tmp/admin-password.txt
```

Or supply your own: `--password-file PATH` (a file only you can read, mode 0600, at least 12 characters) or the `ACCESSLEASE_BOOTSTRAP_PASSWORD` environment variable. Running the command again for the same email is refused ("User is already a member of this workspace", exit code 2): nothing changes and no password is printed.

Open `http://localhost:8791` in a browser on the same computer and sign in. Add further users with the API (`POST /api/v1/members`, admin only; the exact calls are in [smoke.md](smoke.md) Part C step 8 and `docs/contracts/api.md`).

### Roles

| Role | Can |
| --- | --- |
| viewer | Read leases and redacted reports. |
| operator | Everything a viewer can, plus request, approve, revoke, close, retrieve the one-time credential, export evidence. |
| admin | Everything an operator can, plus change policy, manage members, import evidence. |

## 3. Native install

```bash
npm ci
npm run build

export ACCESSLEASE_DATABASE_URL="postgres://accesslease:CHANGE_ME@localhost:5432/accesslease"
export ACCESSLEASE_SECRET_KEY="$(openssl rand -base64 32)"   # keep a copy somewhere safe, outside the database
export ACCESSLEASE_PUBLIC_URL="http://localhost:8791"

node dist/src/cli.js migrate
node dist/src/cli.js bootstrap-admin --workspace "Demo Workspace" --email admin@example.test
node dist/src/cli.js doctor
node dist/src/cli.js serve        # API + worker + web UI on http://localhost:8791
```

`serve` runs the worker too. To run them separately (for example so the API stays up while you restart the worker), start `serve --no-worker` and, elsewhere, `node dist/src/cli.js worker`.

The secret key encrypts issued credentials and probe secrets at rest and lives outside the database. **Losing it makes stored secrets unreadable; leaking it defeats the encryption.** Back it up separately from database backups.

## 4. The real local provider

The `postgres-role` provider issues a short-lived PostgreSQL role (native expiry with `VALID UNTIL`) in a **separate disposable cluster** and revokes it by terminating sessions, dropping the role and verifying. It must never point at the metadata database; startup refuses that.

With Docker Compose, a throwaway cluster is one overlay away:

```bash
# in .env: set PROVIDER_DB_PASSWORD (generated), keep the other values
docker compose -f compose.yaml -f compose.provider.yaml up -d --build
docker compose exec accesslease node dist/src/cli.js doctor
```

`doctor` should report the provider as connected. If the provider cluster is unreachable, live operations **fail explicitly** (exit code 3 on the CLI, `503 provider_unavailable` over HTTP) and nothing is issued or approved against it. Read [diagnosis.md](diagnosis.md) for the residual-access window before using it for anything real.

## 5. Before processing real data

The defaults below are proposals. **An operator must approve them before real or customer data is ingested**; until then use synthetic data only.

| Setting | Default | Where |
| --- | --- | --- |
| Lease duration | default 1 hour, hard maximum 8 hours (only admins can change) | Policy page, `ACCESSLEASE_TTL_*` |
| Redacted evidence retention | 90 days | `ACCESSLEASE_RETENTION_DAYS` |
| Primary deletion after retention | within 24 hours | worker |
| Rotated backups expire | within 30 days | your backup tooling ([backup-restore.md](backup-restore.md)) |

AccessLease is not an identity provider and not a general secrets vault. It does not support root or admin grants, wildcard scopes, break-glass access or browser session interception, and it cannot promise instantaneous revocation of sessions a provider has already cached.

Next: run the [smoke procedure](smoke.md).
