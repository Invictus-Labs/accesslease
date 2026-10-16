import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../src/context.js";
import { fixedClock as backendFixedClock, systemClock } from "../../src/context.js";
import type { LeaseDetail, LeaseView, Role } from "../../src/domain/types.js";
import { memoryLogger } from "../../src/lib/log.js";
import { buildApp } from "../../src/server.js";
import { bootstrapAdmin, contextFromConfig, loadConfig, migrate, runWorkerOnce } from "../../src/services/index.js";
import type { WorkerPassReport } from "../../src/services/contract.js";
import { ApiClient, injectTransport, type ApiResponse, type Session } from "./api.js";
import { T0 } from "./clock.js";
import { freshMetadataDatabase, freshProviderTarget, type ProviderTarget, type ThrowawayDatabase } from "./db.js";

export const PASSWORD = "synthetic-test-password-123";

export interface Persona {
  email: string;
  role: Role;
  session: Session;
}

export interface TestWorkspace {
  id: string;
  name: string;
  admin: Persona;
  operator: Persona;
  viewer: Persona;
}

export interface HarnessOptions {
  /** `postgres-role` = REAL provider on the disposable cluster; `synthetic` = labelled simulator (deterministic fault tests only). */
  provider: "synthetic" | "postgres-role";
  /** true: deterministic fixed clock starting at T0 (advance with `clock.advance`). false: the real wall clock. */
  fixedClock?: boolean;
  /** Overrides applied on top of the loaded settings (poll intervals, job lease seconds, retry delays). */
  settings?: Partial<Ctx["settings"]>;
  /** Extra environment for loadConfig (for example ACCESSLEASE_TTL_MIN_SECONDS). */
  env?: Record<string, string>;
  /** Reuse an existing metadata database (restart/restore tests) instead of creating one. */
  database?: ThrowawayDatabase;
  /** Reuse an existing provider target. */
  target?: ProviderTarget;
  /** Do not create a provider target (the caller supplies ACCESSLEASE_PROVIDER_ADMIN_URL, for example a closed port). */
  skipTarget?: boolean;
}

export interface Harness {
  ctx: Ctx;
  app: FastifyInstance;
  client: ApiClient;
  clock: ReturnType<typeof backendFixedClock> | null;
  logLines: string[];
  /** Raw text of every API response (body and headers) this harness's client received: the observable corpus for leak checks. */
  captured: string[];
  database: ThrowawayDatabase;
  target: ProviderTarget | null;
  secretKey: string;
  /** Creates a workspace with admin, operator and viewer users and logs each of them in. */
  workspace(name: string): Promise<TestWorkspace>;
  /** One worker pass (sweep first, then jobs) through the real worker code. */
  worker(): Promise<WorkerPassReport>;
  /** Run worker passes until a pass does nothing, at most `max`. Returns the reports. */
  drain(max?: number): Promise<WorkerPassReport[]>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const database = options.database ?? (await freshMetadataDatabase());
  const target = options.provider === "postgres-role" && !options.skipTarget ? (options.target ?? (await freshProviderTarget())) : null;
  const secretKey = randomBytes(32).toString("base64");
  const env: Record<string, string> = {
    ACCESSLEASE_DATABASE_URL: database.url,
    ACCESSLEASE_SECRET_KEY: secretKey,
    ACCESSLEASE_PUBLIC_URL: "http://localhost:8791",
    ACCESSLEASE_PROVIDER: options.provider,
    ACCESSLEASE_TTL_MIN_SECONDS: "1",
    ACCESSLEASE_EGRESS_ALLOWLIST: "127.0.0.1,localhost",
    ...(target ? { ACCESSLEASE_PROVIDER_ADMIN_URL: target.adminUrl } : {}),
    ...options.env,
  };
  const config = loadConfig(env as NodeJS.ProcessEnv);
  const ctx = contextFromConfig(config);
  const clock = options.fixedClock === false ? null : backendFixedClock(T0);
  const memory = memoryLogger();
  ctx.clock = clock ?? systemClock;
  ctx.log = memory.log;
  Object.assign(ctx.settings, options.settings);
  await migrate(ctx);
  const app = await buildApp(ctx);
  const captured: string[] = [];
  const inner = injectTransport(app);
  const client = new ApiClient(async (request) => {
    const response = await inner(request);
    captured.push(response.raw, JSON.stringify(response.headers));
    return response;
  });

  const workspace: Harness["workspace"] = async (name) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const adminEmail = `admin@${slug}.example.invalid`;
    const result = await bootstrapAdmin(ctx, { email: adminEmail, password: PASSWORD, workspaceName: name });
    const admin: Persona = { email: adminEmail, role: "admin", session: await client.login(adminEmail, PASSWORD, result.workspaceId) };
    const addMember = async (role: "operator" | "viewer"): Promise<Persona> => {
      const email = `${role}@${slug}.example.invalid`;
      const res = await client.post(admin.session, "/members", { email, password: PASSWORD, role });
      if (res.status !== 201) throw new Error(`adding ${role} failed: ${res.status} ${res.raw}`);
      return { email, role, session: await client.login(email, PASSWORD, result.workspaceId) };
    };
    return { id: result.workspaceId, name, admin, operator: await addMember("operator"), viewer: await addMember("viewer") };
  };

  const worker = () => runWorkerOnce(ctx, { workerId: `qa-${randomBytes(3).toString("hex")}` });
  const drain: Harness["drain"] = async (max = 25) => {
    const reports: WorkerPassReport[] = [];
    for (let i = 0; i < max; i += 1) {
      const report = await worker();
      reports.push(report);
      if (report.jobsProcessed === 0 && report.sweep.expiredToRevoking === 0 && report.sweep.overdueRecovered === 0) break;
    }
    return reports;
  };

  return {
    ctx,
    app,
    client,
    clock,
    logLines: memory.lines,
    captured,
    database,
    target,
    secretKey,
    workspace,
    worker,
    drain,
    close: async () => {
      await app.close();
      await ctx.providers.closeAll();
      await ctx.db.close?.();
    },
  };
}

/** Request a lease and return the parsed `201` body; throws with the response when the request is rejected. */
export async function requestLease(h: Harness, ws: TestWorkspace, input: Record<string, unknown>): Promise<{ id: string; plan_hash: string; lease: LeaseView }> {
  const res = await h.client.post(ws.operator.session, "/leases", input);
  if (res.status !== 201) throw new Error(`POST /leases -> ${res.status} ${res.raw}`);
  return res.body;
}

export async function getLease(h: Harness, session: Session, id: string): Promise<LeaseDetail> {
  const res: ApiResponse = await h.client.get(session, `/leases/${id}`);
  if (res.status !== 200) throw new Error(`GET /leases/${id} -> ${res.status} ${res.raw}`);
  return res.body;
}
