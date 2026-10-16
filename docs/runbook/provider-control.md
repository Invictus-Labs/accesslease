# Provider control prerequisite

Before enabling `postgres-role`, explicitly provision `provider-migrations/001_terminal_fences.sql` in each protected resource database, as the same administrator used by `ACCESSLEASE_PROVIDER_ADMIN_URL`. There is no new environment setting and the connector never creates or upgrades control objects during a call. This changes the setup prerequisite for existing provider installations; synthetic/offline mode is unaffected.

For the disposable Compose `reporting` database, after bringing up `provider-db` and before issuing a lease, run from the repository root:

```bash
docker compose -f compose.yaml -f compose.provider.yaml exec -T provider-db \
  psql -U provider_admin -d reporting -v ON_ERROR_STOP=1 < provider-migrations/001_terminal_fences.sql
```

The migration creates only the dedicated `accesslease_control` namespace and terminal table, revokes PUBLIC schema/table access, and stamps version 1. It deliberately fails if the namespace exists: inspect ownership, ACLs, layout and markers rather than adopting an unrelated object. Never grant grantees access to this namespace. The configured administrator must own both objects and retain the permissions required for role management and cleanup. Each record binds the derived role to its lease UUID and immutable resource database; `resource_ref = current_database()` is enforced by the table. Future migrations need explicit operator review; unsupported versions fail closed.

Do not delete, prune or restore away terminal records while an old issue can run or stale metadata can retry. Records survive role deletion. A failed revoke, permission failure, missing control object or lost commit answer remains unconfirmed and requires reconciliation; absence and a denied probe alone cannot establish that the terminal record committed.

The disposable test helpers apply this same migration only to newly created provider databases. They do not alter the metadata database or a real provider. The original provisioning change did not execute these commands. Subsequent engineering acceptance at local source `0ec8a7819e42411921cd4f67ab800b71cd7df553` passed six provider-only terminal-fence cases on an owned PostgreSQL 17.11 cluster with zero failures/skips and verified cleanup: provisioning/ACL guards, isolation and lock ordering, delayed issuance, controlled commit-answer uncertainty, and session-termination failure/retry. SQL readback confirmed fsync, synchronous_commit and full_page_writes ON. This bounded result does not prove metadata/worker integration, the full TTL/revocation/session acceptance matrix, true wire loss, crash durability or provider backup/restore. Those requirements, Docker/Node-floor/full release gates and independent human/operator acceptance remain pending. This documentation candidate preserves that tested code but is a later source revision; a fresh final gate/review and source-bound human drill remain required.
