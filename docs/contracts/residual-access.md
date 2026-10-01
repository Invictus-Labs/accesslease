# Residual-access window (PRD section 5c and risk register)

"Provider TTL and revocation semantics differ; cached access may outlive a grant. The chosen provider contract must define and test the
maximum residual-access window." This document defines it for the real `postgres-role` provider and says what is and is not covered.
The `synthetic` provider has no residual-access claim: it only models the same semantics deterministically and is never live evidence.

## What PostgreSQL does (the "chosen provider cache/session behavior")

| Mechanism | Behavior | Consequence |
| --- | --- | --- |
| `CREATE ROLE ... VALID UNTIL '<expires_at>'` | Checked **only at authentication**. After `expires_at` new logins fail with SQLSTATE `28P01`. | Native TTL stops *new* access exactly at expiry, with no AccessLease involvement (the safety backstop). |
| Established session | Not affected by `VALID UNTIL` or `ALTER ROLE ... NOLOGIN`; the connection stays open (table privileges are re-checked per statement, so a `REVOKE` also takes effect on a live session). | An open session can keep using whatever the role could do until it is terminated. **This is the residual access.** |
| `pg_terminate_backend(pid)` | Ends the session immediately. | The mechanism AccessLease uses to close the window. |
| Connection pools / replicas / cached credentials on the grantee side | Outside AccessLease and the target cluster. | Not covered. A pool that already holds a connection is an established session (covered by termination); credentials copied elsewhere cannot log in after expiry or after the role is dropped. |
| Privileges the target grants to `PUBLIC` | Inherited by every role. | Outside AccessLease's control. The sandbox must not grant `PUBLIC` anything that is sensitive (tests assert a table not named in the scopes is denied under the default privileges of a fresh PostgreSQL 17 cluster). |

Note on `DROP OWNED BY`: revocation runs it in the resource database, which also drops any object the role owns there. That is intended (a
contractor-created object must not outlive the lease), and it is why the role is never made owner of anything AccessLease grants. If the target
schema lets `PUBLIC` create objects, the role could create and own one before revocation; the sandbox should not grant `PUBLIC` `CREATE`
(PostgreSQL 15+ does not by default).

## Maximum residual-access window

For an established session on a lease with `expires_at = E` and a healthy worker and provider:

```
W_max = P + D + T          (seconds after E until the session is terminated and revocation is requested+executed)
P = worker poll interval (default 5 s, ACCESSLEASE_WORKER_POLL_MS): the sweep that moves the lease to REVOKING runs at least this often
D = queue/claim latency of one worker pass (bounded by maxJobsPerPass = 25 jobs per pass; revoke jobs have claim priority)
T = termination time: disable login + pg_terminate_backend, bounded to 5 s per attempt (terminateWaitMs), typically < 1 s
```
Target contract: **revocation is requested within 30 s of expiry (AC-04)** and the open session is terminated in the same job.
With the defaults `P + D + T` is below 30 s whenever a pass takes less than ~20 s. New logins are impossible from `E` on regardless of
the worker (native TTL), so the window concerns only sessions opened before `E`.

Not covered: worker/provider outage. Then the window is unbounded for established sessions, new logins stay blocked by native TTL,
the lease is `REVOCATION_UNCONFIRMED` with `next_retry_at` and a visible warning, and the retry loop never gives up. The state is never
shown green. Clock skew: `VALID UNTIL` uses the PostgreSQL server clock; AccessLease schedules by its own clock. Keep both on NTP;
the sweep triggers at AccessLease's `expires_at`, so skew of S seconds moves the window by S.

## Measurement (live test, real PostgreSQL 17 in a disposable container)

`tests/unit/backend/postgres-role.test.ts` ("AC-07: allowed during the lease, denied after expiry and after explicit revocation; the
residual-access window is measured") issues a lease with a 4 s TTL against a separate PostgreSQL 17 cluster, opens a session, waits for
`E`, then asserts in order: a new login fails (`28P01`); the open session still works (residual access is real); the worker revokes the
lease; the session is terminated; introspection shows the role gone; a denied-use probe is denied; and the revocation was requested and
verified within 30 s of `E`. One recorded run on the build machine (worker polled every 300 ms):

```
RESIDUAL_ACCESS_WINDOW open_session_survived_expiry=true revocation_requested_after_ms=348 verified_after_ms=862
```
These figures are one observation of a healthy local run, not a guarantee; the contractual bound is the formula above and the 30 s
target. QA records its own timestamps in the AC-07 receipt (`docs/qa/`).

## Verification before "verified"

`REVOKED_VERIFIED` requires both: (a) introspection (`pg_roles` has no such role; the session count for it is zero) and
(b) a denied-use probe (a real login attempt with the issued credential fails with `28000`/`28P01`). An unreachable cluster, a role that
still exists, a surviving session, a stale/unknown introspection or an unknown probe result yields `REVOCATION_UNCONFIRMED` (see
`state-machine.md`). Expiry alone never yields `REVOKED_VERIFIED`.
