import { newId } from "../lib/ids.js";
import type { Ctx } from "../context.js";
import { canonicalJson, contentHash } from "../crypto.js";
import type { Queryable } from "../db/index.js";
import { BundleSummarySchema, EvidenceBundleSchema, LeaseEvidenceSchema, PolicySchema } from "../domain/schemas.js";
import {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  type BundleErrorCode,
  type BundleVerification,
  DEFAULT_IMPORT_MAX_FILES,
  DEFAULT_IMPORT_METADATA_BYTES,
  type EvidenceBundle,
  type ImportReceipt,
  WIRE_STATES,
  MAX_IMPORT_BLOB_OVERRIDE_BYTES,
  type Principal,
  type ProviderLabel,
} from "../domain/types.js";
import { AppError, fail, notFound } from "../errors.js";
import { redactDeep } from "../lib/redact.js";
import type { ExportOptions, ExportResult, VerifyBundleOptions } from "./contract.js";
import { isUuid } from "./auth.js";
import { toEnvelope } from "./events.js";
import { loadDetails } from "./leases.js";
import { loadPolicy } from "./policy.js";
import { requireRole } from "./roles.js";
import { providerLabel } from "./rows.js";
import type { EventType } from "../domain/types.js";

/**
 * Evidence bundle export / verification / transactional import (AC-10). Everything here is offline: no network I/O.
 * Format and failure codes: docs/contracts/api.md section 6. Imported leases are read-only evidence, never re-activated.
 */

const PATH_RE = /^(?:summary\.json|policy\.json|leases\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/;
const GENERATOR_VERSION = "0.1.0";

class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const bytesOf = (doc: unknown) => Buffer.byteLength(canonicalJson(doc));

/** Redacted evidence documents for the given leases, built with a fixed number of queries (bulk load). */
async function leaseEvidenceDocs(db: Queryable, workspaceId: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const details = await loadDetails(db, workspaceId, ids);
  const events = await db.query<{ event_id: string; lease_id: string; event_type: EventType; occurred_at: Date; revision: number; evidence_ref: string; correlation_id: string | null }>(
    "SELECT event_id, lease_id, event_type, occurred_at, revision, evidence_ref, correlation_id FROM events WHERE workspace_id = $1 AND lease_id = ANY($2::uuid[]) ORDER BY seq",
    [workspaceId, ids],
  );
  const byLease = new Map<string, ReturnType<typeof toEnvelope>[]>();
  for (const row of events.rows) byLease.set(row.lease_id, [...(byLease.get(row.lease_id) ?? []), toEnvelope(row)]);
  return new Map(
    details.map((detail) => [detail.id, redactDeep({ schema_version: 1, kind: "accesslease.lease-evidence", lease: detail, events: byLease.get(detail.id) ?? [] }) as Record<string, unknown>]),
  );
}

/** `GET /leases/{id}/evidence`: the redacted evidence document for one lease (viewer and above). */
export async function getLeaseEvidence(ctx: Ctx, principal: Principal, leaseId: string) {
  requireRole(principal, "viewer");
  if (!isUuid(leaseId)) throw notFound();
  const id = leaseId.toLowerCase();
  const doc = (await leaseEvidenceDocs(ctx.db, principal.workspaceId, [id])).get(id);
  if (!doc) throw notFound();
  return doc;
}

/** Build a versioned, hash-verifiable bundle of the workspace's redacted lease evidence. */
export async function exportBundle(ctx: Ctx, principal: Principal, options: ExportOptions = {}): Promise<ExportResult> {
  requireRole(principal, "operator");
  const now = ctx.clock();
  let ids: string[];
  if (options.leaseIds) {
    ids = [...new Set(options.leaseIds.map((id) => id.toLowerCase()))];
    for (const id of ids) if (!isUuid(id)) throw notFound();
    const found = await ctx.db.query<{ id: string }>("SELECT id FROM leases WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [principal.workspaceId, ids]);
    if (found.rows.length !== ids.length) throw notFound();
  } else {
    ids = (await ctx.db.query<{ id: string }>("SELECT id FROM leases WHERE workspace_id = $1 ORDER BY created_at, id", [principal.workspaceId])).rows.map((r) => r.id);
  }
  if (ids.length + 2 > ctx.settings.importMaxFiles) throw fail("bundle_too_many_files", `a bundle holds at most ${ctx.settings.importMaxFiles} files; export a subset with leaseIds`);
  const files: Record<string, unknown> = {};
  const labels = new Map<string, ProviderLabel>();
  const byState = Object.fromEntries(WIRE_STATES.map((s) => [s, 0])) as Record<string, number>;
  const docs = await leaseEvidenceDocs(ctx.db, principal.workspaceId, ids);
  for (const id of ids) {
    const doc = docs.get(id) as Record<string, unknown>;
    files[`leases/${id}.json`] = doc;
    const lease = doc.lease as { state: string; provider: ProviderLabel };
    byState[lease.state] = (byState[lease.state] ?? 0) + 1;
    labels.set(lease.provider.kind, lease.provider);
  }
  const policy = await loadPolicy(ctx.db, principal.workspaceId);
  files["policy.json"] = policy;
  files["summary.json"] = {
    schema_version: 1,
    kind: "accesslease.bundle-summary",
    workspace: { id: principal.workspaceId, name: principal.workspaceName },
    exported_at: now.toISOString(),
    lease_ids: [...ids].sort(),
    by_state: byState,
    unresolved: { issue_unknown: byState.issue_unknown ?? 0, revocation_unconfirmed: byState.revocation_unconfirmed ?? 0 },
    contains_synthetic: [...labels.values()].some((l) => !l.live),
  };
  const entries = Object.keys(files)
    .sort()
    .map((path) => ({ path, sha256: contentHash(files[path]), bytes: bytesOf(files[path]) }));
  const manifest = { files: entries, file_count: entries.length, total_bytes: entries.reduce((n, e) => n + e.bytes, 0), manifest_hash: contentHash(entries) };
  const unhashed = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    exported_at: now.toISOString(),
    generator: { name: "accesslease" as const, version: ctx.settings.appVersion || GENERATOR_VERSION },
    source: { workspace_id: principal.workspaceId, workspace_name: principal.workspaceName, provider_labels: [...labels.values()] },
    manifest,
    files,
  };
  const bundle = { ...unhashed, bundle_hash: contentHash(unhashed) } as EvidenceBundle;
  const bytes = Buffer.from(canonicalJson(bundle), "utf8");
  if (bytes.length > ctx.settings.importMaxMetadataBytes && ctx.settings.importBlobCapBytes === 0) {
    throw fail("bundle_too_large", "the bundle exceeds the metadata size limit; export a subset with leaseIds");
  }
  await ctx.db.query(
    `INSERT INTO audit_events (id, workspace_id, lease_id, actor_ref, action, occurred_at, redacted_metadata) VALUES ($1,$2,NULL,$3,'evidence.exported',$4,$5)`,
    [newId(), principal.workspaceId, principal.actorRef, now, JSON.stringify({ lease_count: ids.length, bundle_hash: bundle.bundle_hash })],
  );
  return { bytes, bundle_hash: bundle.bundle_hash, lease_count: ids.length, file_count: entries.length };
}

interface Parsed {
  bundle: EvidenceBundle;
  leaseDocs: Map<string, ReturnType<typeof LeaseEvidenceSchema.parse>>;
}

/** Parse and fully verify; throws BundleError at the first failed check (order documented in api.md). */
function parseAndVerify(bytes: Uint8Array, options: VerifyBundleOptions): Parsed {
  try {
    return parseAndVerifyUnguarded(bytes, options);
  } catch (error) {
    // Hostile nesting depth must fail closed as a bad bundle, never as a server error.
    if (error instanceof RangeError) throw new BundleError("bundle_malformed", "bundle is nested too deeply");
    throw error;
  }
}

function parseAndVerifyUnguarded(bytes: Uint8Array, options: VerifyBundleOptions): Parsed {
  const maxBytes = options.allowLarge ? MAX_IMPORT_BLOB_OVERRIDE_BYTES : (options.maxBytes ?? DEFAULT_IMPORT_METADATA_BYTES);
  const maxFiles = options.maxFiles ?? DEFAULT_IMPORT_MAX_FILES;
  if (bytes.length > maxBytes) throw new BundleError("bundle_too_large", `bundle is ${bytes.length} bytes; the limit is ${maxBytes}`);
  const text = Buffer.from(bytes).toString("utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = (error as Error).message;
    const at = /position (\d+)/.exec(message)?.[1];
    // A parse error at the very end of the input, or input that does not even end like a JSON object, is a cut-off file.
    const truncated = /end of JSON|Unterminated|Unexpected end/i.test(message) || (at !== undefined && Number(at) >= text.length) || !/}\s*$/.test(text);
    throw new BundleError(truncated ? "bundle_truncated" : "bundle_malformed", truncated ? "bundle is truncated" : "bundle is not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new BundleError("bundle_malformed", "bundle must be a JSON object");
  const root = raw as Record<string, unknown>;
  if (root.kind !== BUNDLE_KIND) throw new BundleError("bundle_malformed", "not an AccessLease evidence bundle");
  if (root.schema_version !== BUNDLE_SCHEMA_VERSION) throw new BundleError("bundle_unsupported_version", `unsupported bundle schema_version ${JSON.stringify(root.schema_version)}`);
  const parsed = EvidenceBundleSchema.safeParse(raw);
  if (!parsed.success) throw new BundleError("bundle_schema_invalid", `bundle does not match its schema at ${parsed.error.issues[0]?.path.join(".") || "root"}`);
  const bundle = raw as EvidenceBundle;
  const paths = Object.keys(bundle.files);
  if (paths.length > maxFiles || bundle.manifest.files.length > maxFiles) throw new BundleError("bundle_too_many_files", `bundle exceeds ${maxFiles} files`);
  for (const path of [...paths, ...bundle.manifest.files.map((f) => f.path)]) {
    if (!PATH_RE.test(path)) throw new BundleError("bundle_unsafe_path", "bundle contains an unsafe or unknown file path");
  }
  const manifestPaths = bundle.manifest.files.map((f) => f.path);
  if (new Set(manifestPaths).size !== manifestPaths.length || manifestPaths.length !== paths.length || !manifestPaths.every((p) => Object.hasOwn(bundle.files, p))) {
    throw new BundleError("bundle_manifest_mismatch", "manifest and files disagree");
  }
  for (const entry of bundle.manifest.files) {
    const doc = bundle.files[entry.path];
    if (contentHash(doc) !== entry.sha256 || bytesOf(doc) !== entry.bytes) throw new BundleError("bundle_hash_mismatch", `file ${entry.path} does not match its recorded hash`);
  }
  if (contentHash(bundle.manifest.files) !== bundle.manifest.manifest_hash) throw new BundleError("bundle_hash_mismatch", "manifest hash mismatch");
  if (bundle.manifest.file_count !== manifestPaths.length || bundle.manifest.total_bytes !== bundle.manifest.files.reduce((n, f) => n + f.bytes, 0)) {
    throw new BundleError("bundle_manifest_mismatch", "manifest totals do not match");
  }
  const { bundle_hash: recorded, ...unhashed } = bundle;
  if (contentHash(unhashed) !== recorded) throw new BundleError("bundle_hash_mismatch", "bundle hash mismatch");

  // references: documents must be well formed and consistent with each other and with the bundle's workspace
  const summary = BundleSummarySchema.safeParse(bundle.files["summary.json"]);
  const policy = PolicySchema.safeParse(bundle.files["policy.json"]);
  if (!summary.success || !policy.success) throw new BundleError("bundle_schema_invalid", "summary.json or policy.json is invalid");
  const workspaceId = bundle.source.workspace_id;
  if (summary.data.workspace.id !== workspaceId || policy.data.workspace_id !== workspaceId) throw new BundleError("bundle_reference_broken", "workspace references disagree");
  const leaseDocs: Parsed["leaseDocs"] = new Map();
  for (const path of paths.filter((p) => p.startsWith("leases/"))) {
    const doc = LeaseEvidenceSchema.safeParse(bundle.files[path]);
    if (!doc.success) throw new BundleError("bundle_schema_invalid", `${path} does not match the lease evidence schema`);
    const lease = doc.data.lease;
    const id = path.slice("leases/".length, -".json".length);
    const consistent =
      lease.id === id &&
      lease.workspace_id === workspaceId &&
      lease.attempts.every((a) => a.lease_id === id) &&
      lease.audit.every((a) => a.lease_id === id) &&
      doc.data.events.every((e) => e.resource_id === id) &&
      (lease.provider_grant === null || lease.provider_grant.lease_id === id);
    if (!consistent) throw new BundleError("bundle_reference_broken", `${path} is internally inconsistent`);
    if (lease.state === "revoked_verified" && (!lease.last_verified_at || !lease.revoked_at || !lease.attempts.some((a) => a.result === "verified"))) {
      throw new BundleError("bundle_reference_broken", `${path} claims verified revocation without verification evidence`);
    }
    leaseDocs.set(id, doc.data);
  }
  if (JSON.stringify([...leaseDocs.keys()].sort()) !== JSON.stringify([...summary.data.lease_ids].sort())) {
    throw new BundleError("bundle_reference_broken", "summary.json does not list exactly the bundled leases");
  }
  return { bundle, leaseDocs };
}

/** Verify a bundle without a database or network (`accesslease verify-bundle`). Never throws for bad bundles. */
export function verifyBundle(bytes: Uint8Array, options: VerifyBundleOptions = {}): BundleVerification {
  try {
    const { bundle, leaseDocs } = parseAndVerify(bytes, options);
    return { ok: true, code: null, message: null, bundle_hash: bundle.bundle_hash, schema_version: bundle.schema_version, file_count: Object.keys(bundle.files).length, lease_count: leaseDocs.size };
  } catch (error) {
    if (!(error instanceof BundleError)) throw error;
    return { ok: false, code: error.code, message: error.message, bundle_hash: null, schema_version: null, file_count: 0, lease_count: 0 };
  }
}

/**
 * Restore a bundle into this installation (admin). Verification runs first and in full; the write is one transaction, so a
 * truncated, tampered or unsupported bundle leaves no partial state. Re-importing the same bundle is idempotent.
 */
export async function importBundle(ctx: Ctx, principal: Principal, bytes: Uint8Array, options: VerifyBundleOptions = {}): Promise<ImportReceipt> {
  requireRole(principal, "admin");
  let parsed: Parsed;
  try {
    parsed = parseAndVerify(bytes, { maxBytes: ctx.settings.importMaxMetadataBytes, maxFiles: ctx.settings.importMaxFiles, allowLarge: ctx.settings.importBlobCapBytes > 0, ...options });
  } catch (error) {
    if (error instanceof BundleError) throw new AppError(error.code === "bundle_too_large" ? 413 : 422, error.code, error.message);
    throw error;
  }
  const { bundle, leaseDocs } = parsed;
  const now = ctx.clock();
  return ctx.db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string; lease_count: number; imported_at: Date }>(
      "SELECT id, lease_count, imported_at FROM evidence_imports WHERE workspace_id = $1 AND bundle_hash = $2",
      [principal.workspaceId, bundle.bundle_hash],
    );
    const found = existing.rows[0];
    if (found) return { import_id: found.id, bundle_hash: bundle.bundle_hash, already_imported: true, lease_count: found.lease_count, imported_at: found.imported_at.toISOString() };
    const importId = newId();
    await tx.query(
      `INSERT INTO evidence_imports (id, workspace_id, bundle_hash, source_workspace_id, schema_version, exported_at, imported_at, imported_by, lease_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [importId, principal.workspaceId, bundle.bundle_hash, bundle.source.workspace_id, bundle.schema_version, bundle.exported_at, now, principal.actorRef, leaseDocs.size],
    );
    for (const leaseId of leaseDocs.keys()) {
      // Store the document exactly as bundled (not the schema-parsed copy) so its recorded hash stays verifiable on every read.
      const stored = bundle.files[`leases/${leaseId}.json`];
      await tx.query("INSERT INTO imported_leases (import_id, workspace_id, lease_id, doc, doc_hash) VALUES ($1,$2,$3,$4,$5)", [importId, principal.workspaceId, leaseId, JSON.stringify(stored), contentHash(stored)]);
    }
    await tx.query(
      `INSERT INTO audit_events (id, workspace_id, lease_id, actor_ref, action, occurred_at, redacted_metadata) VALUES ($1,$2,NULL,$3,'evidence.imported',$4,$5)`,
      [newId(), principal.workspaceId, principal.actorRef, now, JSON.stringify({ lease_count: leaseDocs.size, bundle_hash: bundle.bundle_hash })],
    );
    return { import_id: importId, bundle_hash: bundle.bundle_hash, already_imported: false, lease_count: leaseDocs.size, imported_at: now.toISOString() };
  });
}

export interface ImportRow {
  import_id: string;
  bundle_hash: string;
  source_workspace_id: string;
  schema_version: number;
  exported_at: string;
  imported_at: string;
  imported_by: string;
  lease_count: number;
}

/** `GET /imports`: restored bundles of this workspace. */
export async function listImports(ctx: Ctx, principal: Principal): Promise<ImportRow[]> {
  requireRole(principal, "viewer");
  const rows = await ctx.db.query<{ id: string; bundle_hash: string; source_workspace_id: string; schema_version: number; exported_at: Date; imported_at: Date; imported_by: string; lease_count: number }>(
    "SELECT id, bundle_hash, source_workspace_id, schema_version, exported_at, imported_at, imported_by, lease_count FROM evidence_imports WHERE workspace_id = $1 ORDER BY imported_at DESC, id LIMIT 100",
    [principal.workspaceId],
  );
  return rows.rows.map((r) => ({
    import_id: r.id,
    bundle_hash: r.bundle_hash,
    source_workspace_id: r.source_workspace_id,
    schema_version: r.schema_version,
    exported_at: r.exported_at.toISOString(),
    imported_at: r.imported_at.toISOString(),
    imported_by: r.imported_by,
    lease_count: r.lease_count,
  }));
}

/** Read one restored lease; the stored document hash is re-verified on every read. */
export async function getImportedLease(ctx: Ctx, principal: Principal, importId: string, leaseId: string) {
  requireRole(principal, "viewer");
  if (!isUuid(importId) || !isUuid(leaseId)) throw notFound();
  const row = (
    await ctx.db.query<{ doc: unknown; doc_hash: string }>("SELECT doc, doc_hash FROM imported_leases WHERE workspace_id = $1 AND import_id = $2 AND lease_id = $3", [
      principal.workspaceId,
      importId.toLowerCase(),
      leaseId.toLowerCase(),
    ])
  ).rows[0];
  if (!row) throw notFound();
  if (contentHash(row.doc) !== row.doc_hash) throw fail("bundle_hash_mismatch", "stored evidence no longer matches its recorded hash");
  return { import_id: importId, lease_id: leaseId, hash_verified: true, evidence: row.doc };
}

export { providerLabel };
