import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { ApiClient, fetchTransport, type Session } from "../helpers/api.js";
import { freshMetadataDatabase, freshProviderTarget, type ProviderTarget, type ThrowawayDatabase } from "../helpers/db.js";
import { repoRoot, runToCompletion, spawnChild, type ChildHandle } from "../helpers/process.js";
import { sleep } from "../helpers/clock.js";

/**
 * A real AccessLease installation for browser tests: packaged CLI (`migrate`, `bootstrap-admin`, `serve`), real PostgreSQL metadata
 * database, real postgres-role provider on the disposable cluster, the real built web UI. Nothing is mocked or routed.
 */
export interface Stack {
  baseUrl: string;
  env: Record<string, string>;
  database: ThrowawayDatabase;
  target: ProviderTarget;
  client: ApiClient;
  password: string;
  admin: { email: string; session: Session };
  operator: { email: string; session: Session };
  viewer: { email: string; session: Session };
  workspaceId: string;
  server: ChildHandle;
  stopServer(): Promise<void>;
  stop(): Promise<void>;
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export async function startStack(options: { workerPollMs?: number } = {}): Promise<Stack> {
  const cli = join(repoRoot, "dist/src/cli.js");
  const database = await freshMetadataDatabase();
  const target = await freshProviderTarget();
  const port = await freePort();
  const password = `Pw-${randomBytes(9).toString("hex")}`;
  const env: Record<string, string> = {
    ACCESSLEASE_DATABASE_URL: database.url,
    ACCESSLEASE_SECRET_KEY: randomBytes(32).toString("base64"),
    ACCESSLEASE_PUBLIC_URL: `http://localhost:${port}`,
    ACCESSLEASE_HOST: "127.0.0.1",
    ACCESSLEASE_PORT: String(port),
    ACCESSLEASE_PROVIDER: "postgres-role",
    ACCESSLEASE_PROVIDER_ADMIN_URL: target.adminUrl,
    ACCESSLEASE_EGRESS_ALLOWLIST: "127.0.0.1,localhost",
    ACCESSLEASE_TTL_MIN_SECONDS: "1",
    ACCESSLEASE_WORKER_POLL_MS: String(options.workerPollMs ?? 250),
    ACCESSLEASE_BOOTSTRAP_PASSWORD: password,
  };
  for (const args of [["migrate"], ["bootstrap-admin", "--workspace", "e2e-workspace", "--email", "admin@e2e.example.invalid"]]) {
    const r = await runToCompletion(process.execPath, [cli, ...args], env);
    if (r.code !== 0) throw new Error(`accesslease ${args[0]} failed (${r.code}): ${r.stdout}\n${r.stderr}`);
  }
  const server = spawnChild(process.execPath, [cli, "serve"], env);
  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (res.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (server.child.exitCode !== null) throw new Error(`serve exited early: ${server.stdout.join("\n")}\n${server.stderr.join("\n")}`);
    if (Date.now() > deadline) throw new Error("serve did not become ready within 30 s");
    await sleep(200);
  }
  const client = new ApiClient(fetchTransport(baseUrl));
  const admin = { email: "admin@e2e.example.invalid", session: await client.login("admin@e2e.example.invalid", password) };
  const addMember = async (role: "operator" | "viewer") => {
    const email = `${role}@e2e.example.invalid`;
    const res = await client.post(admin.session, "/members", { email, password, role });
    if (res.status !== 201) throw new Error(`adding ${role} failed: ${res.status} ${res.raw}`);
    return { email, session: await client.login(email, password) };
  };
  const operator = await addMember("operator");
  const viewer = await addMember("viewer");
  const me = await client.get(admin.session, "/auth/session");
  return {
    baseUrl,
    env,
    database,
    target,
    client,
    password,
    admin,
    operator,
    viewer,
    workspaceId: me.body.user.workspace_id ?? me.body.user.workspaceId ?? "",
    server,
    stopServer: () => server.kill("SIGTERM"),
    stop: async () => {
      await server.kill("SIGTERM");
      await database.drop();
      await target.drop();
    },
  };
}
