import { newId } from "../lib/ids.js";
import { ProviderUnavailableError } from "../connectors/provider.js";
import type { Ctx } from "../context.js";
import { addSeconds } from "../context.js";
import { safeEqual } from "../crypto.js";
import type { Queryable } from "../db/index.js";
import { ApproveRequestSchema, CloseRequestSchema, LeaseRequestSchema, ListQuerySchema, RevokeRequestSchema } from "../domain/schemas.js";
import { normalizeScopes } from "../domain/scopes.js";
import {
  type AuditEventRecord,
  type CredentialDelivery,
  LIST_MAX_LIMIT,
  type LeaseDetail,
  type LeaseState,
  toWireState,
  type WireLeaseState,
  type LeaseView,
  type Page,
  type Principal,
  type ProviderGrantRecord,
  type RevocationAttemptRecord,
} from "../domain/types.js";
import { AppError, conflict, notFound, unavailable, unprocessable } from "../errors.js";
import { registerSecret, redactText } from "../lib/redact.js";
import { audit, auditAndEmit } from "./audit.js";
import { isUuid } from "./auth.js";
import { type Mutated, mutate } from "./idempotency.js";
import { enqueueJob } from "./jobs.js";
import { lockLease, startRevocation, transition } from "./lifecycle.js";
import { computePlanHash, evaluateLease, loadPolicy } from "./policy.js";
import { requireRole } from "./roles.js";
import { type ApprovalRow, type GrantRow, iso, isoRequired, type LeaseRow, providerLabel, toLeaseView } from "./rows.js";
import type { LeaseReceipt, MutationOptions } from "./contract.js";

const POLICY_CODES = new Set(["invalid_scope", "scope_wildcard", "scope_forbidden", "ttl_exceeds_max", "ttl_below_min", "expires_in_past"]);

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).slice(0, 5);
    throw unprocessable("validation_failed", `Invalid request: ${where.join("; ")}`);
  }
  return parsed.data;
}

function leaseIdOrNotFound(id: string): string {
  if (!isUuid(id)) throw notFound();
  return id.toLowerCase();
}

async function viewOf(db: Queryable, row: LeaseRow): Promise<LeaseView> {
  const approval = (await db.query<ApprovalRow>("SELECT * FROM approvals WHERE lease_id = $1", [row.id])).rows[0] ?? null;
  const secret = (await db.query<{ credential_ct: string | null }>("SELECT credential_ct FROM lease_secrets WHERE lease_id = $1", [row.id])).rows[0];
  return toLeaseView(row, { approval, credentialAvailable: row.state === "ACTIVE" && Boolean(secret?.credential_ct) });
}

async function receipt(db: Queryable, row: LeaseRow): Promise<LeaseReceipt> {
  return { id: row.id, state: toWireState(row.state), plan_hash: row.plan_hash, lease: await viewOf(db, row), replayed: false };
}

const withReplay = (mutated: Mutated<LeaseReceipt>): LeaseReceipt & { http_status: number } => ({
  ...mutated.body,
  replayed: mutated.replayed,
  http_status: mutated.status,
});

/** `POST /leases` (AC-01). Returns the receipt; `http_status` is 201. */
export async function requestLease(ctx: Ctx, principal: Principal, input: unknown, options: MutationOptions = {}): Promise<LeaseReceipt & { http_status: number }> {
  requireRole(principal, "operator");
  const data = parseOrThrow(LeaseRequestSchema, input);
  const provider = ctx.providers.get(ctx.providers.defaultKind);
  if (!provider) throw unavailable("provider_unavailable", `provider ${ctx.providers.defaultKind} is not configured`);
  if (!provider.capabilities().nativeTtl) throw unprocessable("provider_no_native_ttl", `provider ${provider.kind} has no native TTL and is refused`);
  // Intake redaction: token-shaped values never reach storage, logs, exports or reports (AC-09).
  const refs = {
    task_ref: redactText(data.task_ref).trim(),
    subject_ref: redactText(data.subject_ref).trim(),
    resource_ref: redactText(data.resource_ref).trim(),
  };
  if (!refs.task_ref || !refs.subject_ref || !refs.resource_ref) throw unprocessable("validation_failed", "Invalid request: refs must not be empty");
  const scopes = normalizeScopes(data.scopes.map((s) => redactText(s).trim()));
  try {
    const mutated = await mutate<LeaseReceipt>(ctx, principal, "POST /leases", options.idempotencyKey, data, 201, async (tx) => {
      const now = ctx.clock();
      const policy = await loadPolicy(tx, principal.workspaceId);
      const expiresAt = data.expires_at ? new Date(data.expires_at) : addSeconds(now, policy.default_ttl_seconds);
      evaluateLease({ policy, provider, resource: refs.resource_ref, scopes, expiresAt, now });
      const id = newId();
      const planHash = computePlanHash({ ...refs, scopes, expires_at: expiresAt, policy_hash: policy.policy_hash });
      const inserted = await tx.query<LeaseRow>(
        `INSERT INTO leases (id, workspace_id, task_ref, subject_ref, resource_ref, scopes, expires_at, policy_hash, plan_hash, state, version,
                             provider_kind, requested_by_ref, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUESTED',1,$10,$11,$12,$12) RETURNING *`,
        [id, principal.workspaceId, refs.task_ref, refs.subject_ref, refs.resource_ref, JSON.stringify(scopes), expiresAt, policy.policy_hash, planHash, provider.kind, principal.actorRef, now],
      );
      const row = inserted.rows[0] as LeaseRow;
      await auditAndEmit(
        tx,
        {
          workspaceId: row.workspace_id,
          leaseId: row.id,
          actorRef: principal.actorRef,
          action: "lease.requested",
          at: now,
          metadata: { to: "REQUESTED", version: 1, provider: provider.kind, expires_at: row.expires_at.toISOString(), plan_hash: planHash },
        },
        { workspaceId: row.workspace_id, leaseId: row.id, type: "lease.requested", at: now, revision: 1 },
      );
      return { id: row.id, state: toWireState(row.state), plan_hash: row.plan_hash, lease: toLeaseView(row, { approval: null, credentialAvailable: false }), replayed: false };
    });
    return withReplay(mutated);
  } catch (error) {
    if (error instanceof AppError && POLICY_CODES.has(error.code)) {
      // Rejections are visible in the audit trail (code only; never the rejected content).
      await audit(ctx.db, { workspaceId: principal.workspaceId, leaseId: null, actorRef: principal.actorRef, action: "policy.rejected", at: ctx.clock(), metadata: { code: error.code } });
    }
    throw error;
  }
}

/** Ping a live provider before accepting work that needs it (AC-08: live operations fail explicitly when disconnected). */
async function requireProviderConnected(ctx: Ctx, kind: LeaseRow["provider_kind"]): Promise<void> {
  const provider = ctx.providers.get(kind);
  if (!provider) throw unavailable("provider_unavailable", `provider ${kind} is not configured`);
  // AC-03: only provider-enforced expiry is acceptable; local scheduling alone never is.
  if (!provider.capabilities().nativeTtl) throw unprocessable("provider_no_native_ttl", `provider ${kind} has no native TTL and is refused`);
  if (!providerLabel(kind).live) return;
  try {
    await provider.ping();
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw unavailable("provider_unavailable", `provider ${kind} is disconnected: ${error.code}`);
    throw error;
  }
}

async function readLease(db: Queryable, principal: Principal, id: string): Promise<LeaseRow> {
  const row = (await db.query<LeaseRow>("SELECT * FROM leases WHERE id = $1 AND workspace_id = $2", [id, principal.workspaceId])).rows[0];
  if (!row) throw notFound();
  return row;
}

function checkVersion(row: LeaseRow, expected: number | undefined): void {
  if (expected !== undefined && expected !== row.version) throw conflict("version_conflict", `Lease is at version ${row.version}, not ${expected}`);
}

/** `POST /leases/{id}/approve` (AC-02). Binds approval to the exact plan hash; `http_status` is 202. */
export async function approveLease(ctx: Ctx, principal: Principal, leaseId: string, input: unknown, options: MutationOptions = {}): Promise<LeaseReceipt & { http_status: number }> {
  requireRole(principal, "operator");
  const id = leaseIdOrNotFound(leaseId);
  const data = parseOrThrow(ApproveRequestSchema, input);
  const existing = await readLease(ctx.db, principal, id);
  // Replays of a completed approval must not depend on the provider being reachable now.
  if (existing.state === "REQUESTED") await requireProviderConnected(ctx, existing.provider_kind);
  const mutated = await mutate<LeaseReceipt>(ctx, principal, `POST /leases/{id}/approve:${id}`, options.idempotencyKey, data, 202, async (tx) => {
    const lease = await lockLease(tx, id, principal.workspaceId);
    if (!lease) throw notFound();
    checkVersion(lease, data.expected_version ?? options.expectedVersion);
    if (lease.state !== "REQUESTED") throw conflict("invalid_transition", `Lease is ${lease.state}; only a REQUESTED lease can be approved`);
    if (!safeEqual(lease.plan_hash, data.plan_hash)) throw conflict("plan_hash_mismatch", "plan_hash does not match the lease; approval must bind the exact plan");
    const now = ctx.clock();
    const policy = await loadPolicy(tx, principal.workspaceId);
    if (policy.policy_hash !== lease.policy_hash) throw conflict("stale_plan", "The workspace policy changed after this request; submit a new request");
    const remaining = (lease.expires_at.getTime() - now.getTime()) / 1000;
    if (remaining < policy.min_ttl_seconds) throw conflict("stale_plan", "The lease expires too soon to approve; submit a new request");
    const approvalExpires = new Date(Math.min(addSeconds(now, policy.approval_ttl_seconds).getTime(), lease.expires_at.getTime()));
    const approval: ApprovalRow = {
      id: newId(),
      workspace_id: lease.workspace_id,
      lease_id: lease.id,
      actor_id: principal.userId,
      actor_ref: principal.actorRef,
      plan_hash: lease.plan_hash,
      approved_at: now,
      expires_at: approvalExpires,
    };
    await tx.query(`INSERT INTO approvals (id, workspace_id, lease_id, actor_id, actor_ref, plan_hash, approved_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      approval.id,
      approval.workspace_id,
      approval.lease_id,
      approval.actor_id,
      approval.actor_ref,
      approval.plan_hash,
      approval.approved_at,
      approval.expires_at,
    ]);
    const updated = await transition(tx, lease, "APPROVED", {
      at: now,
      actorRef: principal.actorRef,
      action: "lease.approved",
      metadata: { plan_hash: lease.plan_hash, approval_expires_at: approvalExpires.toISOString() },
    });
    await enqueueJob(tx, { workspaceId: lease.workspace_id, leaseId: lease.id, type: "issue", at: now, dedupKey: `issue:${lease.id}` });
    return { id: updated.id, state: toWireState(updated.state), plan_hash: updated.plan_hash, lease: toLeaseView(updated, { approval, credentialAvailable: false }), replayed: false };
  });
  return withReplay(mutated);
}

async function closeOrRevoke(
  ctx: Ctx,
  principal: Principal,
  leaseId: string,
  input: unknown,
  options: MutationOptions,
  kind: "revoke" | "close",
): Promise<LeaseReceipt & { http_status: number }> {
  requireRole(principal, "operator");
  const id = leaseIdOrNotFound(leaseId);
  const data = parseOrThrow(kind === "revoke" ? RevokeRequestSchema : CloseRequestSchema, input ?? {}) as { reason?: string; expected_version?: number };
  const reason = redactText(data.reason ?? (kind === "revoke" ? "operator revocation" : "task closed")).slice(0, 500);
  const route = `POST /leases/{id}/${kind}:${id}`;
  const mutated = await mutate<LeaseReceipt>(ctx, principal, route, options.idempotencyKey, data, 202, async (tx) => {
    const lease = await lockLease(tx, id, principal.workspaceId);
    if (!lease) throw notFound();
    checkVersion(lease, data.expected_version ?? options.expectedVersion);
    const now = ctx.clock();
    if (lease.state === "REVOKED_VERIFIED" || lease.state === "REVOKING") return receipt(tx, lease);
    if (lease.state === "REVOCATION_UNCONFIRMED") {
      // Operator asked again: retry immediately instead of waiting for next_retry_at. State is unchanged.
      const updated = await transition(tx, lease, "REVOCATION_UNCONFIRMED", {
        at: now,
        actorRef: principal.actorRef,
        action: "revocation.retry_requested",
        patch: { next_retry_at: now },
        emit: false,
      });
      await tx.query("UPDATE jobs SET next_attempt_at = $2, updated_at = $2 WHERE lease_id = $1 AND type = 'revoke' AND state = 'queued'", [lease.id, now]);
      return receipt(tx, updated);
    }
    const updated = await startRevocation(tx, lease, {
      reason: kind === "revoke" ? "operator_revoked" : "task_closed",
      detail: reason,
      at: now,
      actorRef: principal.actorRef,
      action: kind === "revoke" ? "lease.revoke_requested" : "lease.close_requested",
    });
    return receipt(tx, updated);
  });
  return withReplay(mutated);
}

/** `POST /leases/{id}/revoke` (AC-04): enter REVOKING and queue verification. `http_status` is 202. */
export const revokeLease = (ctx: Ctx, principal: Principal, leaseId: string, input: unknown, options: MutationOptions = {}) =>
  closeOrRevoke(ctx, principal, leaseId, input, options, "revoke");

/** `POST /leases/{id}/close` (AC-04, task closure). `http_status` is 202. */
export const closeLease = (ctx: Ctx, principal: Principal, leaseId: string, input: unknown, options: MutationOptions = {}) =>
  closeOrRevoke(ctx, principal, leaseId, input, options, "close");

/**
 * Bulk loader for lease detail documents (report, export, single read): a fixed number of queries regardless of how many
 * leases are requested, workspace-scoped. Order follows `ids`; leases that do not exist (or are foreign) are skipped.
 */
export async function loadDetails(db: Queryable, workspaceId: string, ids: string[]): Promise<LeaseDetail[]> {
  if (ids.length === 0) return [];
  const rows = (await db.query<LeaseRow>("SELECT * FROM leases WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, ids])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const present = rows.map((r) => r.id);
  const approvals = new Map((await db.query<ApprovalRow>("SELECT * FROM approvals WHERE lease_id = ANY($1::uuid[])", [present])).rows.map((a) => [a.lease_id, a]));
  const withSecret = new Set((await db.query<{ lease_id: string }>("SELECT lease_id FROM lease_secrets WHERE lease_id = ANY($1::uuid[]) AND credential_ct IS NOT NULL", [present])).rows.map((r) => r.lease_id));
  const grants = new Map((await db.query<GrantRow>("SELECT * FROM provider_grants WHERE lease_id = ANY($1::uuid[])", [present])).rows.map((g) => [g.lease_id, g]));
  const attempts = await db.query<{ id: string; lease_id: string; attempt_no: number; attempted_at: Date; result: RevocationAttemptRecord["result"]; verification_ref: string; detail: Record<string, unknown>; next_retry_at: Date | null }>(
    "SELECT id, lease_id, attempt_no, attempted_at, result, verification_ref, detail, next_retry_at FROM revocation_attempts WHERE lease_id = ANY($1::uuid[]) ORDER BY lease_id, attempt_no",
    [present],
  );
  const audits = await db.query<{ id: string; seq: number; lease_id: string; actor_ref: string; action: string; occurred_at: Date; redacted_metadata: Record<string, unknown> }>(
    "SELECT id, seq, lease_id, actor_ref, action, occurred_at, redacted_metadata FROM audit_events WHERE lease_id = ANY($1::uuid[]) ORDER BY seq",
    [present],
  );
  const attemptsBy = new Map<string, RevocationAttemptRecord[]>();
  for (const a of attempts.rows) {
    const list = attemptsBy.get(a.lease_id) ?? [];
    if (list.length < 1000) list.push({ id: a.id, lease_id: a.lease_id, attempt_no: a.attempt_no, attempted_at: isoRequired(a.attempted_at), result: a.result, verification_ref: a.verification_ref, detail: a.detail, next_retry_at: iso(a.next_retry_at) });
    attemptsBy.set(a.lease_id, list);
  }
  const auditBy = new Map<string, AuditEventRecord[]>();
  for (const e of audits.rows) {
    const list = auditBy.get(e.lease_id) ?? [];
    if (list.length < 1000) list.push({ id: e.id, seq: e.seq, lease_id: e.lease_id, actor_ref: e.actor_ref, action: e.action, occurred_at: isoRequired(e.occurred_at), metadata: e.redacted_metadata });
    auditBy.set(e.lease_id, list);
  }
  const out: LeaseDetail[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const grant = grants.get(id);
    const providerGrant: ProviderGrantRecord | null = grant
      ? {
          id: grant.id,
          lease_id: grant.lease_id,
          provider_kind: grant.provider_kind,
          provider_ref: grant.provider_ref,
          label: providerLabel(grant.provider_kind).label,
          issued_at: iso(grant.issued_at),
          valid_until: iso(grant.valid_until),
          revoked_at: iso(grant.revoked_at),
          status: grant.status,
        }
      : null;
    out.push({
      ...toLeaseView(row, { approval: approvals.get(id) ?? null, credentialAvailable: row.state === "ACTIVE" && withSecret.has(id) }),
      provider_grant: providerGrant,
      attempts: attemptsBy.get(id) ?? [],
      audit: auditBy.get(id) ?? [],
    });
  }
  return out;
}

export async function loadDetail(db: Queryable, workspaceId: string, id: string): Promise<LeaseDetail> {
  const detail = (await loadDetails(db, workspaceId, [id]))[0];
  if (!detail) throw notFound();
  return detail;
}

/** `GET /leases/{id}`: viewer and above. Foreign or missing ids are an identical 404. */
export async function getLease(ctx: Ctx, principal: Principal, leaseId: string): Promise<LeaseDetail> {
  requireRole(principal, "viewer");
  return loadDetail(ctx.db, principal.workspaceId, leaseIdOrNotFound(leaseId));
}

const encodeCursor = (row: LeaseRow) => Buffer.from(JSON.stringify([row.created_at.toISOString(), row.id])).toString("base64url");
function decodeCursor(cursor: string): [string, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" && isUuid(parsed[1]) && !Number.isNaN(Date.parse(parsed[0]))) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  throw unprocessable("validation_failed", "Invalid cursor");
}

/** `GET /leases`: newest first, cursor pagination, capped at 100 entries. */
export async function listLeases(ctx: Ctx, principal: Principal, query: { state?: LeaseState | WireLeaseState; cursor?: string; limit?: number } = {}): Promise<Page<LeaseView>> {
  requireRole(principal, "viewer");
  // the state filter uses the wire spelling (lowercase); the internal UPPER_SNAKE spelling is tolerated
  const q = parseOrThrow(ListQuerySchema, { ...query, state: typeof query.state === "string" ? query.state.toLowerCase() : query.state });
  const limit = Math.min(q.limit ?? 50, LIST_MAX_LIMIT);
  const params: unknown[] = [principal.workspaceId];
  let where = "workspace_id = $1";
  if (q.state) {
    params.push(q.state.toUpperCase());
    where += ` AND state = $${params.length}`;
  }
  if (q.cursor) {
    const [createdAt, id] = decodeCursor(q.cursor);
    params.push(createdAt, id);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = (await ctx.db.query<LeaseRow>(`SELECT * FROM leases WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params)).rows;
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map((row) => viewOf(ctx.db, row)));
  return { items, next_cursor: rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1] as LeaseRow) : null };
}

/**
 * `POST /leases/{id}/credential`: one-time retrieval. Allowed only while ACTIVE; the secret is decrypted for this
 * response and purged in the same transaction. Never logged, audited, exported or evented.
 */
export async function retrieveCredential(ctx: Ctx, principal: Principal, leaseId: string): Promise<CredentialDelivery> {
  requireRole(principal, "operator");
  const id = leaseIdOrNotFound(leaseId);
  return ctx.db.transaction(async (tx) => {
    const lease = await lockLease(tx, id, principal.workspaceId);
    if (!lease) throw notFound();
    const now = ctx.clock();
    if (lease.state !== "ACTIVE") throw conflict("credential_unavailable", `A credential can only be retrieved while the lease is ACTIVE (state ${lease.state})`);
    const secret = (await tx.query<{ credential_ct: string | null; credential_retrieved_at: Date | null }>("SELECT credential_ct, credential_retrieved_at FROM lease_secrets WHERE lease_id = $1 FOR UPDATE", [id])).rows[0];
    if (!secret) throw conflict("credential_unavailable", "No credential exists for this lease");
    if (!secret.credential_ct) throw conflict(secret.credential_retrieved_at ? "credential_already_retrieved" : "credential_unavailable", "The credential was already retrieved or has been purged");
    const grant = (await tx.query<GrantRow>("SELECT * FROM provider_grants WHERE lease_id = $1", [id])).rows[0];
    if (!grant || grant.status !== "issued" || !grant.conn_host || !grant.conn_port || !grant.conn_database || !grant.conn_username) {
      throw conflict("credential_unavailable", "The provider grant is not issued");
    }
    const plaintext = ctx.key.decrypt(`credential:${id}`, secret.credential_ct);
    registerSecret(plaintext);
    await tx.query("UPDATE lease_secrets SET credential_ct = NULL, credential_retrieved_at = $2, purged_at = $2 WHERE lease_id = $1", [id, now]);
    await audit(tx, { workspaceId: lease.workspace_id, leaseId: lease.id, actorRef: principal.actorRef, action: "credential.retrieved", at: now });
    return {
      lease_id: lease.id,
      provider: providerLabel(lease.provider_kind),
      expires_at: isoRequired(lease.expires_at),
      credential: { kind: lease.provider_kind, host: grant.conn_host, port: grant.conn_port, database: grant.conn_database, username: grant.conn_username, secret: plaintext },
      delivered_at: now.toISOString(),
    };
  });
}
