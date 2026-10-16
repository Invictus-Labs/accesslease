# Upgrade

An upgrade changes code and possibly the database schema while leases may be active. The order below keeps the worker from acting on a half-upgraded system and gives you a way back.

**Rule of thumb:** stop anything that causes side effects at the provider, take a backup you have proven you can restore, upgrade, check, then start writing again.

## Before you start

- Read the release notes for schema changes. Migrations are **expand/contract**: new versions first *add* (columns, tables) in a way the previous version tolerates; a later version *removes* what is no longer used. Do not skip versions without reading the notes.
- Know your current state: `docker compose exec accesslease node dist/src/cli.js doctor` and `... report`. Note any lease in `ISSUE_UNKNOWN` or `REVOCATION_UNCONFIRMED`: they need attention whether or not you upgrade, and an upgrade is a bad time to add uncertainty.
- Have your `.env` (especially `ACCESSLEASE_SECRET_KEY`) available. The new version needs the **same key**.

## Procedure

### 1. Stop side-effect workers

The worker issues grants and revokes them at the provider. Stop it before touching the database so no remote operation is interrupted halfway by the upgrade.

```bash
# the compose "accesslease" service runs the API and the worker together: stop it
docker compose stop accesslease
docker compose ps                     # accesslease must not be running
```

If you run the worker as a separate process (`node dist/src/cli.js worker`), stop that too. Use a graceful stop (SIGTERM or Ctrl-C), not `kill -9`. If a worker is killed mid-job anyway, the next start reclaims its jobs without discarding uncertain outcomes: a lease stays `ISSUING` or `ISSUE_UNKNOWN` and is reconciled against the provider, never issued twice. Leases whose `expires_at` passes while the worker is down are **swept first** when it comes back (before any new issuance), so a short maintenance window does not leave overdue grants forgotten. Provider-side expiry (`VALID UNTIL`) keeps blocking new logins meanwhile; an already-open session can outlive it until the worker revokes ([diagnosis.md](diagnosis.md), residual-access window). Keep the window short.

### 2. Back up

Follow [backup-restore.md](backup-restore.md): a database dump **and** your secret key, stored separately. Export evidence too if you want a portable copy:

```bash
docker compose start db         # only the database needs to be up for the backup
( umask 077 && docker compose exec -T db pg_dump -U accesslease -Fc accesslease > accesslease-pre-upgrade.dump )
ls -l accesslease-pre-upgrade.dump
```

(The portable `export` bundle needs a running installation; take it before step 1 if you want one, see the backup guide.)

### 3. Test the restore, in isolation

An untested backup is a hope, not a backup. Restore the dump into a **separate, throwaway** database and look at it. Never test a restore on the live volume, and never start a worker against a restored copy that can reach the real provider (see the warning in [backup-restore.md](backup-restore.md)).

```bash
docker run -d --name al-restore-test -e POSTGRES_PASSWORD=restore-test-only -p 127.0.0.1::5432 postgres:17-alpine
until docker exec al-restore-test pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
cat accesslease-pre-upgrade.dump | docker exec -i al-restore-test sh -c 'createdb -U postgres accesslease && pg_restore -U postgres -d accesslease --no-owner'
docker exec al-restore-test psql -U postgres -d accesslease -c "select count(*) from leases"
docker rm -f al-restore-test
```

### 4. Upgrade

```bash
git pull                       # or check out the release you are installing
docker compose build           # builds the new image
docker compose run --rm --no-deps accesslease migrate   # applies pending migrations, prints what it applied
```

`migrate` applies pending migrations in order, each in its own transaction. A **failed or modified migration stops with an error** and the service stays not ready; it never starts on a half-migrated schema. The database also refuses to start a build that does not know a migration already applied (a downgrade guard).

### 5. Check before enabling writes

```bash
docker compose run --rm --no-deps accesslease doctor    # migrations, database, provider connection, unresolved leases
docker compose up -d accesslease
curl -fsS http://localhost:8791/api/v1/health/ready ; echo
```

Expected: all `doctor` checks `ok` (exit 0). Exit 3 means the provider is disconnected (live operations will fail explicitly); exit 4 means unresolved leases exist; both are visible, neither is silent. Sign in, open a recent lease, and run the smoke steps you care about ([smoke.md](smoke.md) Part C steps 1 to 5 take a few minutes).

## Rollback

Prefer rolling back **forward** when the new version only added schema (expand): start the previous image against the same database; it ignores the additions.

When a schema change is not safe to undo (a contract step that removed or reshaped data), roll back with the **verified snapshot**:

1. Stop the new service: `docker compose stop accesslease`.
2. Restore the pre-upgrade dump into a fresh database ([backup-restore.md](backup-restore.md)).
3. **Reconcile external outcomes before enabling writes.** Everything the new version did at the provider after the snapshot (grants issued, grants revoked) is not undone by restoring the database. Follow the reconciliation checklist in [backup-restore.md](backup-restore.md) before starting the worker.
4. Start the previous image.

Never edit an applied migration file to "fix" it: its checksum is recorded, and a modified migration stops startup by design.
