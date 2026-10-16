# Focused machine qualification — October 8, 2026

Scope: ordinary evidence/report/error redaction, semantic policy identity, truthful database separation, seeded-failure oracle and fresh-gate wiring. This is a correction to the existing draft implementation; it does not accept or release the MVP.

## Source and review

Required-gate source: `4c32d5f07c43595ece95956879dd033a6c5b7a95`, tree `edfcb829351584540e1726d1efce8170590b7db7`. Thirteen changed files and all 243 tracked-file hashes were independently bound. Five native Codex review dimensions (logic, security, performance, tests, consistency) approved the focused correction; a separate native advisory found no actionable findings. The owner's native-provider authorization substitutes for the repository's Claude-only team workflow. This is not a cross-family review, and no external CodeRabbit CLI or manual bot review was requested. Product model/runtime/dependency pins are unchanged.

An exploratory review preceded fast triage; final reviews consumed the completed 240-file P0/criticality triage, whole top-five critical files, whole changed files and relevant callers. This ordering is disclosed rather than retroactively presented as triage-first.

## Executed required gate

`bash scripts/verify-quality.sh --full` on Node 24.19.0: exit 0, `GREEN_PENDING_HUMAN_RECEIPT`, all 19 required records PASS in 956 seconds.

| Evidence | Actual result |
| --- | --- |
| Native configured suite | 625/625 PASS; zero skipped/todo; 41 modules |
| Coverage | Lines 99.24%; branches 94.01%; statements 98.04%; functions 97.05% |
| Browser | 10/10 PASS against the real API and disposable persistence |
| PG17 terminal-fence acceptance | 6/6 PASS on the owned disposable provider pair |
| Built-in negative controls | 20 distinct operators each have a genuine assertion failure |
| Seeded-failure control | Clean native assertion passes; exactly intended seeded assertion fails; native JUnit errors refused |
| Packaged/offline | Demo, guarded outbound behavior and internal Docker network proof PASS |
| Pinned Node 22 container | Actual 22.23.3; 613 PASS and 8 documented exclusions/skips of 621 nodes, 40 modules; a subset, not the 625-node host run |
| Reconciliation/hygiene | Current-run acceptance matrix and PRD cells reconcile; secret scan/license audit PASS; optional public sanitizer PASS |

Required receipt SHA256: `e1fc015ae23f7983e16b39652d57622db6b14c1d45f59ec16b4bfa37f9c8f990`. Raw execution and review evidence are retained privately. The final branch adds only this qualification document, the current-run generated matrix and the separately exercised optional harness after the required-gate source. Required default `--full` inputs are unchanged; final source equivalence is independently reviewed before merge. The nineteen-record gate is not claimed as a rerun at the later documentation/harness commit.

The standard mutation runner requires an assertion but does not require every failed node to be an assertion. Operators 6, 9, 10 and 19 also produced ancillary type/timeout or missing compiled-worker errors; those failures are excluded as kills. The actual 625-node green baseline is separate. No 20 per-operator restored-green runs are claimed for that runner.

## Focused behavioral proof

Adds 38 unique regressions: 11 backend, 12 surface, 15 oracle protocol cases. Earlier-source runs reproduce 9 backend, 5 JSON-surface and 11 oracle assertion failures against the original source; the final CLI boundary adds four intended assertion failures against the intermediate candidate, with eight passing cases in that twelve-case run. Final focused surface run: 116/116 PASS, including the packaged CLI subprocess. Preliminary failures remain retained and are not counted as greens. The independent existing AC-10 canonical-JSON oracle remains required; the new backend fixture resealer is not independent cryptographic proof.

Exact Node 22.22.2 floor: the full 625-node native suite, six provider-fence cases, build and packaged demo all PASS. Seven supplemental distinct guard mutations all fail at their intended named assertions, with native JSON/JUnit errors zero, four selected baseline groups and each restored-green rerun; original/copy source hashes restore exactly. These are selected source-level tests, not an additional full-coverage run. Optional documented Compose harness rehearsal: all seven steps PASS after correcting seven harness comparisons to match the existing lowercase wire-state contract and asserting the second lease is active before explicit revocation. The shipped harness first reproduced a stale uppercase-state failure (six of seven steps PASS); that failure is retained. The corrected harness SHA256 is `1298665960c8a4501139a0d6b48cdc25cc802112aaee086b69c5f300e3afa4b9`. All four original/corrected owned projects independently have zero remaining containers, volumes and networks. Six extra failed blank network lookups are excluded; actual named internal-network inspection and denied fetch support isolation. The two builds have distinct image IDs; their product Docker build inputs are byte-identical. One nonfatal documented-hash expectation remains stale. This is supplemental agent-run evidence, not AC-11.

## Open boundaries

AC-11 remains `PENDING_HUMAN_RECEIPT`: “No agent may mark AC-11 PASS.” A person who has not written, reviewed or tested AccessLease must complete all twelve documented steps and file the receipt in `ac-11-human-drill.md`. Agent-run Compose/API evidence cannot substitute for that drill.

The older full 37-P2/33-P3 findings register was not obtained in the bounded lookup, so its closure is not asserted. Long-history report truncation above the acknowledged cap and inherited bounded N+1 behavior remain deferred. Fast disposable PostgreSQL settings do not establish durable crash/restore; controlled COMMIT-answer loss does not establish actual wire loss. Provider/pilot and human release decisions remain separate.
