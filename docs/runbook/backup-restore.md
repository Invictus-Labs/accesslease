# Backup and restore

## What to back up

| Item | Why | How often | Keep it |
| --- | --- | --- | --- |
| PostgreSQL metadata database | Leases, approvals, provider grant references, revocation attempts, audit events, users, policies, jobs, imported evidence | Before every upgrade and on a schedule that matches how much you can afford to reconcile | Separate from the secret key |
| `ACCESSLEASE_SECRET_KEY` | Decrypts credentials and probe secrets stored in the database | Once, and whenever it changes | **Not** in the same place as database dumps. Without it a restored database cannot decrypt its secrets |
| `.env` / configuration | Provider settings, policy defaults | When it changes | Same rules as any secret file |
| Evidence bundles (`export`) | Portable, versioned, redacted evidence you can read in a clean installation | As needed for audits | They contain no credentials; still treat as confidential records |

The provider cluster is **not** part of the AccessLease backup: it is disposable and holds the live grants.

Defaults to approve before real data: redacted evidence retention 90 days (configurable), primary deletion completing within 24 hours after the retention period ends, and **rotated backups expire within 30 days**. Your backup tooling must delete dumps on that schedule. The operator must approve these defaults before customer data is ingested.

## Back up

```bash
F="accesslease-$(date -u +%Y%m%dT%H%M%SZ).dump"
( umask 077 && docker compose exec -T db pg_dump -U accesslease -Fc accesslease > "$F" )
# check it is a readable archive
docker compose exec -T db pg_restore --list < "$F" >/dev/null && echo "archive readable: $F"
```

The dump file contains encrypted secrets and personal fields: keep it owner-only and off shared storage.

Portable evidence copy, independent of the database format:

```bash
docker compose exec accesslease node dist/src/cli.js export --out /tmp/evidence.json
docker compose cp accesslease:/tmp/evidence.json ./evidence-$(date -u +%Y%m%dT%H%M%SZ).json
docker compose exec accesslease rm /tmp/evidence.json
```

`export` exits 4 when unresolved leases exist: the bundle is written, and the exit code tells you it describes an incomplete outcome.

## Restore

Do this in a **new, isolated environment** first (test), and for a real recovery only after the checks below.

**Warning: do not let a restored copy talk to the real provider until you have reconciled.** A restored database believes its own history. If it contains a lease the provider has already revoked, or lacks a lease the provider is still honouring, a worker with provider access will act on stale beliefs. Start with `--no-worker`, and with the provider variables pointing at nothing, until reconciliation is done.

```bash
# 1. a fresh database and the SAME secret key
docker compose up -d db
docker compose exec -T db sh -c 'dropdb -U accesslease --if-exists accesslease && createdb -U accesslease accesslease'
docker compose exec -T db pg_restore -U accesslease -d accesslease --no-owner < "$F"      # $F: the dump file from the backup step

# 2. start the API only (no worker): read-only inspection
docker compose run --rm --no-deps accesslease migrate        # a restored older schema is brought forward; "schema up to date" if equal
docker compose run -d --service-ports --no-deps accesslease serve --no-worker
docker compose run --rm --no-deps accesslease doctor
mkdir -p restored
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/restored:/out" accesslease report --out /out/restored-report.html
```

A restored backup **preserves references**: IDs and foreign keys are database-internal, so approvals, grants, attempts and audit events still point at the right leases. Failed migrations stop readiness (the service answers `503 not_ready` rather than serving a half-migrated schema).

### Reconcile external outcomes before enabling writes

A restored local database cannot undo remote effects. For every lease that was not terminal when the backup was taken, and for anything that happened after it:

1. **List what the database believes.** Open the restored report or the Leases page filtered to unresolved leases. Note leases in `ISSUING`, `ACTIVE`, `ISSUE_UNKNOWN`, `REVOKING` and `REVOCATION_UNCONFIRMED`.
2. **List what the provider actually has.** For the PostgreSQL role provider, run against the provider cluster:
   ```sql
   SELECT rolname, rolcanlogin, rolvaliduntil FROM pg_roles WHERE rolname LIKE 'al\_%' ORDER BY rolname;
   SELECT usename, application_name, state, backend_start FROM pg_stat_activity WHERE usename LIKE 'al\_%';
   ```
   Grant references are deterministic: `al_` plus the first 24 hex characters of the SHA-256 of the lease id, so every role can be matched to a lease (or shown to belong to none).
3. **Compare.**
   - A role exists for a lease the restored database shows as revoked or does not know at all (it was issued after the backup): the database is wrong about the provider. Revoke it at the provider by hand: terminate its sessions, `ALTER ROLE ... NOLOGIN`, `DROP OWNED BY ... ; DROP ROLE ...`.
   - A lease shows `ACTIVE` but its role is already gone (revoked after the backup): leave it. When the worker starts it sweeps overdue leases first, revocation is idempotent on an already-removed grant, and verification will record the result honestly.
   - A lease is `ISSUE_UNKNOWN`: the worker reconciles it by looking the grant up by its deterministic reference; never create the role by hand.
4. **Only then start the worker**: `docker compose up -d accesslease`, or re-run `serve` without `--no-worker`. Watch `doctor` and the report until every lease you expected to be revoked shows **Revoked (verified)** with a verification time.

Do not mark anything verified by editing the database. Verification is recorded only by the worker's independent checks.

### Restoring evidence into a clean installation

An evidence bundle is read-only evidence, not a way to reactivate leases:

Mount the folder that holds the bundle into a one-off container (a file copied into a running container is owned by root and unreadable to the app user):

```bash
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/evidence:/in:ro" accesslease verify-bundle /in/evidence.json   # hashes, schema, paths
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/evidence:/in:ro" accesslease import /in/evidence.json           # all or nothing
```

A truncated, tampered or unsupported-version bundle is **rejected with no partial state** (exit 2). Importing the same bundle twice is a no-op ("already imported"). Imported leases are never acted on by the worker.

## Test your restore regularly

Schedule a restore test the same way you schedule the backup: restore into an isolated environment, run `doctor`, open the report, run `verify-bundle` on a fresh export. A backup you have never restored is unproven.
