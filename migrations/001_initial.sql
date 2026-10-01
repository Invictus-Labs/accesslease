-- AccessLease schema v1. All IDs are UUIDs, all times UTC timestamptz.
-- Every lease-scoped table carries workspace_id and a composite foreign key so a row can never reference
-- a lease in another workspace. History tables are append-only (triggers). Expand/contract: later migrations
-- only add; they never rewrite or drop what this one creates.

CREATE TYPE member_role AS ENUM ('admin', 'operator', 'viewer');
CREATE TYPE lease_state AS ENUM (
  'REQUESTED', 'APPROVED', 'ISSUING', 'ACTIVE', 'ISSUE_UNKNOWN', 'REVOKING', 'REVOKED_VERIFIED', 'REVOCATION_UNCONFIRMED'
);
CREATE TYPE provider_kind AS ENUM ('synthetic', 'postgres-role');
CREATE TYPE revocation_result AS ENUM ('verified', 'unverified', 'provider_error');
CREATE TYPE job_type AS ENUM ('issue', 'reconcile', 'revoke');
CREATE TYPE job_state AS ENUM ('queued', 'running', 'done', 'dead');

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Per-workspace outbox sequence: bumped in the same transaction as the event insert, so the pull cursor is
  -- monotonic in commit order (concurrent emitters of one workspace serialize on this row).
  event_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role member_role NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_ttl_seconds integer NOT NULL CHECK (default_ttl_seconds >= 1),
  max_ttl_seconds integer NOT NULL CHECK (max_ttl_seconds >= 1 AND max_ttl_seconds <= 86400),
  min_ttl_seconds integer NOT NULL CHECK (min_ttl_seconds >= 1),
  approval_ttl_seconds integer NOT NULL CHECK (approval_ttl_seconds BETWEEN 1 AND 86400),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  scope_allow_prefixes text[] NOT NULL DEFAULT '{}',
  scope_deny_prefixes text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  policy_hash text NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid,
  CHECK (min_ttl_seconds <= default_ttl_seconds AND default_ttl_seconds <= max_ttl_seconds)
);

CREATE TABLE leases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_ref text NOT NULL,
  subject_ref text NOT NULL,
  resource_ref text NOT NULL,
  scopes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  policy_hash text NOT NULL,
  plan_hash text NOT NULL,
  state lease_state NOT NULL DEFAULT 'REQUESTED',
  version integer NOT NULL DEFAULT 1,
  provider_kind provider_kind NOT NULL,
  requested_by_ref text NOT NULL,
  close_reason text CHECK (close_reason IN ('expired', 'task_closed', 'operator_revoked', 'issue_failed', 'plan_mismatch', 'approval_expired')),
  close_detail text,
  close_requested_at timestamptz,
  issued_at timestamptz,
  revoked_at timestamptz,
  last_verified_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX leases_ws_created ON leases (workspace_id, created_at DESC, id DESC);
CREATE INDEX leases_state_expiry ON leases (state, expires_at);

-- Database-level guard: the only legal state changes are the PRD state machine (src/domain/state-machine.ts).
CREATE FUNCTION leases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id OR NEW.plan_hash <> OLD.plan_hash
     OR NEW.scopes <> OLD.scopes OR NEW.expires_at <> OLD.expires_at OR NEW.subject_ref <> OLD.subject_ref
     OR NEW.resource_ref <> OLD.resource_ref OR NEW.task_ref <> OLD.task_ref OR NEW.provider_kind <> OLD.provider_kind THEN
    RAISE EXCEPTION 'accesslease: approved lease plan fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT (
      (OLD.state = 'REQUESTED' AND NEW.state IN ('APPROVED', 'REVOKING')) OR
      (OLD.state = 'APPROVED' AND NEW.state IN ('ISSUING', 'REVOKING')) OR
      (OLD.state = 'ISSUING' AND NEW.state IN ('ACTIVE', 'ISSUE_UNKNOWN', 'REVOKING')) OR
      (OLD.state = 'ACTIVE' AND NEW.state IN ('REVOKING')) OR
      (OLD.state = 'ISSUE_UNKNOWN' AND NEW.state IN ('ACTIVE', 'REVOKING')) OR
      (OLD.state = 'REVOKING' AND NEW.state IN ('REVOKED_VERIFIED', 'REVOCATION_UNCONFIRMED')) OR
      (OLD.state = 'REVOCATION_UNCONFIRMED' AND NEW.state IN ('REVOKED_VERIFIED'))
    ) THEN
      RAISE EXCEPTION 'accesslease: invalid lease transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'REVOKED_VERIFIED' AND (NEW.last_verified_at IS NULL OR NEW.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'accesslease: REVOKED_VERIFIED requires a verification timestamp' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.state = 'REVOKED_VERIFIED' THEN
    RAISE EXCEPTION 'accesslease: REVOKED_VERIFIED leases are final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER leases_guard_update BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION leases_guard();

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  actor_id uuid,
  actor_ref text NOT NULL,
  plan_hash text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (lease_id),
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);

CREATE TABLE provider_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  provider_kind provider_kind NOT NULL,
  provider_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'issued', 'revoked')),
  issued_at timestamptz,
  valid_until timestamptz,
  revoked_at timestamptz,
  conn_host text,
  conn_port integer,
  conn_database text,
  conn_username text,
  created_at timestamptz NOT NULL,
  UNIQUE (lease_id),
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);

-- Credential delivered once (encrypted with the operator key; purged on retrieval or verified revocation).
CREATE TABLE lease_secrets (
  lease_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  credential_ct text,
  credential_retrieved_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);

CREATE TABLE revocation_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  attempted_at timestamptz NOT NULL,
  result revocation_result NOT NULL,
  verification_ref text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_retry_at timestamptz,
  UNIQUE (lease_id, attempt_no),
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lease_id uuid,
  actor_ref text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  redacted_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);
CREATE INDEX audit_events_lease ON audit_events (lease_id, seq);
CREATE INDEX audit_events_ws ON audit_events (workspace_id, seq);

-- Transactional outbox (pull delivery): written in the same transaction as the state change.
CREATE TABLE events (
  workspace_id uuid NOT NULL,
  seq bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  lease_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  revision integer NOT NULL,
  evidence_ref text NOT NULL,
  correlation_id text,
  schema_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, seq),
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  type job_type NOT NULL,
  priority smallint NOT NULL,
  state job_state NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  locked_by text,
  next_attempt_at timestamptz NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id)
);
CREATE INDEX jobs_claim ON jobs (state, next_attempt_at, priority);
CREATE INDEX jobs_lease ON jobs (lease_id, state);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_ref text NOT NULL,
  route text NOT NULL,
  key text NOT NULL,
  body_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, actor_ref, route, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- Restored evidence (AC-10): read-only; never re-activated and never touched by the worker.
CREATE TABLE evidence_imports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  bundle_hash text NOT NULL,
  source_workspace_id uuid NOT NULL,
  schema_version integer NOT NULL,
  exported_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL,
  imported_by text NOT NULL,
  lease_count integer NOT NULL,
  UNIQUE (workspace_id, bundle_hash),
  UNIQUE (workspace_id, id)
);

CREATE TABLE imported_leases (
  import_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  doc jsonb NOT NULL,
  doc_hash text NOT NULL,
  PRIMARY KEY (import_id, lease_id),
  FOREIGN KEY (workspace_id, import_id) REFERENCES evidence_imports(workspace_id, id)
);

-- History is append-only. The only exception is the retention purge, which sets accesslease.retention = 'on'
-- inside its own transaction (documented in docs/contracts/api.md).
CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('accesslease.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'accesslease: % rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER revocation_attempts_append_only BEFORE UPDATE OR DELETE ON revocation_attempts FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER approvals_immutable BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION reject_modification();
