# Lease state machine - FROZEN at M0

Source of truth in code: `src/domain/state-machine.ts` (`TRANSITIONS`). A unit test asserts every other pair is rejected.

```
REQUESTED --approve--> APPROVED --issue job--> ISSUING --ok--> ACTIVE
                                                  |--ambiguous--> ISSUE_UNKNOWN --reconcile: lookup, then adopt or re-issue by deterministic ref--> ACTIVE
                                                                       |--reconcile still unresolved--> ISSUE_UNKNOWN (next_retry_at moves)
any of REQUESTED | APPROVED | ISSUING | ACTIVE | ISSUE_UNKNOWN --expiry | task closure | operator revocation | failure cleanup--> REVOKING
REVOKING --independent verification passed--> REVOKED_VERIFIED
REVOKING --anything else (outage, partial, unverifiable)--> REVOCATION_UNCONFIRMED --retry--> REVOKED_VERIFIED | REVOCATION_UNCONFIRMED
```

Only these eight states exist. There is deliberately no "expired", "failed" or "cancelled" state:

- **Expired is not revoked.** Elapsed time moves a lease into `REVOKING` (`close_reason: expired`); it never produces `REVOKED_VERIFIED`.
- **`REVOKED_VERIFIED`** requires, in one fenced transaction after the provider calls: (a) provider introspection shows the grant
  gone (or login disabled with zero sessions) and (b) a denied-use probe with the issued credential is `denied`. If the provider
  cannot be reached, introspection is stale/unknown, a session survives, or the probe is `allowed`/`unknown`, the outcome is
  `REVOCATION_UNCONFIRMED` with `next_retry_at` and a warning. It is never displayed green.
- **`ISSUE_UNKNOWN`** is entered whenever a provider call during issuance could have partially or fully succeeded
  (timeout, dropped connection, outage, ambiguous answer). Reconciliation looks the grant up by its deterministic provider
  reference; it never creates a second grant. Reconciliation is retried without ceiling until it resolves or the lease expires
  (then the lease is revoked and the possible orphan removed).
- **Definite issuance failures** (provider rejected, nothing created), a refused plan (`plan_mismatch`), an expired approval
  (`approval_expired`) and a revoke request on a never-issued lease all go `-> REVOKING` with the matching `close_reason`
  and end `REVOKED_VERIFIED` only once the provider independently shows that no grant exists. This keeps the eight-state contract; the
  `close_reason` and the audit trail distinguish "revoked a live grant" from "no grant ever existed" (flagged to the coordinator).
- `REVOCATION_UNCONFIRMED -> REVOCATION_UNCONFIRMED` records another failed retry (new append-only attempt row, new `next_retry_at`).

## Ordering guarantees (AC-06, AC-13)

1. Every worker pass starts with the overdue sweep (all workspaces): leases past `expires_at` in `REQUESTED | APPROVED | ISSUING | ACTIVE |
   ISSUE_UNKNOWN` become `REVOKING` with a `revoke` job. Issue jobs are not claimable while any lease is overdue and un-swept.
2. Revoke jobs have claim priority over reconcile over issue.
3. Jobs for the same lease run one at a time; a revoke queued behind an in-flight issue waits for it, so a late grant cannot appear
   after a verified revocation. An `issue` job that finds its lease already `REVOKING` or later makes no provider call.
4. A job lease expires after `jobLeaseSeconds`; a restarted worker reclaims it and the interrupted step is re-run idempotently by
   deterministic provider reference. A fenced completion lets a stale worker discover the loss without committing.

## History

`audit_events` and `revocation_attempts` are append-only (database triggers reject UPDATE and DELETE). Every transition writes an
audit event and an outbox event in the same transaction. `leases.version` increments on every transition.
