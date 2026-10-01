# AccessLease development boundary

- Independent, self-hostable open-source product. Contract: `docs/prd/accesslease.md`; graded Definition of Done: `docs/DOD.md`; team contract: `docs/TEAM.md` and `docs/CONTRACT.md`.
- Preserve the state distinctions: expired is not revoked; unknown, unconfirmed, stale and partial states stay visible and never become success or "green".
- Not an identity provider or a general secrets vault. No root/admin grants, no wildcard scopes, no break-glass access.
- No client data, private infrastructure, credentials or real customer identifiers in source, fixtures, logs or docs. Synthetic data and planted fake secrets only; `localhost` in demo URLs.
- No mandatory vendor, telemetry, paid provider, license server or private fleet dependency. No outbound network from the deterministic core.
- No GitHub Actions workflows. The local gate is `scripts/verify-quality.sh`.
- Work on `codex/` branches; changes reach `main` by pull request after the gate and independent review.
