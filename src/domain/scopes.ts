import type { ProviderKind, ProviderLabel } from "./types.js";

/**
 * Scope vocabulary shared by policy and providers (AC-01). A scope names one narrow grant, e.g.
 * `pg:public.orders:select`. Wildcard and admin-class scopes are rejected before any provider is contacted,
 * independent of the provider grammar (defense in depth: the provider re-checks).
 */

export type ScopeVerdict = { ok: true } | { ok: false; code: "invalid_scope" | "scope_wildcard" | "scope_forbidden"; message: string };

const WILDCARD_CHARS = /[*%?[\]{}]/;
/** Components (split on `:`, `.`, `/` and whitespace) that mean "everything". */
const WILDCARD_WORDS = new Set(["all", "any", "every", "everything", "full", "wildcard", "all_privileges", "all-privileges", "allprivileges"]);
/** Components that mean elevated / administrative power. */
const ADMIN_WORDS = new Set([
  "admin",
  "administrator",
  "root",
  "superuser",
  "super",
  "owner",
  "ownership",
  "sudo",
  "ddl",
  "dba",
  "grant",
  "createrole",
  "createdb",
  "createuser",
  "replication",
  "bypassrls",
  "drop",
  "alter",
  "truncate",
  "delete",
  "manage",
  "maintain",
  "execute",
  "trigger",
  "references",
  "pg_signal_backend",
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_execute_server_program",
]);
const ADMIN_SUBSTRINGS = ["superuser", "createrole", "createdb", "bypassrls", "replication", "pg_execute_server", "pg_read_server", "pg_write_server"];

export function genericScopeCheck(scope: string): ScopeVerdict {
  if (scope.length === 0 || scope.length > 200) return { ok: false, code: "invalid_scope", message: "scope must be 1-200 characters" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(scope)) return { ok: false, code: "invalid_scope", message: "scope contains control characters" };
  const lower = scope.toLowerCase();
  const components = lower.split(/[:./\s,;]+/).filter(Boolean);
  if (WILDCARD_CHARS.test(scope) || components.some((c) => WILDCARD_WORDS.has(c))) {
    return { ok: false, code: "scope_wildcard", message: "wildcard scopes are not allowed; name one table and one privilege" };
  }
  if (components.some((c) => ADMIN_WORDS.has(c)) || ADMIN_SUBSTRINGS.some((s) => lower.includes(s))) {
    return { ok: false, code: "scope_forbidden", message: "admin-class scopes are not allowed" };
  }
  if (/\s/.test(scope)) return { ok: false, code: "invalid_scope", message: "scope must not contain whitespace" };
  return { ok: true };
}

/** Sorted, de-duplicated scopes (set semantics for the plan hash). */
export const normalizeScopes = (scopes: readonly string[]): string[] => [...new Set(scopes)].sort();

const PG_IDENT = "[a-z_][a-z0-9_]{0,62}";
const PG_SCOPE = new RegExp(`^pg:(${PG_IDENT})\\.(${PG_IDENT}):(select|insert|update)$`);
const PG_DATABASE = new RegExp(`^${PG_IDENT}$`);
const SYNTHETIC_SCOPE = /^synthetic:[a-z0-9][a-z0-9_.-]{0,99}:(read|write)$/;
const SYNTHETIC_RESOURCE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export interface ParsedPgScope {
  schema: string;
  table: string;
  privilege: "select" | "insert" | "update";
}

export function parsePgScope(scope: string): ParsedPgScope | null {
  const m = PG_SCOPE.exec(scope);
  return m ? { schema: m[1] as string, table: m[2] as string, privilege: m[3] as ParsedPgScope["privilege"] } : null;
}

/** System catalogs are never grantable (e.g. pg_catalog.pg_authid holds password hashes): pg_catalog, information_schema and every pg_* schema. */
export const isSystemSchema = (schema: string): boolean => schema === "information_schema" || schema.startsWith("pg_");

export const isPgDatabaseName = (name: string): boolean => PG_DATABASE.test(name) && !name.startsWith("template");
export const isSyntheticScope = (scope: string): boolean => SYNTHETIC_SCOPE.test(scope);
export const isSyntheticResource = (resource: string): boolean => SYNTHETIC_RESOURCE.test(resource);

export const PROVIDER_LABELS: Record<ProviderKind, ProviderLabel> = {
  synthetic: { kind: "synthetic", label: "SYNTHETIC", live: false },
  "postgres-role": { kind: "postgres-role", label: "LIVE_LOCAL_POSTGRES", live: true },
};

export const labelForKind = (kind: ProviderKind): ProviderLabel => ({ ...PROVIDER_LABELS[kind] });
