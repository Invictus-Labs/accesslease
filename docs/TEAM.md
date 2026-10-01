# AccessLease build team: roster, territories and rules

Coordinator + three workers. Every Claude agent (builder, reviewer, QA) runs **claude-sonnet-5-5 at high effort** (agent type `ns-sonnet-high`). No other model or effort is used.
Status vocabulary for every report: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT`, with evidence (exact commands, exit codes, full 40-char SHAs).

| Role | Agent name | Writes (exclusive) |
| --- | --- | --- |
| Coordinator | `accesslease-coordinator` | everything marked Coordinator below, git publish, PRs, gates |
| Domain / backend builder | `accesslease-backend` | see Backend territory |
| CLI / UI / integration builder | `accesslease-surface` | see Surface territory |
| Independent QA | `accesslease-qa` | see QA territory (never edits `src/`) |

## Exclusive file territories (no overlap; a file has exactly one owner)

**Backend (`accesslease-backend`)**: `src/domain/**`, `src/services/**`, `src/api/**`, `src/workers/**`, `src/connectors/**`, `src/db/**`, `src/lib/**`, `src/config.ts`, `src/errors.ts`, `src/crypto.ts`, `src/context.ts`, `src/server.ts`, `migrations/**`, `schemas/**`, `docs/contracts/**` (API, state machine, provider contract, residual-access window), `tests/unit/backend/**`.
PRD section 7 names `src/api/leases.ts`, `src/services/policy.ts`, `src/workers/revoke.ts`, `src/connectors/provider.ts`, `schemas/lease.json`, `migrations/001_initial.sql`; these exist inside this territory.

**Surface (`accesslease-surface`)**: `src/cli.ts`, `src/commands.ts`, `src/cli/**`, `src/web/**` (`App.tsx`, `Report.tsx`, `styles.css`, `main.tsx`, `index.html`, pages, API client), `src/report/**`, `templates/report.html`, `src/adapters/**` (optional ecosystem event consumer), `Dockerfile`, `.dockerignore`, `compose*.yaml`, `.env.example`, `README.md`, `docs/runbook/**` (install, upgrade, backup, restore, failure diagnosis, smoke), `docs/ADAPTERS.md`, `tests/unit/surface/**`, `tests/web/**`.
PRD section 7 lists README/Dockerfile under QA/packaging; they moved here so QA stays independent of the implementation it grades. This is the only deviation from the section 7 table.

**QA (`accesslease-qa`)**: `tests/accesslease.spec.ts` (AC matrix), `tests/integration/**`, `tests/e2e/**`, `tests/negative-controls/**`, `tests/helpers/**`, `fixtures/**` (`fixtures/demo.json`, planted fake secrets, hostile HTML, corrupt exports), `scripts/**` (`verify-quality.sh`, mutation/negative-control runner, receipt writer, license audit, fresh-operator smoke harness, throwaway-database helper), `docs/qa/**` (AC matrix, receipts, human drill instructions, findings), `docs/DEPENDENCY-LICENSES.md`, and the reconciliation of the "Proven by" cells in `docs/prd/accesslease.md` section 5b (and `docs/prd/accesslease.html`).
QA reports implementation defects to the owning builder by message (file, line, observed vs expected, repro). QA never patches `src/`.

**Coordinator**: `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `vite.config.ts`, `playwright.config.ts`, `.gitignore`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `lessons.md`, `docs/DOD.md`, `docs/TEAM.md`, `docs/CONTRACT.md`, `docs/prd/**` (except QA's 5b pointers), all git remotes, pushes, PRs and merges. Need a dependency or config change? Message the coordinator with the exact package/version and reason.

If a change needs a file you do not own, message its owner (or the coordinator for shared files) with exactly what you need. Do not edit it.

## Definition of Done and gates
`docs/DOD.md` is PRD sections 5, 5b, 5c verbatim. It is the contract. Quality Gate Standard (canonical CLAUDE.md, ALL repos): code implemented not stubbed; tests exist; no security regressions; E2E verified; ticketed through its lifecycle (card #3875).
Rules that bind every agent:
- Never label a simulator or fixture as live. The `synthetic` provider is labelled SYNTHETIC in code, API, UI and evidence; it never satisfies AC-07 or any live criterion. Live criteria are proven only against the real local PostgreSQL provider. If the real provider cannot prove a criterion, that row is BLOCKED with the exact blocker.
- Any required row that is PARTIAL, NOT RUN or BLOCKED is not a PASS. Do not write "PASS" for it.
- AC-11 is human-only. No agent marks it PASS. QA builds the automated fresh-directory harness and the human drill instructions; the AC matrix records `PENDING_HUMAN_RECEIPT`.
- Seeded negative controls must fail as intended; the release verdict goes red on a seeded mandatory failure.
- Implementers never self-certify independent gates. Reviewers/QA are different agents than the builders.
- Coverage floor 90% lines and branches on `src/` decision/service code (config in `vitest.config.ts`).

## Runtime
Use a supported Node for Vitest 5 and subprocesses: 22.22.2+, 24.15+ or 26+. The default host Node 25 is unsupported; the coordinator supplies a supported Node on PATH in each agent's prompt. Verify with `node -v` before running tests.

## Git, safety and hygiene
- Single shared working tree, branch `codex/mvp`. Commit only your own territory, with explicit paths: `git add <paths>` then `git commit -m ... -- <paths>`. Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset --hard`, `git checkout -- .`, rebase, force-push or branch switching. If `.git/index.lock` exists, wait a few seconds and retry; never delete it unless no git process is running and it is older than 2 minutes.
- Commit only when your territory's typecheck and tests pass. Commit message ends with the trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not push, open PRs, merge or create remotes. The coordinator publishes.
- Public repo hygiene: no personal paths (anything under a home directory), hostnames, IPs, emails, credentials, machine names, or the GitHub organization slug in any file. Demo URLs use `localhost` and docs say what the bind address means. Run `sanitize-content --scope public <paths>` on files you add or change (exit 0) before you finish.
- No GitHub Actions. No `.env` files committed. No outbound network from the deterministic core. No mandatory telemetry.
- Docker: only create containers/networks labelled `accesslease-test=1` with names starting `al-`, bind published ports to `127.0.0.1` with random host ports, stop your own containers when done. Never run `docker system prune`, never stop or touch other containers (other products and Mission Control run on this machine), cap throwaway Postgres at `--memory 768m`. At most one throwaway Postgres pair per agent at a time; the database helper script (QA) creates uniquely named databases/roles so concurrent agents never collide.
- Permissions: use ordinary scoped tool permissions. Never bypass or blanket-approve.
- Timestamps in evidence come from `date -u`, never estimated. Never write secrets into files; planted fake secrets are obviously fake strings.

## Milestones
M0 (backend): freeze `src/domain/types.ts`, `schemas/*.json`, `docs/contracts/api.md` and the provider/service interfaces; message surface and QA. M1: deterministic core with failure states + synthetic provider. M2: real PostgreSQL provider, worker, revoke/verify, restart sweep. M3: API/RBAC/export; CLI, UI, report, runbook. M4: integration/e2e/negative controls/coverage/gate, AC reconciliation. M5: independent review and QA on the exact final SHA, resolve P0/P1. M6: publication (coordinator).
