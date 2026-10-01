#!/usr/bin/env bash
# AccessLease local quality gate (no remote CI, no network services beyond Docker).
#
#   bash scripts/verify-quality.sh              mechanical gate: typecheck, build, real-PostgreSQL tests with 90% line+branch
#                                               coverage, negative controls, seeded-failure check, browser E2E, secret scan,
#                                               license audit, CLI demo, receipt
#   bash scripts/verify-quality.sh --full       adds the outbound-denied Docker demo and the supported-runtime check on
#                                               Docker node:22 (these are required for a release verdict)
#   bash scripts/verify-quality.sh --benchmark  also runs the 1,000-record deterministic-core benchmark (experiment, not an SLA)
#
# Flags: --keep-db (leave the throwaway PostgreSQL pair running), --allow-incomplete-matrix (development runs only; the
# verdict can then never be GREEN), --receipt-dir DIR. Needs Docker (throwaway postgres:17-alpine pair, node:22 check),
# a supported Node on PATH (22.22.2+, 24.15+ or 26+) and a cached Playwright Chromium.
# Set ACCESSLEASE_TEST_DATABASE_URL and ACCESSLEASE_TEST_PROVIDER_DATABASE_URL (plus ACCESSLEASE_TEST_PROVIDER_CONTAINER for
# outage tests) to reuse existing disposable servers instead of starting a pair.
# Exit code: 0 only for a GREEN verdict (GREEN_PENDING_HUMAN_RECEIPT counts: AC-11 is human-only); non-zero otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/gate.mjs "$@"
