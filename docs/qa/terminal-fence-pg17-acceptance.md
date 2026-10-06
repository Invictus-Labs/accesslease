# Prepared terminal-fence PG17 acceptance

> Historical preparation snapshot: NOT_RUN and runtime-unavailable statements below describe preparation time. Later six provider-only PostgreSQL17 cases passed at source 0ec with owned cleanup; subsequent scoped native API/provider/restore, host and supported-minimum product evidence are separate records. Current source 9937 has independently accepted all twelve original mutation controls and server/web noEmit checks. These bounded results do not certify Docker/Compose, complete final release qualification, true crash/wire-loss durability, policy decisions or actual human AC-11. See [provider-control.md](../runbook/provider-control.md) for provider scope and limitations. No release acceptance is asserted.

This opt-in file tests the real PostgreSQL17 connector against freshly named disposable resource databases. It is excluded from ordinary unit-suite discovery. Since the PR review follow-up it also runs as the required gate step `provider-terminal-fence-pg17` (scripts/gate.mjs) against the gate's throwaway pair, with the acknowledgement set by the gate; the harness still refuses any target other than the loopback `al_admin` pair. Existing source/ten-file remediation and public draft stay unchanged. Parent scheduling and explicit disposable-server approval are prerequisites; never point this harness at an existing provider/customer cluster.

After approval and a free test slot, the existing labelled Docker helper can own a new disposable pair, load its random synthetic credentials privately, run only this file, and remove exactly its pair:

```bash
ACCESSLEASE_TERMINAL_FENCE_LIVE_ACK=disposable-pg17 \
  bash scripts/test-db.sh with -- \
  node node_modules/vitest/vitest.mjs run --config vitest.provider-terminal-fence.config.ts
```

Use an installed supported Node runtime (>=22.12) and existing dependencies. The helper prints no credentials in this wrapped mode; do not use its `env`/`up` output as an artifact or paste DSNs. The test refuses missing acknowledgement, nonloopback endpoints, a non-`al_admin` administrator, a non-`postgres` maintenance database or a server version outside17. Acknowledgement supplements explicit operator approval; it does not prove a loopback server is disposable.

The file creates one `al_tf_<randomhex>` database per case, using fresh random lease UUIDs and synthetic role passwords. It changes only that newly created database's default isolation to Repeatable Read. It explicitly provisions the reviewed owned `accesslease_control` schema/table from the migration, except in the missing-provisioning case. Cleanup closes its sessions, verifies the exact role ownership marker, terminates only that fixture role's sessions, force-drops exactly that new database and drops only that fixture role. The outer helper removes its two newly labelled containers even when tests fail. No existing account defaults, provider databases, clusters, volumes or unrelated resources are changed.

Prepared cases:

1. Missing control objects fail closed for both issuance and revoke; explicit fresh-database provisioning then succeeds; revoked role absent, use denied and retained record blocks fresh-provider issuance.
2. Actual revoke pauses before COMMIT while a new issuer's catalog guard has run. `pg_stat_activity` must show the actual advisory-lock waiter; after commit, issue rejects despite inherited Repeatable Read. This is the live stale-snapshot acceptance case for explicit Read Committed.
3. Actual issuer connection is delayed until an actual terminal revoke has committed, then issuance rejects.
4. Actual issuance pauses before COMMIT; revoke waits on the same actual advisory lock and cleans up after issuance settles.
5. Actual fence COMMIT executes on the server, then an instrumented client withholds its answer and reports an ambiguous connection error. Revoke must propagate uncertainty; a fresh connector still reads the retained record and refuses issuance. This is controlled response fault injection, not a real socket-loss or crash-durability test. Existing worker synthetic tests separately establish that errors cannot certify verified revocation.
6. A real issued-role session is open. An injected actual SQL error rejects the termination step, leaving the role NOLOGIN but present with an active session, and retaining the terminal record. Fresh issuance rejects; a retry with the ordinary connector terminates the session, drops the role and retains the record. This does not simulate every permission or OS termination failure.

Descriptor query hooks only pause or inject bounded errors; ordinary issue/revoke SQL and locks still execute on PG17. Hooks never modify shipped connector source. Individual query bounds are8/9s; lock-wait observation5s; coordination ready/resume waits5s with timer cleanup; case/hook bounds30s. Coordination releases register before provider launch; an encompassing finally releases every gate and drains all started provider operations with settled outcomes before owned fixture cleanup. The same release/drain callback is registered with afterEach before launch to handle Vitest timeout without relying on cancellation; once closing, a tracked launch thunk refuses new provider operations. Cleanup attempts every callback and aggregates failures afterward. Vitest timeout is not treated as provider cancellation. Full worker metadata/provider/browser acceptance is outside this file.

## Durability and runtime gaps

Existing `scripts/test-db.sh` starts PG17 with **fsync=off and synchronous_commit=off**. These tests can establish live transaction visibility, lock ordering, version/ownership guard behavior and retained records across fresh connector instances. They cannot prove persisted terminal fences survive server/OS crash, durable restart or storage rollback. A separate explicitly approved durable PG17 cluster (`fsync=on`, `synchronous_commit=on`), controlled restart/crash/ack-loss procedure and operator retention/backup acceptance remain required. Do not silently modify the existing helper or certify crash durability from its green tests.

Bounded read-only runtime inspection found no `postgres`, `initdb`, `pg_ctl` or `psql` on PATH and no PG17 Homebrew/Postgres.app server runtime in the inspected locations. Homebrew `libpq` exposes `psql` version18.3 plus management utilities, but no `postgres` server binary in that bin directory; this is not a PG17 substitute. No installation, server/VM/Docker startup or reset occurred. Native PG17 remains an optional operator-provided alternative; this preparation does not invent availability.

Pending: slot approval and PG17 disposable execution, independent review of this prepared test delta, true wire commit-loss and durable crash/restart evidence, full release gates and human AC11. No PASS/live criterion or release certification is recorded here.

Prepared dependency resolution: an owned untracked node_modules symlink reuses the existing exact declared AccessLease cache. Focused TypeScript noEmit check for this test/config passes; no runtime/test/provider execution occurred. Preserve the link for review/authorized later checks, never stage it.
