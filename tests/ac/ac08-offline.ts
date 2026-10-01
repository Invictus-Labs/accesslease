import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, type Harness } from "../helpers/harness.js";
import { freshMetadataDatabase, metadataAdminUrl, type ThrowawayDatabase } from "../helpers/db.js";
import { repoRoot, runToCompletion } from "../helpers/process.js";
import { recordEvidence } from "../helpers/evidence.js";

/**
 * AC-08: a synthetic demo works without paid accounts or mandatory telemetry; an outbound-denied test completes the deterministic
 * local core; live connector operations fail explicitly when disconnected.
 */
export function offlineDemo(): void {
  let database: ThrowawayDatabase;
  let work: string;
  const cli = join(repoRoot, "dist/src/cli.js");
  const guard = join(repoRoot, "tests/helpers/netguard.mjs");
  const key = randomBytes(32).toString("base64");

  beforeAll(async () => {
    expect(existsSync(cli), "run `npm run build:server` first: the packaged CLI is what is tested").toBe(true);
    database = await freshMetadataDatabase();
    work = mkdtempSync(join(tmpdir(), "al-offline-"));
  });
  afterAll(async () => {
    await database.drop();
    rmSync(work, { recursive: true, force: true });
  });

  const dbHostPort = () => {
    const u = new URL(metadataAdminUrl());
    return `${u.hostname}:${u.port}`;
  };

  it("the packaged CLI demo runs with the synthetic provider, no account, no telemetry and zero outbound connections other than its database", async () => {
    const out = join(work, "demo-out");
    const netLog = join(work, "net.log");
    const { code, stdout, stderr } = await runToCompletion(
      process.execPath,
      ["--import", guard, cli, "demo", "--out", out],
      { ACCESSLEASE_DATABASE_URL: database.url, ACCESSLEASE_SECRET_KEY: key, QA_NET_LOG: netLog, QA_NET_ALLOW: dbHostPort(), HOME: work },
      { cwd: work },
    );
    // 0 = clean, 4 = deliberately unresolved demo leases are present (never read as success); anything else is a failure.
    expect([0, 4], `${stdout}\n${stderr}`).toContain(code);
    const attempts = existsSync(netLog) ? readFileSync(netLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; target: string; blocked: boolean }) : [];
    expect(attempts.filter((a) => a.blocked), `blocked outbound attempts: ${JSON.stringify(attempts.filter((a) => a.blocked))}`).toEqual([]);
    expect(attempts.filter((a) => a.kind === "connect").every((a) => a.target === dbHostPort())).toBe(true);
    expect(attempts.filter((a) => a.kind === "fetch" || a.kind === "http")).toEqual([]);
    const files = readdirSync(out);
    expect(files.length).toBeGreaterThan(0);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(out)).toBe(0o700);
    for (const f of files) expect(mode(join(out, f)) & 0o077, `${f} must not be group/world accessible`).toBe(0);
    const text = files.map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    expect(text).toContain("SYNTHETIC");
    expect(text).not.toMatch(/LIVE_LOCAL_POSTGRES/);
    recordEvidence("ac-08-offline-demo", { exit_code: code, outbound_attempts: attempts.length, blocked_attempts: 0, files });
  });

  it("the demo also completes inside an internal Docker network with no route off the host", async () => {
    const id = randomBytes(4).toString("hex");
    const net = `al-offline-net-${id}`;
    const pgName = `al-offline-pg-${id}`;
    const appName = `al-offline-app-${id}`;
    const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
    const label = ["--label", "accesslease-test=1"];
    try {
      expect(docker(["network", "create", "--internal", ...label, net]).status).toBe(0);
      const password = randomBytes(12).toString("hex");
      expect(docker(["run", "-d", "--rm", "--name", pgName, ...label, "--network", net, "--memory", "512m", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:17-alpine"]).status).toBe(0);
      for (let i = 0; i < 60; i += 1) {
        const ready = docker(["exec", pgName, "psql", "-U", "postgres", "-d", "postgres", "-Atc", "select 1"]);
        if (ready.status === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          if (docker(["exec", pgName, "psql", "-U", "postgres", "-d", "postgres", "-Atc", "select 1"]).status === 0) break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      const script = [
        "set -e",
        // Negative control first: the network really is denied (no DNS, no route).
        `node -e "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>{console.error('OUTBOUND REACHABLE');process.exit(7)},()=>console.log('egress blocked'))"`,
        `node -e "fetch('http://192.0.2.1',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(7),()=>console.log('raw ip blocked'))"`,
        "node /app/dist/src/cli.js demo --out /tmp/out || test $? -eq 4",
        "test -s /tmp/out/*.html || ls /tmp/out",
        "ls -l /tmp/out",
      ].join("\n");
      const run = docker([
        "run", "--rm", "--name", appName, ...label, "--network", net, "--memory", "512m",
        "-v", `${repoRoot}/dist:/app/dist:ro`, "-v", `${repoRoot}/node_modules:/app/node_modules:ro`, "-v", `${repoRoot}/package.json:/app/package.json:ro`, "-v", `${repoRoot}/migrations:/app/migrations:ro`, "-v", `${repoRoot}/schemas:/app/schemas:ro`, "-v", `${repoRoot}/templates:/app/templates:ro`,
        "-e", `ACCESSLEASE_DATABASE_URL=postgres://postgres:${password}@${pgName}:5432/postgres`, "-e", `ACCESSLEASE_SECRET_KEY=${key}`,
        "node:22-alpine", "sh", "-c", script,
      ]);
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain("egress blocked");
      expect(run.stdout).toContain("raw ip blocked");
      expect(run.stdout).not.toContain("OUTBOUND REACHABLE");
      recordEvidence("ac-08-outbound-denied", { network: "docker --internal", egress_probe: "blocked", demo: "completed" });
    } finally {
      docker(["rm", "-f", appName]);
      docker(["rm", "-f", pgName]);
      docker(["network", "rm", net]);
    }
  });

  it("live connector operations fail explicitly when the provider is disconnected: provider status, approval and the doctor command all say so", async () => {
    // A real, closed port: nothing listens there, so the provider cannot connect.
    const closed = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    const h: Harness = await createHarness({
      provider: "postgres-role",
      fixedClock: false,
      env: { ACCESSLEASE_PROVIDER_ADMIN_URL: `postgres://al_admin:unused@127.0.0.1:${closed}/postgres` },
      skipTarget: true,
    });
    try {
      const ws = await h.workspace("ac08");
      const status = await h.client.get(ws.operator.session, "/provider");
      expect(status.status).toBe(200);
      expect(status.body.connected).toBe(false);
      expect(status.body.code).toBeTruthy();
      expect(status.body.label ?? status.body.provider?.label).toBe("LIVE_LOCAL_POSTGRES");
      const created = await h.client.post(ws.operator.session, "/leases", { task_ref: "TASK-AC08", subject_ref: "c@example.invalid", resource_ref: "postgres", scopes: ["pg:app.records:select"], expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (created.status === 201) {
        const approve = await h.client.post(ws.operator.session, `/leases/${created.body.id}/approve`, { plan_hash: created.body.plan_hash });
        expect(approve.status).toBe(503);
        expect(approve.body.error.code).toBe("provider_unavailable");
        expect((await h.client.get(ws.operator.session, `/leases/${created.body.id}`)).body.state).toBe("requested");
      } else {
        expect(created.status).toBe(503);
      }
      const doctor = await runToCompletion(process.execPath, [cli, "doctor"], { ACCESSLEASE_DATABASE_URL: h.database.url, ACCESSLEASE_SECRET_KEY: key, ACCESSLEASE_PROVIDER: "postgres-role", ACCESSLEASE_PROVIDER_ADMIN_URL: `postgres://al_admin:unused@127.0.0.1:${closed}/postgres` }, { cwd: work });
      expect(doctor.code, `${doctor.stdout}\n${doctor.stderr}`).toBe(3);
    } finally {
      await h.close();
      await h.database.drop();
    }
  });

  it("contains no telemetry: no analytics or error-reporting dependency, host or beacon exists in the dependency list or the sources", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const banned = /(posthog|sentry|segment|mixpanel|amplitude|datadog|newrelic|bugsnag|rollbar|logrocket|hotjar|google-analytics|gtag|plausible|telemetry|opentelemetry)/i;
    expect(Object.keys(pkg.dependencies).filter((d) => banned.test(d))).toEqual([]);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const hits = walk(join(repoRoot, "src"))
      .filter((f) => /\.(ts|tsx|html)$/.test(f))
      .filter((f) => banned.test(readFileSync(f, "utf8").replace(/no telemetry|telemetry is off|never telemetry|without telemetry/gi, "")));
    expect(hits).toEqual([]);
  });
}
