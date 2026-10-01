import type { Provider } from "../connectors/provider.js";
import type { Ctx } from "../context.js";
import { contentHash } from "../crypto.js";
import type { Queryable } from "../db/index.js";
import { genericScopeCheck, normalizeScopes } from "../domain/scopes.js";
import { PolicyUpdateSchema } from "../domain/schemas.js";
import { ABSOLUTE_MAX_TTL_SECONDS, DEFAULT_APPROVAL_TTL_SECONDS, type Policy, type Principal } from "../domain/types.js";
import { conflict, unprocessable } from "../errors.js";
import { audit } from "./audit.js";
import { requireRole } from "./roles.js";
import { iso, isoRequired } from "./rows.js";

/** The rules that make up the policy hash (retention is operational, not part of a lease plan). */
export interface PolicyRules {
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  min_ttl_seconds: number;
  approval_ttl_seconds: number;
  scope_allow_prefixes: string[];
  scope_deny_prefixes: string[];
}

export const policyHashOf = (rules: PolicyRules): string =>
  contentHash({
    ...rules,
    scope_allow_prefixes: [...rules.scope_allow_prefixes].sort(),
    scope_deny_prefixes: [...rules.scope_deny_prefixes].sort(),
  });

interface PolicyRow extends PolicyRules {
  workspace_id: string;
  retention_days: number;
  version: number;
  policy_hash: string;
  updated_at: Date;
  updated_by: string | null;
}

const toPolicy = (row: PolicyRow): Policy => ({
  schema_version: 1,
  workspace_id: row.workspace_id,
  default_ttl_seconds: row.default_ttl_seconds,
  max_ttl_seconds: row.max_ttl_seconds,
  min_ttl_seconds: row.min_ttl_seconds,
  approval_ttl_seconds: row.approval_ttl_seconds,
  retention_days: row.retention_days,
  scope_allow_prefixes: row.scope_allow_prefixes,
  scope_deny_prefixes: row.scope_deny_prefixes,
  version: row.version,
  policy_hash: row.policy_hash,
  updated_at: isoRequired(row.updated_at),
  updated_by: row.updated_by,
});

export async function createDefaultPolicy(
  tx: Queryable,
  workspaceId: string,
  defaults: { defaultTtlSeconds: number; maxTtlSeconds: number; minTtlSeconds: number; retentionDays: number },
  at: Date,
): Promise<void> {
  const rules: PolicyRules = {
    default_ttl_seconds: defaults.defaultTtlSeconds,
    max_ttl_seconds: defaults.maxTtlSeconds,
    min_ttl_seconds: defaults.minTtlSeconds,
    approval_ttl_seconds: DEFAULT_APPROVAL_TTL_SECONDS,
    scope_allow_prefixes: [],
    scope_deny_prefixes: [],
  };
  await tx.query(
    `INSERT INTO policies (workspace_id, default_ttl_seconds, max_ttl_seconds, min_ttl_seconds, approval_ttl_seconds, retention_days,
                           scope_allow_prefixes, scope_deny_prefixes, version, policy_hash, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)`,
    [workspaceId, rules.default_ttl_seconds, rules.max_ttl_seconds, rules.min_ttl_seconds, rules.approval_ttl_seconds, defaults.retentionDays, [], [], policyHashOf(rules), at],
  );
}

export async function loadPolicy(db: Queryable, workspaceId: string): Promise<Policy> {
  const result = await db.query<PolicyRow>("SELECT * FROM policies WHERE workspace_id = $1", [workspaceId]);
  const row = result.rows[0];
  if (!row) throw new Error("policy row missing for workspace");
  return toPolicy(row);
}

export async function getPolicy(ctx: Ctx, principal: Principal): Promise<Policy> {
  requireRole(principal, "viewer");
  return loadPolicy(ctx.db, principal.workspaceId);
}

function validateRules(rules: PolicyRules & { retention_days: number }): void {
  const fail = (message: string) => unprocessable("policy_invalid", message);
  if (rules.max_ttl_seconds > ABSOLUTE_MAX_TTL_SECONDS) throw fail(`max_ttl_seconds must not exceed ${ABSOLUTE_MAX_TTL_SECONDS}`);
  if (rules.min_ttl_seconds > rules.default_ttl_seconds || rules.default_ttl_seconds > rules.max_ttl_seconds) {
    throw fail("TTL values must satisfy min <= default <= max");
  }
  if (rules.approval_ttl_seconds > 86_400) throw fail("approval_ttl_seconds must not exceed 86400");
  for (const prefix of [...rules.scope_allow_prefixes, ...rules.scope_deny_prefixes]) {
    if (!/^[\x21-\x7e]{1,200}$/.test(prefix) || /[*%?]/.test(prefix)) throw fail("scope prefixes must be literal printable text without wildcards");
  }
}

/** Admin-only policy change (AC-01: TTL default/max and scope rules are configurable only by admins). */
export async function setPolicy(ctx: Ctx, principal: Principal, input: unknown): Promise<Policy> {
  requireRole(principal, "admin");
  const parsed = PolicyUpdateSchema.safeParse(input);
  if (!parsed.success) throw unprocessable("validation_failed", `Invalid policy update: ${parsed.error.issues.map((i) => i.path.join(".") || "body").join(", ")}`);
  const update = parsed.data;
  const at = ctx.clock();
  return ctx.db.transaction(async (tx) => {
    const current = (await tx.query<PolicyRow>("SELECT * FROM policies WHERE workspace_id = $1 FOR UPDATE", [principal.workspaceId])).rows[0];
    if (!current) throw new Error("policy row missing for workspace");
    if (update.expected_version !== undefined && update.expected_version !== current.version) throw conflict("version_conflict", "Policy was changed by someone else");
    const next = {
      default_ttl_seconds: update.default_ttl_seconds ?? current.default_ttl_seconds,
      max_ttl_seconds: update.max_ttl_seconds ?? current.max_ttl_seconds,
      min_ttl_seconds: update.min_ttl_seconds ?? current.min_ttl_seconds,
      approval_ttl_seconds: update.approval_ttl_seconds ?? current.approval_ttl_seconds,
      retention_days: update.retention_days ?? current.retention_days,
      scope_allow_prefixes: update.scope_allow_prefixes ?? current.scope_allow_prefixes,
      scope_deny_prefixes: update.scope_deny_prefixes ?? current.scope_deny_prefixes,
    };
    validateRules(next);
    const hash = policyHashOf(next);
    const result = await tx.query<PolicyRow>(
      `UPDATE policies SET default_ttl_seconds=$2, max_ttl_seconds=$3, min_ttl_seconds=$4, approval_ttl_seconds=$5, retention_days=$6,
              scope_allow_prefixes=$7, scope_deny_prefixes=$8, version = version + 1, policy_hash=$9, updated_at=$10, updated_by=$11
        WHERE workspace_id=$1 RETURNING *`,
      [
        principal.workspaceId,
        next.default_ttl_seconds,
        next.max_ttl_seconds,
        next.min_ttl_seconds,
        next.approval_ttl_seconds,
        next.retention_days,
        next.scope_allow_prefixes,
        next.scope_deny_prefixes,
        hash,
        at,
        principal.userId,
      ],
    );
    await audit(tx, {
      workspaceId: principal.workspaceId,
      leaseId: null,
      actorRef: principal.actorRef,
      action: "policy.updated",
      at,
      metadata: { changed: Object.keys(update).filter((k) => k !== "expected_version").join(","), policy_hash: hash },
    });
    return toPolicy(result.rows[0] as PolicyRow);
  });
}

export interface PlanFields {
  task_ref: string;
  subject_ref: string;
  resource_ref: string;
  scopes: readonly string[];
  expires_at: Date | string;
  policy_hash: string;
}

/**
 * plan_hash = SHA-256 of the canonical JSON of {task_ref, subject_ref, resource_ref, scopes (sorted, unique),
 * expires_at (UTC ISO, ms), policy_hash}. Approval binds this hash (AC-02).
 */
export function computePlanHash(plan: PlanFields): string {
  return contentHash({
    task_ref: plan.task_ref,
    subject_ref: plan.subject_ref,
    resource_ref: plan.resource_ref,
    scopes: normalizeScopes(plan.scopes),
    expires_at: new Date(plan.expires_at).toISOString(),
    policy_hash: plan.policy_hash,
  });
}

export interface Evaluation {
  policy: Pick<Policy, "min_ttl_seconds" | "max_ttl_seconds" | "scope_allow_prefixes" | "scope_deny_prefixes">;
  provider: Provider;
  resource: string;
  scopes: readonly string[];
  expiresAt: Date;
  now: Date;
  /** Approval-time check: the remaining TTL may be shorter than the minimum only up to the clock (expired is rejected). */
  remaining?: boolean;
}

/** Policy decision (AC-01). Throws an AppError (422) before any provider is contacted for writes. */
export function evaluateLease(input: Evaluation): void {
  const resource = input.provider.validateResource(input.resource);
  if (!resource.ok) throw unprocessable("invalid_scope", resource.message);
  for (const scope of input.scopes) {
    const generic = genericScopeCheck(scope);
    if (!generic.ok) throw unprocessable(generic.code, generic.message);
    const specific = input.provider.validateScope(scope);
    if (!specific.ok) throw unprocessable(specific.code, specific.message);
    if (input.policy.scope_deny_prefixes.some((prefix) => scope.startsWith(prefix))) throw unprocessable("scope_forbidden", "scope is denied by workspace policy");
    if (input.policy.scope_allow_prefixes.length > 0 && !input.policy.scope_allow_prefixes.some((prefix) => scope.startsWith(prefix))) {
      throw unprocessable("scope_forbidden", "scope is not on the workspace allow list");
    }
  }
  const ttlSeconds = (input.expiresAt.getTime() - input.now.getTime()) / 1000;
  if (ttlSeconds <= 0) throw unprocessable("expires_in_past", "expires_at must be in the future");
  if (ttlSeconds > input.policy.max_ttl_seconds) throw unprocessable("ttl_exceeds_max", `TTL exceeds the policy maximum of ${input.policy.max_ttl_seconds} seconds`);
  if (!input.remaining && ttlSeconds < input.policy.min_ttl_seconds) throw unprocessable("ttl_below_min", `TTL is below the policy minimum of ${input.policy.min_ttl_seconds} seconds`);
}

