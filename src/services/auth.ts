import { newId } from "../lib/ids.js";
import type { Ctx } from "../context.js";
import { addSeconds } from "../context.js";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../crypto.js";
import type { Queryable } from "../db/index.js";
import type { Principal, Role } from "../domain/types.js";
import { conflict, notFound, unauthorized, unprocessable } from "../errors.js";
import { audit } from "./audit.js";
import type { BootstrapInput, BootstrapResult } from "./contract.js";
import { createDefaultPolicy } from "./policy.js";
import { requireRole } from "./roles.js";

export type { Principal, Role };
export { requireRole };

export const SESSION_COOKIE = "accesslease_session";
// Precomputed so an unknown account still costs one scrypt comparison.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);

export async function createWorkspace(tx: Queryable, ctx: Pick<Ctx, "settings">, name: string, at: Date): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw unprocessable("validation_failed", "Workspace name must be 1-200 characters");
  const id = newId();
  await tx.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1,$2,$3)", [id, trimmed, at]);
  await createDefaultPolicy(tx, id, ctx.settings.initialPolicy, at);
  return id;
}

/**
 * Create (or reuse) a user and grant a workspace role. Only the CLI bootstrap, the admin-only members route
 * and the synthetic demo seeder call this: no open registration, no default password.
 */
export async function grantUser(tx: Queryable, input: { workspaceId: string; email: string; password: string; role: Role; at: Date }): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) throw unprocessable("validation_failed", "A valid email is required");
  if (input.password.length < 12) throw unprocessable("validation_failed", "Passwords need at least 12 characters");
  if (!["admin", "operator", "viewer"].includes(input.role)) throw unprocessable("validation_failed", "Role must be admin, operator or viewer");
  const existing = await tx.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    userId = newId();
    await tx.query("INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", [userId, email, await hashPassword(input.password), input.at]);
  }
  const member = await tx.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [input.workspaceId, userId]);
  if (member.rows.length > 0) throw conflict("already_member", "User is already a member of this workspace");
  await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)", [input.workspaceId, userId, input.role]);
  return userId;
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  principal: Principal;
}

const userPrincipal = (row: { id: string; email: string; workspace_id: string; role: Role; name: string; sessionId: string }): Principal => ({
  actorRef: `user:${row.id}`,
  userId: row.id,
  email: row.email,
  workspaceId: row.workspace_id,
  workspaceName: row.name,
  role: row.role,
  sessionId: row.sessionId,
});

export async function login(ctx: Ctx, email: string, password: string, workspaceId?: string): Promise<LoginResult> {
  const now = ctx.clock();
  const user = await ctx.db.query<{ id: string; email: string; password_hash: string }>("SELECT id, email, password_hash FROM users WHERE email = $1", [
    email.trim().toLowerCase(),
  ]);
  const row = user.rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) throw unauthorized("invalid_credentials", "Email or password is incorrect");
  const memberships = await ctx.db.query<{ workspace_id: string; role: Role; name: string }>(
    `SELECT m.workspace_id, m.role, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 ORDER BY w.name, w.id`,
    [row.id],
  );
  const membership = workspaceId ? memberships.rows.find((m) => m.workspace_id === workspaceId) : memberships.rows[0];
  if (!membership) throw unauthorized("invalid_credentials", "Email or password is incorrect");
  const token = randomToken();
  const sessionId = newId();
  await ctx.db.query("INSERT INTO sessions (id, token_hash, user_id, workspace_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [
    sessionId,
    sha256Hex(token),
    row.id,
    membership.workspace_id,
    now,
    addSeconds(now, ctx.settings.sessionTtlSeconds),
  ]);
  return {
    token,
    csrfToken: csrfFor(ctx, token),
    principal: userPrincipal({ id: row.id, email: row.email, workspace_id: membership.workspace_id, role: membership.role, name: membership.name, sessionId }),
  };
}

/** CSRF token bound to the session token with the server key; recomputable after reload. */
export const csrfFor = (ctx: Pick<Ctx, "key">, sessionToken: string) => ctx.key.mac("csrf", sessionToken);

/** Sessions die on expiry, revocation, or when the membership is removed (FK cascade). */
export async function authenticateSession(ctx: Ctx, token: string | undefined): Promise<Principal | null> {
  if (!token || token.length > 200) return null;
  const result = await ctx.db.query<{ id: string; user_id: string; email: string; workspace_id: string; role: Role; name: string }>(
    `SELECT s.id, s.user_id, u.email, s.workspace_id, m.role, w.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [sha256Hex(token), ctx.clock()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return userPrincipal({ id: row.user_id, email: row.email, workspace_id: row.workspace_id, role: row.role, name: row.name, sessionId: row.id });
}

export async function logout(ctx: Ctx, principal: Principal): Promise<void> {
  if (!principal.sessionId) return;
  await ctx.db.query("UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL", [ctx.clock(), principal.sessionId]);
}

/** Revoke every session of a user (CLI). Returns the number revoked. */
export async function revokeUserSessions(ctx: Ctx, email: string): Promise<number> {
  const result = await ctx.db.query("UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $2)", [
    ctx.clock(),
    email.trim().toLowerCase(),
  ]);
  return result.rowCount;
}

export async function listMembers(ctx: Ctx, principal: Principal) {
  requireRole(principal, "admin");
  const result = await ctx.db.query<{ user_id: string; email: string; role: Role }>(
    "SELECT m.user_id, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.email",
    [principal.workspaceId],
  );
  return result.rows;
}

/** Admin adds a member (no default password: the admin chooses one, >= 12 characters). */
export async function addMember(ctx: Ctx, principal: Principal, input: { email: string; password: string; role: Role }): Promise<{ user_id: string; email: string; role: Role }> {
  requireRole(principal, "admin");
  const at = ctx.clock();
  const userId = await ctx.db.transaction(async (tx) => {
    const id = await grantUser(tx, { workspaceId: principal.workspaceId, email: input.email, password: input.password, role: input.role, at });
    await audit(tx, { workspaceId: principal.workspaceId, leaseId: null, actorRef: principal.actorRef, action: "member.added", at, metadata: { role: input.role } });
    return id;
  });
  return { user_id: userId, email: input.email.trim().toLowerCase(), role: input.role };
}

/**
 * Local admin bootstrap used by `accesslease bootstrap-admin`. There is no default password and no HTTP route for it.
 * Creates the workspace when absent; an existing workspace is reused. A user that is already an admin there is a 409.
 */
export async function bootstrapAdmin(ctx: Ctx, input: BootstrapInput): Promise<BootstrapResult> {
  const at = ctx.clock();
  return ctx.db.transaction(async (tx) => {
    const name = input.workspaceName.trim();
    const existing = await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE name = $1 ORDER BY created_at LIMIT 1", [name]);
    const workspaceId = existing.rows[0]?.id ?? (await createWorkspace(tx, ctx, name, at));
    const userExisted = (await tx.query("SELECT 1 FROM users WHERE email = $1", [input.email.trim().toLowerCase()])).rows.length > 0;
    const userId = await grantUser(tx, { workspaceId, email: input.email, password: input.password, role: "admin", at });
    await audit(tx, { workspaceId, leaseId: null, actorRef: "cli:local", action: "admin.bootstrapped", at });
    return { workspaceId, userId, created: { workspace: !existing.rows[0], user: !userExisted } };
  });
}

/** Principal for the local operator CLI: trusted OS user, admin of the chosen workspace (id or name; single workspace is implied). */
export async function cliPrincipal(ctx: Ctx, workspace?: string): Promise<Principal> {
  const rows = (
    await ctx.db.query<{ id: string; name: string }>(
      workspace ? "SELECT id, name FROM workspaces WHERE id::text = $1 OR name = $1 ORDER BY created_at" : "SELECT id, name FROM workspaces ORDER BY created_at",
      workspace ? [workspace] : [],
    )
  ).rows;
  if (rows.length === 0) throw notFound();
  if (rows.length > 1) throw unprocessable("validation_failed", "Multiple workspaces exist; pass a workspace id or name");
  const row = rows[0] as { id: string; name: string };
  return { actorRef: "cli:local", userId: null, email: null, workspaceId: row.id, workspaceName: row.name, role: "admin", sessionId: null };
}

/** Principal used by the worker for system-initiated transitions. */
export const workerPrincipal = (workspaceId: string, workspaceName = ""): Principal => ({
  actorRef: "system:worker",
  userId: null,
  email: null,
  workspaceId,
  workspaceName,
  role: "admin",
  sessionId: null,
});

/** Fixed-window limiter for anonymous entry points (login). In-memory per process, bounded. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxBuckets = 10_000,
  ) {}

  take(key: string, nowMs: number): number | null {
    for (const [bucket, value] of this.hits) if (value.resetAt <= nowMs) this.hits.delete(bucket);
    const entry = this.hits.get(key);
    if (!entry) {
      // At capacity fail closed rather than evicting an active bucket.
      if (this.hits.size >= this.maxBuckets) return Math.ceil(this.windowMs / 1000);
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return null;
    }
    entry.count += 1;
    return entry.count > this.limit ? Math.ceil((entry.resetAt - nowMs) / 1000) : null;
  }
}
