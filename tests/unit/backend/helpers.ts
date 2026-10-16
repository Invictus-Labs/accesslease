import { randomBytes } from "node:crypto";
import pg from "pg";
import { type Provider, ProviderRegistry } from "../../../src/connectors/provider.js";
import { SyntheticProvider } from "../../../src/connectors/synthetic.js";
import { type Ctx, defaultSettings, fixedClock, type Settings } from "../../../src/context.js";
import { ServerKey } from "../../../src/crypto.js";
import { type Database, openDatabase } from "../../../src/db/index.js";
import { migrate } from "../../../src/db/migrate.js";
import type { LeaseView, Principal, Role } from "../../../src/domain/types.js";
import { memoryLogger } from "../../../src/lib/log.js";
import { createWorkspace, grantUser } from "../../../src/services/auth.js";
import { approveLease, requestLease } from "../../../src/services/leases.js";
import { runWorkerOnce } from "../../../src/workers/index.js";

export const T0 = "2026-03-01T12:00:00.000Z";

export function testDatabaseUrl(): string {
  const url = process.env.ACCESSLEASE_TEST_DATABASE_URL;
  if (!url) throw new Error("ACCESSLEASE_TEST_DATABASE_URL is required: backend tests run against real PostgreSQL");
  return url;
}

export function testProviderUrl(): string {
  const url = process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL;
  if (!url) throw new Error("ACCESSLEASE_TEST_PROVIDER_DATABASE_URL is required for postgres-role provider tests");
  return url;
}

export const withDatabase = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

/** A uniquely named database per test file, dropped afterwards. */
export async function freshDatabase(prefix = "al_be"): Promise<{ url: string; db: Database; drop: () => Promise<void> }> {
  const adminUrl = testDatabaseUrl();
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = withDatabase(adminUrl, name);
  const db = openDatabase(url);
  return {
    url,
    db,
    drop: async () => {
      await db.close().catch(() => undefined);
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}

export interface Env {
  ctx: Ctx;
  clock: ReturnType<typeof fixedClock>;
  provider: SyntheticProvider;
  workspaceId: string;
  admin: Principal;
  operator: Principal;
  viewer: Principal;
  logs: string[];
  url: string;
  drop: () => Promise<void>;
  /** A second workspace with its own principals (isolation tests). */
  other: { workspaceId: string; admin: Principal; operator: Principal; viewer: Principal };
}

export const principalOf = (workspaceId: string, workspaceName: string, userId: string, role: Role): Principal => ({
  actorRef: `user:${userId}`,
  userId,
  email: `${role}@example.test`,
  workspaceId,
  workspaceName,
  role,
  sessionId: null,
});

/** Create a workspace with an admin, an operator and a viewer (no sessions; service-level tests pass principals directly). */
export async function seedWorkspace(ctx: Ctx, name: string) {
  const at = ctx.clock();
  const result = await ctx.db.transaction(async (tx) => {
    const workspaceId = await createWorkspace(tx, ctx, name, at);
    const ids = {} as Record<Role, string>;
    for (const role of ["admin", "operator", "viewer"] as Role[]) {
      ids[role] = await grantUser(tx, { workspaceId, email: `${role}-${name}@example.test`.toLowerCase(), password: "synthetic-password-123", role, at });
    }
    return { workspaceId, ids };
  });
  return {
    workspaceId: result.workspaceId,
    admin: principalOf(result.workspaceId, name, result.ids.admin, "admin"),
    operator: principalOf(result.workspaceId, name, result.ids.operator, "operator"),
    viewer: principalOf(result.workspaceId, name, result.ids.viewer, "viewer"),
  };
}

export async function makeEnv(options: { settings?: Partial<Settings>; providers?: Provider[]; start?: string } = {}): Promise<Env> {
  const fresh = await freshDatabase();
  await migrate(fresh.db);
  const clock = fixedClock(options.start ?? T0);
  const provider = new SyntheticProvider({ clock });
  const { log, lines } = memoryLogger();
  const ctx: Ctx = {
    db: fresh.db,
    clock,
    key: ServerKey.generate(),
    settings: { ...defaultSettings, secureCookies: false, ...options.settings },
    providers: new ProviderRegistry(options.providers ?? [provider], options.providers?.[0]?.kind ?? "synthetic"),
    log,
  };
  const main = await seedWorkspace(ctx, "main");
  const other = await seedWorkspace(ctx, "other");
  return { ctx, clock, provider, ...main, logs: lines, url: fresh.url, drop: fresh.drop, other };
}

export const goodRequest = (overrides: Record<string, unknown> = {}) => ({
  task_ref: "TASK-1",
  subject_ref: "contractor-1",
  resource_ref: "sandbox",
  scopes: ["synthetic:sandbox:read"],
  ...overrides,
});

export const iso = (clock: { (): Date }, plusSeconds: number): string => new Date(clock().getTime() + plusSeconds * 1000).toISOString();

export async function requestApprove(env: Env, overrides: Record<string, unknown> = {}, ttlSeconds = 600): Promise<LeaseView> {
  const created = await requestLease(env.ctx, env.operator, goodRequest({ expires_at: iso(env.clock, ttlSeconds), ...overrides }));
  const approved = await approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash });
  return approved.lease;
}

/** Run worker passes until a pass does no work (bounded). */
export async function drive(env: Env, maxPasses = 10) {
  let last = await runWorkerOnce(env.ctx, { workerId: "test-worker" });
  for (let i = 1; i < maxPasses && last.jobsProcessed > 0; i += 1) last = await runWorkerOnce(env.ctx, { workerId: "test-worker" });
  return last;
}

export async function leaseRow(env: Env, id: string) {
  return (await env.ctx.db.query<Record<string, any>>("SELECT * FROM leases WHERE id = $1", [id])).rows[0] as Record<string, any>;
}
