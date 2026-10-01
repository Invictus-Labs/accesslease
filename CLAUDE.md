# AccessLease

Make temporary task access expire, and prove revocation: issue one narrowly scoped provider grant with a hard expiry, then independently verify revocation and retain a redacted audit receipt.

## Stack
Node.js >=22.12, TypeScript strict ESM, Fastify API + worker, PostgreSQL 17, React + Vite lease view, Vitest, Playwright. Pin exact dependency versions. Real local provider: a throwaway PostgreSQL 17 cluster (native role `VALID UNTIL` TTL). A labelled SYNTHETIC provider exists for the offline demo and fault injection and never satisfies a live criterion.

## GitHub
NEVER commit to main directly. Feature branch (`codex/`) -> PR -> merge. No GitHub Actions workflows.

## Quality Gate
- Coverage floor: 90% lines and branches on decision/service code.
- Local gate: `bash scripts/verify-quality.sh` (typecheck, build, tests, coverage, secret scan, negative controls, browser smoke).
- Every acceptance criterion in `docs/prd/accesslease.md` needs current, named test evidence; see `docs/qa/`.
- AC-11 needs a HUMAN receipt: record it as `PENDING_HUMAN_RECEIPT`; no agent may mark it PASS.
- Independent code-review and QA at the exact final SHA with zero P0/P1 before merge.

## Hygiene
Public repository: synthetic data only, `localhost` in demo URLs, no personal paths, hostnames, IPs, emails or secrets. Run `sanitize-content --scope public <paths>` and `sec-scan` before outgoing commits.
