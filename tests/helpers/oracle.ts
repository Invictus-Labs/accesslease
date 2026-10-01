import { createHash } from "node:crypto";
import pg from "pg";

/**
 * Independent oracles. These deliberately re-implement the documented encodings (docs/contracts/api.md) instead of
 * importing them from src/, so a bug in the product's canonicalization or hashing cannot hide itself from the tests.
 */

/** Canonical JSON: keys sorted by UTF-16 code unit, no whitespace, `undefined` omitted, Dates as UTC ISO strings. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("non-finite number is not canonical JSON");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`cannot canonicalize ${typeof value}`);
  }
}

export const sha256Hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");
export const hashCanonical = (value: unknown): string => sha256Hex(canonicalJson(value));

export interface PlanInput {
  task_ref: string;
  subject_ref: string;
  resource_ref: string;
  scopes: string[];
  expires_at: string;
  policy_hash: string;
}

/** plan_hash per the contract: scopes sorted ascending and de-duplicated, everything else verbatim. */
export function planHash(input: PlanInput): string {
  return hashCanonical({ ...input, scopes: [...new Set(input.scopes)].sort() });
}

/** Deterministic role name of the real provider for a lease: `al_` + first 24 hex characters of SHA-256(lease id) (docs/contracts/provider.md). */
export const providerRoleFor = (leaseId: string): string => `al_${sha256Hex(leaseId).slice(0, 24)}`;

export interface Bundle {
  schema_version: number;
  kind: string;
  exported_at: string;
  generator: unknown;
  source: unknown;
  manifest: { files: { path: string; sha256: string; bytes: number }[]; file_count: number; total_bytes: number; manifest_hash: string };
  files: Record<string, unknown>;
  bundle_hash: string;
}

/** Recompute every hash in a bundle and report mismatches (empty array = the bundle is internally consistent). */
export function bundleHashProblems(bundle: Bundle): string[] {
  const problems: string[] = [];
  for (const entry of bundle.manifest.files) {
    const doc = bundle.files[entry.path];
    if (doc === undefined) problems.push(`missing file ${entry.path}`);
    else if (hashCanonical(doc) !== entry.sha256) problems.push(`hash mismatch ${entry.path}`);
  }
  if (hashCanonical(bundle.manifest.files) !== bundle.manifest.manifest_hash) problems.push("manifest_hash mismatch");
  const { bundle_hash: _omit, ...rest } = bundle;
  if (hashCanonical(rest) !== bundle.bundle_hash) problems.push("bundle_hash mismatch");
  return problems;
}

/** Re-seal a bundle after a deliberate edit so only the intended defect remains (hashes consistent again). */
export function reseal(bundle: Bundle): Bundle {
  const files = Object.keys(bundle.files)
    .sort()
    .map((path) => ({ path, sha256: hashCanonical(bundle.files[path]), bytes: Buffer.byteLength(canonicalJson(bundle.files[path])) }));
  const manifest = { files, file_count: files.length, total_bytes: files.reduce((n, f) => n + f.bytes, 0), manifest_hash: hashCanonical(files) };
  const { bundle_hash: _omit, ...rest } = { ...bundle, manifest };
  return { ...rest, bundle_hash: hashCanonical(rest) } as Bundle;
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Row counts for every public table: a cheap but total "did anything change" fingerprint. */
export async function tableCounts(databaseUrl: string): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tables = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    const counts: Record<string, number> = {};
    for (const { tablename } of tables.rows) counts[tablename] = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${tablename}"`)).rows[0]!.n);
    return counts;
  } finally {
    await client.end();
  }
}

/** Content fingerprint of selected tables (md5 of the ordered row text), for no-state-change assertions. */
export async function tableFingerprint(databaseUrl: string, tables: string[]): Promise<Record<string, string>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const out: Record<string, string> = {};
    for (const table of tables) {
      out[table] = (await client.query<{ h: string }>(`SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h FROM "${table}" t`)).rows[0]!.h;
    }
    return out;
  } finally {
    await client.end();
  }
}

export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(databaseUrl: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(text, params as any[])).rows as T[];
  } finally {
    await client.end();
  }
}
