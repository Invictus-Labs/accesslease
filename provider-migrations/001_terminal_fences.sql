-- Explicit operator provisioning, once per disposable/provider resource database.
-- Run as the SAME administrator configured in ACCESSLEASE_PROVIDER_ADMIN_URL.
-- Intentionally fails if the namespace exists: inspect existing ownership/version rather than adopting it.
BEGIN;
CREATE SCHEMA accesslease_control AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA accesslease_control FROM PUBLIC;
COMMENT ON SCHEMA accesslease_control IS 'accesslease:provider-control:v1';
CREATE TABLE accesslease_control.terminal_fences (
  provider_ref text PRIMARY KEY CHECK (provider_ref ~ '^al_[0-9a-f]{24}$'),
  lease_id uuid NOT NULL UNIQUE,
  resource_ref text NOT NULL CHECK (resource_ref = current_database()),
  terminal_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE accesslease_control.terminal_fences FROM PUBLIC;
COMMENT ON TABLE accesslease_control.terminal_fences IS 'accesslease:terminal-fences:v1';
COMMIT;
-- No automatic deletion, retention purge or DROP migration. Removing a terminal record permits resurrection.
