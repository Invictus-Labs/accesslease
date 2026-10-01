# Definition of Done (verbatim from the PRD)

This file is a **verbatim extraction** of PRD sections 5 (Acceptance Criteria), 5b (Test Strategy) and 5c (Definition of Done)
from `docs/prd/accesslease.md` (source lines 42-108 at bootstrap). Every builder, reviewer and QA agent grades against it.
Do not paraphrase. The `Proven by` placeholders in 5b are predictions; QA reconciles them to real test IDs in `docs/qa/` and in the PRD.
Integrity check: `sed -n '10,$p' docs/DOD.md | diff - <(sed -n '42,108p' docs/prd/accesslease.md)` prints nothing at bootstrap (QA may later reconcile the PRD pointers; the PRD copy in this repo is then the reconciled one).

---

## 5. Acceptance Criteria

- [ ] **AC-01** — Reject wildcard/admin scopes and TTL over the policy maximum; default one hour and hard maximum eight hours are configurable only by admins.
- [ ] **AC-02** — Bind approval to exact subject, resource, scopes and expiry; changed request or expired approval cannot issue access.
- [ ] **AC-03** — Require provider-enforced TTL; issuing uncertainty enters ISSUE_UNKNOWN and reconciliation, not duplicate grants.
- [ ] **AC-04** — On expiry or task closure request revocation within 30 seconds under healthy conditions; verify with provider introspection or denied-use probe.
- [ ] **AC-05** — Provider outage leaves REVOCATION_UNCONFIRMED with next retry and visible warning; it never displays a green revoked state.
- [ ] **AC-06** — After scheduler downtime sweep overdue grants before issuing new ones; retries identify the same provider grant.
- [ ] **AC-07** — Sandbox tests verify allowed access during lease, denied access after expiry and explicit revocation, including the chosen provider cache/session behavior.
- [ ] **AC-08** — A synthetic demo works without paid accounts or mandatory telemetry; an outbound-denied test completes the deterministic local core. Live connector operations fail explicitly when disconnected.
- [ ] **AC-09** — Validate size and schema before processing; planted secret tokens never appear in logs or exported reports; malicious HTML renders as text.
- [ ] **AC-10** — Export a versioned evidence bundle and restore/read it in a clean installation with matching hashes; truncated or unsupported exports fail without partial accepted state.
- [ ] **AC-11** — Release documentation includes installation, upgrade, backup, restore and failure diagnosis; a fresh operator can execute the synthetic smoke procedure.
- [ ] **AC-12** — Enforce workspace membership and admin/operator/viewer roles on reads, writes, jobs and exports; cross-workspace object IDs return 404 with no state change.
- [ ] **AC-13** — Worker restart reclaims leased jobs without discarding uncertain external outcomes; failed migrations stop readiness and a restored backup preserves references.

## 5b. Test Strategy

**SEC · 04c — Test Strategy & DoD**

**13 mapped ACs / 13 total ACs. All tests are PLANNED; none is claimed to pass.**

| AC | Level | Proven by — planned behavior | Execution | Status |
| --- | --- | --- | --- | --- |
| AC-01 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <scope and TTL policy>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-02 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <approval freshness>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-03 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <native TTL and issue ambiguity>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-04 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <expiry and closure>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-05 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <revocation outage>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-06 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <restart sweep>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-07 | Live sandbox + integration | `tests/accesslease.spec.ts :: <real denial proof>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-08 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <offline demo>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-09 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <redaction and hostile input>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-10 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <portability and corruption>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-11 | Human + E2E | Non-builder follows supplied runbook in a fresh sandbox; record all assistance, step outcomes and cleanup receipt (§9 independent drill). | Human receipt + harness | PLANNED |
| AC-12 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <workspace isolation>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-13 | Unit + integration / E2E | `tests/accesslease.spec.ts :: <restart and restore>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |

### Flow and failure coverage

| User-facing flow | Happy path | Sad path / boundary |
| --- | --- | --- |
| scope and TTL policy | Reject wildcard/admin scopes and TTL over the policy maximum; default one hour and hard maximum eight hours are configurable only by admins. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| approval freshness | Bind approval to exact subject, resource, scopes and expiry; changed request or expired approval cannot issue access. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| native TTL and issue ambiguity | Require provider-enforced TTL; issuing uncertainty enters ISSUE_UNKNOWN and reconciliation, not duplicate grants. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| expiry and closure | On expiry or task closure request revocation within 30 seconds under healthy conditions; verify with provider introspection or denied-use probe. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| revocation outage | Provider outage leaves REVOCATION_UNCONFIRMED with next retry and visible warning; it never displays a green revoked state. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| restart sweep | After scheduler downtime sweep overdue grants before issuing new ones; retries identify the same provider grant. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| real denial proof | Sandbox tests verify allowed access during lease, denied access after expiry and explicit revocation, including the chosen provider cache/session behavior. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |

### Fixtures and runners
Use deterministic UTC clocks, synthetic IDs and planted fake secrets. Default tests cannot access customer accounts. Unit tests cover decision rules and state boundaries. Integration tests exercise real persistence and adapters against controlled fixtures; browser tests exercise API-backed UI rather than route mocks. For a CLI, E2E invokes the packaged executable in a fresh temporary directory and checks exit codes plus report contents. Add a static-report browser smoke for escaping, readable tables and empty/error states.

Each service module requires meaningful normal, invalid and boundary cases; each API router requires success, authorization and conflict tests. Each implemented page receives an E2E smoke and render tests for loading, empty and failure. Target at least 90% branch/line coverage of new decision and service code, with exclusions documented. Coverage is supporting evidence, not a substitute for the matrix.

Live adapters need opt-in sandbox tests pinned to provider/version and sanitized evidence. If credentials or a supported provider are absent, mark BLOCKED; mock success does not satisfy a live criterion. A seeded mandatory failure must turn the release verdict red. QA reconciles planned behavior labels to real test IDs in the implementation PR.

The final receipt records every repository SHA, dirty-tree status, environment, command, exit code, run time, fixture version, artifact hashes, skipped tests and unresolved findings. Any required NOT RUN, PARTIAL or BLOCKED row prevents a claim that the matrix passed.


## 5c. Definition of Done

Reference the canonical **CLAUDE.md → Quality Gate Standard (ALL repos)** at implementation time; resolve its actual workspace path in the build handoff and follow the current local/swarm runner policy. Do not introduce a competing universal gate in this PRD.

Feature-specific release conditions: every numbered acceptance criterion has current evidence; live criteria have live sandbox receipts; independent review of the final tested revision has zero P0/P1; seeded negative controls fail as intended; documentation explains unknown/partial states. Provider TTL and revocation semantics differ; cached access may outlive a grant. The chosen provider contract must define and test the maximum residual-access window.

This document is a requirements draft, not an implementation or release receipt.
