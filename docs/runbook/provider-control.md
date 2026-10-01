# Provider control prerequisite

Before enabling `postgres-role`, explicitly provision `provider-migrations/001_terminal_fences.sql` in each protected resource database, as the same administrator used by `ACCESSLEASE_PROVIDER_ADMIN_URL`. There is no new environment setting and the connector never creates or upgrades control objects during a call. This changes the setup prerequisite for existing provider installations; synthetic/offline mode is unaffected.

For the disposable Compose `reporting` database, after bringing up `provider-db` and before issuing a lease, run from the repository root:

```bash
docker compose -f compose.yaml -f compose.provider.yaml exec -T provider-db \
  psql -U provider_admin -d reporting -v ON_ERROR_STOP=1 < provider-migrations/001_terminal_fences.sql
```

The migration creates only the dedicated `accesslease_control` namespace and terminal table, revokes PUBLIC schema/table access, and stamps version 1. It deliberately fails if the namespace exists: inspect ownership, ACLs, layout and markers rather than adopting an unrelated object. Never grant grantees access to this namespace. The configured administrator must own both objects and retain the permissions required for role management and cleanup. Each record binds the derived role to its lease UUID and immutable resource database; `resource_ref = current_database()` is enforced by the table. Future migrations need explicit operator review; unsupported versions fail closed.

Do not delete, prune or restore away terminal records while an old issue can run or stale metadata can retry. Records survive role deletion. A failed revoke, permission failure, missing control object or lost commit answer remains unconfirmed and requires reconciliation; absence and a denied probe alone cannot establish that the terminal record committed.

The disposable test helpers apply this same migration only to newly created provider databases. They do not alter the metadata database or a real provider. No provisioning command was executed for this change. Live PostgreSQL ordering, timeout/commit loss, permissions, session termination, restart/recovery, Docker smoke and pilot/human acceptance remain pending.
