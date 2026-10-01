# Synthetic smoke procedure

A fresh operator can run this start to finish with copy-paste commands. It uses **synthetic data and the SYNTHETIC provider only** (Part E optionally uses a throwaway local PostgreSQL cluster): no paid account, no telemetry, no real credentials. Allow about 30 minutes.

> Verification record (builders, 2026-10-01 UTC, against the merged code). Part A: executed twice, exit 0, `OFFLINE SMOKE PASSED`. Part B: executed twice, demo exit 4, verify 0, tampered and truncated both exit 2. Part C: steps 1 to 5 and 7 and 8 executed twice with the stated results; step 6 executed twice (Revoked (verified) reached, expected text corrected afterwards). Part D: commands executed once earlier (report 0, export 0, verify 0, import 0 then "already imported", tampered import 2); the re-run after the audit Details column was added was **INTERRUPTED** by a Docker VM replacement and is **unverified**. Part E: executed once earlier (doctor ok; psql allowed while Active, denied after Revoked (verified), explicit revoke and natural expiry); the re-run is **INTERRUPTED and unverified**. It has **not yet been run by a person who did not build the product**, so the fresh-operator criterion (AC-11) is **PENDING_HUMAN_RECEIPT**. If you are that person: note the time you start, every point where you had to ask for help or guess, and what you ran to clean up. Nothing in this document marks a criterion as passed.

You need: Docker with Compose v2, `openssl`, `curl`, a browser on the same computer. All URLs use `localhost`.

```bash
# from the repository root
cp .env.example .env && chmod 600 .env
# edit .env: replace POSTGRES_PASSWORD and ACCESSLEASE_SECRET_KEY with generated values (see install.md)
```

## Part A: offline proof (about 5 minutes)

This runs the deterministic core with **no route to the internet** and proves it. Every service sits on an internal-only network; the smoke container first checks that the internet is unreachable, then runs the SYNTHETIC demo, verifies the evidence bundle and checks the report.

```bash
docker compose -p accesslease-offline -f compose.offline.yaml up --build --abort-on-container-exit --exit-code-from smoke
echo "exit code: $?"
docker compose -p accesslease-offline -f compose.offline.yaml down -v
```

Expected: the log contains `ok: outbound network is denied`, `provider: SYNTHETIC (live: false)`, a line `bundle verified: hash ... 3 lease(s), 5 file(s)`, and finally `OFFLINE SMOKE PASSED`. The compose exit code is `0`.

The demo step exits with code **4** on purpose: it leaves one uncertain lease (`REVOCATION_UNCONFIRMED`) to show you what unresolved states look like, and prints `WARNING: ... Exiting with code 4: this is not success.` The smoke accepts 0 or 4 for the demo step and nothing else. A real run that exits 4 means "unresolved states present: do not read this as success".

If it fails, the message starts with `OFFLINE SMOKE FAILED:` and says which step. See [diagnosis.md](diagnosis.md).

## Part B: look at the demo output yourself (about 5 minutes)

```bash
mkdir -p demo-artifacts
docker compose up -d db
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/out" accesslease \
  demo --out /out/demo --database-url "postgres://accesslease@db:5432/accesslease"
echo "exit code: $?"
ls -l demo-artifacts/demo
```

Expected: exit code **4**, and three files: `evidence-bundle.json`, `report-data.json` and `report.html`. The output directory is mode 700 and the files are mode 600. The demo has three leases: two end `Revoked (verified)` (`demo-expiry`, `demo-ambiguous-issue`) and one stays `REVOCATION UNCONFIRMED` (`demo-revocation-outage`). The clock is fixed, so for one build and the same inputs the bundle hash is the same on every run (run the demo twice and compare). It is **not** stable across builds: different builds of the demo legitimately produce different hashes, so do not compare against a hash printed in a document.

Open `demo-artifacts/demo/report.html` in a browser (a static page: no scripts, nothing loaded from the network). Check:

- A banner says **SYNTHETIC** and that the report is not live evidence.
- An orange box says **1 unresolved state: do not read as success** and lists `demo-revocation-outage` with its next retry time. That badge is never green.
- Only the two verified leases have the green **Revoked (verified)** badge, and each shows a "last verified" time.
- The summary states the longest delay between expiry and the first revocation request.
- Every table has headers; empty tables say so ("No revocation attempts recorded.").

You can also re-render the report from the saved data without a database: `docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/in:ro" -v "$PWD/demo-artifacts:/out" accesslease report --from-data /in/demo/report-data.json --out /out/offline-report.html` (exit 4, because one lease is unresolved).

Verify the bundle yourself:

```bash
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/out:ro" accesslease verify-bundle /out/demo/evidence-bundle.json
echo "exit code: $?"      # 0 = verified: "bundle verified: hash ..., 3 lease(s), 5 file(s), schema_version 1"
```

Tamper test: a changed or truncated bundle must be **rejected**, and nothing is accepted.

```bash
cp demo-artifacts/demo/evidence-bundle.json demo-artifacts/tampered.json
printf 'X' | dd of=demo-artifacts/tampered.json bs=1 seek=200 conv=notrunc 2>/dev/null
head -c 500 demo-artifacts/demo/evidence-bundle.json > demo-artifacts/truncated.json
for f in tampered truncated; do
  docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/out:ro" accesslease verify-bundle /out/$f.json
  echo "$f exit code: $?"
done
```

Expected: `tampered` prints `bundle REJECTED (bundle_hash_mismatch): file leases/... does not match its recorded hash. Nothing was imported or accepted.` and `truncated` prints `bundle REJECTED (bundle_truncated): bundle is truncated. Nothing was imported or accepted.` Both exit **2**. (If your single changed byte lands somewhere else, the code may differ, for example a malformed bundle; the exit code is still 2.)

## Part C: the lease lifecycle in the app (about 15 minutes)

```bash
docker compose up -d --build
curl -fsS http://localhost:8791/api/v1/health/ready ; echo       # {"status":"ready"}
docker compose exec accesslease node dist/src/cli.js bootstrap-admin \
  --workspace "Smoke Workspace" --email admin@example.test      # copy the printed password
```

Running `bootstrap-admin` a second time for the same email is refused (`User is already a member of this workspace`, exit code 2). Nothing changes and no password is printed.

The synthetic provider lives inside the server process, so for this part run the API and worker together (`serve`, which is what compose does). Do not split the worker into a second process while using the synthetic provider.

Open `http://localhost:8791` and sign in as `admin@example.test`. The header shows your workspace and role, and a line `Provider: SYNTHETIC, connected (not live evidence)`. In the **Policy** page you can see the default duration (3600 s, 1 hour) and the hard maximum (28800 s, 8 hours).

1. **Request.** Leases, then New lease. Task `SMOKE-1`, subject `contractor-a`, resource `reporting`, scope `synthetic:reporting:read`, duration `3` minutes. Request lease. (The synthetic provider's scope grammar is `synthetic:<resource>:<read|write>`.)
   *Expect:* the lease page, state **Requested**, a plan hash, and the text "Approving binds to exactly: subject ... resource ... scopes ... expiry ...".
2. **Reject bad requests.** New lease with scope `synthetic:*:read`, then another with duration `600`.
   *Expect:* the first is refused with `Rejected by policy: wildcard scopes are not allowed; name one table and one privilege`, the second with `Rejected by policy: TTL exceeds the policy maximum of 28800 seconds`. Nothing is created.
3. **Approve.** On the `SMOKE-1` lease, "Approve this exact request".
   *Expect:* "Approved. Issuance is queued." Within about 10 seconds the state moves to **Issuing** then **Active**. The page refreshes by itself.
4. **Credential, once.** "Retrieve credential (shown once)".
   *Expect:* host, port, database, username and a secret shown in a box with a "shown once" note; "Hide credential" clears it; it clears itself after a minute. Reload the page: the retrieve button is disabled ("already retrieved or not available"). The secret is not in the address bar and not in browser storage.
5. **Wait for expiry** (about 3 minutes after the request). Keep the lease page open.
   *Expect:* the state changes to **Revoking** (a notice says this is not yet verified), then to **Revoked (verified)** only when verification is recorded, a few seconds after the expiry time. "Last verified at" gets a time and "Why revocation began" says `expired`. The attempts table lists the revocation attempt as `verified` with a verification reference such as `introspection:absent+probe:denied`. The audit trail lists each step. Expiry alone never shows green.
6. **Explicit revoke.** Create and approve a second lease (`SMOKE-2`, duration 30 minutes), wait for Active, then Revoke now with a reason.
   *Expect:* Revoking, then Revoked (verified), with `operator_revoked` as "Why revocation began" and `reason=operator_revoked` in the Details column of the audit trail. (The free-text reason you type is stored with the lease but is not shown in the API or this view yet.)
7. **Close task.** Repeat with `SMOKE-3` and use "Close task and revoke access" (reason `task_closed`).
8. **Roles.** Add a viewer (admin only) with the API, then sign in as that viewer in a private browser window:
   ```bash
   JAR=$(mktemp)
   CSRF=$(curl -fsS -c "$JAR" -H 'content-type: application/json' \
     -d '{"email":"admin@example.test","password":"<admin password>"}' \
     http://localhost:8791/api/v1/auth/login | sed -n 's/.*"csrf_token":"\([^"]*\)".*/\1/p')
   curl -fsS -b "$JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
     -d '{"email":"viewer@example.test","password":"a-long-synthetic-password","role":"viewer"}' \
     http://localhost:8791/api/v1/members
   rm -f "$JAR"
   ```
   *Expect:* the `curl` prints the new user (`"role":"viewer"`). The viewer sees read-only pages, no approve, revoke or credential buttons, and no provider line; the API refuses writes with 403.

## Part D: evidence and report from the live installation

```bash
docker compose exec accesslease node dist/src/cli.js report --out /tmp/report.html
echo "exit code: $?"          # 0 if no lease is unresolved, 4 if any is
docker compose exec accesslease node dist/src/cli.js export --out /tmp/bundle.json
docker compose exec accesslease node dist/src/cli.js verify-bundle /tmp/bundle.json
docker compose cp accesslease:/tmp/report.html ./demo-artifacts/live-report.html
docker compose cp accesslease:/tmp/bundle.json ./demo-artifacts/live-bundle.json
```

Expected: `report written to /tmp/report.html (mode 0600)` and exit 0 (or 4 if you left an unresolved lease); `exported N lease(s), M file(s) to /tmp/bundle.json (mode 0600)`; `bundle verified`. `report` and `export` refuse to overwrite an existing file (exit 2, `already exists (use --force to replace it)`), so on a second run use new file names or add `--force`. Open `demo-artifacts/live-report.html`: your leases, verified revocations in green with last-verified times, and the revocation-request delay statistic.

A *clean installation* can read the bundle. Import is all or nothing and works from a mounted folder (a file copied into a running container is unreadable to the app user):

```bash
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/in:ro" accesslease import /in/demo/evidence-bundle.json    # exit 0: "imported 3 lease(s) as read-only evidence"
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/in:ro" accesslease import /in/demo/evidence-bundle.json    # exit 0: "already imported ... (no change)"
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/demo-artifacts:/in:ro" accesslease import /in/tampered.json                  # exit 2: nothing imported
```

Imported leases are read-only evidence; the worker never acts on them.

## Part E: the real local provider (optional, about 10 minutes)

Only the real PostgreSQL role provider can satisfy a live criterion; the synthetic provider never does. Set `PROVIDER_DB_PASSWORD` in `.env` (a generated value) first.

```bash
docker compose down
docker compose -f compose.yaml -f compose.provider.yaml up -d --build
docker compose exec accesslease node dist/src/cli.js doctor
echo "exit code: $?"      # 0; shows "[ok] provider:postgres-role: live provider reachable"
```

(`down` without `-v` keeps the metadata database, so the administrator from Part C still exists. If you removed volumes, run `bootstrap-admin` again.) The UI now shows `Provider: LIVE_LOCAL_POSTGRES, connected`. Create a table in the throwaway cluster, then repeat steps 1 to 5 with resource `reporting` and scope `pg:public.orders:select`:

```bash
docker compose -f compose.yaml -f compose.provider.yaml exec -T provider-db psql -U provider_admin -d reporting -c "create table if not exists orders (id int)"
```

While the lease is **Active**, the retrieved credential works (the username looks like `al_` plus 24 hex characters; the host in the credential is `provider-db`):

```bash
docker compose -f compose.yaml -f compose.provider.yaml exec -e PGPASSWORD='<secret from the UI>' provider-db \
  psql -h provider-db -U <username from the UI> -d reporting -c "select count(*) from orders"
```

Expected while Active: a row count (`0`). Use `-h provider-db`, not `localhost`: connections from inside the container to itself skip password checks, which would hide the expiry. After the lease shows **Revoked (verified)**, the same command must fail with `FATAL:  password authentication failed for user "al_..."` (the role has been dropped). The attempts table shows the verification reference `introspection:absent+probe:denied`, naming both checks (introspection and denied-use probe). Read the residual-access window in [diagnosis.md](diagnosis.md): a session that was already open at expiry can outlive `expires_at` until AccessLease terminates it.

## Cleanup

```bash
docker compose -f compose.yaml -f compose.provider.yaml down -v
docker compose -p accesslease-offline -f compose.offline.yaml down -v
rm -rf demo-artifacts
```

`down -v` deletes the database volumes. The `.env` file holds your secret key: delete it too if this was only a smoke run.

## Record the result

Fill this in as you go (a human drill receipt is recorded with QA's template under `docs/qa/`, not here):

| Item | Result |
| --- | --- |
| Who ran it (role, not a builder?) | |
| Start and end time (UTC) | |
| Part A, offline proof: exit code and last line | |
| Part B, report checks, tamper test (both exit 2) | |
| Part C, steps 1 to 8 | |
| Part D, report, bundle, import | |
| Part E (optional) | |
| Every place you needed help, guessed or got stuck | |
| What you cleaned up | |
