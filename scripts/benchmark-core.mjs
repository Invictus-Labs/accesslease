#!/usr/bin/env node
// Performance EXPERIMENT (not an SLA): the deterministic core with 1,000 lease records, excluding provider I/O (SYNTHETIC provider,
// fixed clock, real PostgreSQL). PRD target: 1,000 records within 30 s on 2 CPU / 4 GB.
//   node scripts/benchmark-core.mjs [--records N] [--out FILE]          run on the host
//   node scripts/benchmark-core.mjs --docker [--records N] [--out FILE] run inside node:22 limited to 2 CPUs and 4 GB (the PRD reference)
// Needs ACCESSLEASE_TEST_DATABASE_URL (disposable server) and a built package (`npm run build:server`).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const records = Number(option("--records", "1000"));
const outFile = option("--out");
const adminUrl = process.env.ACCESSLEASE_TEST_DATABASE_URL;
if (!adminUrl) {
  console.error("benchmark-core: ACCESSLEASE_TEST_DATABASE_URL is required");
  process.exit(1);
}

if (argv.includes("--docker")) {
  const name = `al-bench-${randomBytes(4).toString("hex")}`;
  const containerUrl = adminUrl.replace("127.0.0.1", "host.docker.internal");
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--name", name, "--label", "accesslease-test=1", "--cpus", "2", "--memory", "4g", "--add-host", "host.docker.internal:host-gateway",
      "-v", `${root}/dist:/app/dist:ro`, "-v", `${root}/node_modules:/app/node_modules:ro`, "-v", `${root}/package.json:/app/package.json:ro`, "-v", `${root}/migrations:/app/migrations:ro`, "-v", `${root}/schemas:/app/schemas:ro`, "-v", `${root}/scripts:/app/scripts:ro`,
      "-e", `ACCESSLEASE_TEST_DATABASE_URL=${containerUrl}`, "-e", "ACCESSLEASE_BENCH_CONTAINER=2cpu-4gb", "-w", "/app", "node:22-alpine", "node", "scripts/benchmark-core.mjs", "--records", String(records)],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", timeout: 600_000 },
  );
  process.stdout.write(result.stdout ?? "");
  if (outFile && result.stdout) writeFileSync(outFile, result.stdout.trim().split("\n").at(-1) + "\n");
  process.exit(result.status ?? 1);
}

const dist = join(root, "dist/src");
if (!existsSync(join(dist, "services/index.js"))) {
  console.error("benchmark-core: run `npm run build:server` first");
  process.exit(1);
}
const svc = await import(join(dist, "services/index.js"));
const { fixedClock } = await import(join(dist, "context.js"));

const dbName = `al_bench_${randomBytes(5).toString("hex")}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const phases = {};
const time = async (label, fn) => {
  const started = performance.now();
  const value = await fn();
  phases[label] = Math.round(performance.now() - started);
  return value;
};

let ctx;
let status = 0;
try {
  const config = svc.loadConfig({
    ACCESSLEASE_DATABASE_URL: url.toString(),
    ACCESSLEASE_SECRET_KEY: randomBytes(32).toString("base64"),
    ACCESSLEASE_PROVIDER: "synthetic",
    ACCESSLEASE_TTL_MIN_SECONDS: "1",
  });
  ctx = svc.contextFromConfig(config);
  const clock = fixedClock("2026-01-01T00:00:00.000Z");
  ctx.clock = clock;
  ctx.log = () => undefined;
  await svc.migrate(ctx);
  await svc.bootstrapAdmin(ctx, { email: "bench@example.invalid", password: "synthetic-bench-password", workspaceName: "bench" });
  const principal = await svc.cliPrincipal(ctx, "bench");
  const started = performance.now();
  const ids = [];
  await time("request", async () => {
    for (let i = 0; i < records; i += 1) {
      const r = await svc.requestLease(ctx, principal, { task_ref: `BENCH-${i}`, subject_ref: `person-${i}@example.invalid`, resource_ref: "demo", scopes: ["pg:app.records:select"], expires_at: new Date(clock().getTime() + 3600_000).toISOString() });
      ids.push([r.id, r.plan_hash]);
    }
  });
  await time("approve", async () => {
    for (const [id, plan_hash] of ids) await svc.approveLease(ctx, principal, id, { plan_hash });
  });
  let passes = 0;
  await time("issue", async () => {
    for (;;) {
      const pass = await svc.runWorkerOnce(ctx);
      passes += 1;
      if (pass.jobsProcessed === 0) break;
    }
  });
  clock.advance(3601);
  await time("expire-revoke-verify", async () => {
    for (;;) {
      const pass = await svc.runWorkerOnce(ctx);
      passes += 1;
      if (pass.jobsProcessed === 0 && pass.sweep.expiredToRevoking === 0) break;
    }
  });
  const report = await time("report-data", () => svc.getReportData(ctx, principal, { limit: records }));
  const bundle = await time("export", () => svc.exportBundle(ctx, principal));
  const verified = await time("verify-bundle", async () => svc.verifyBundle(bundle.bytes));
  const total = Math.round(performance.now() - started);
  const verifiedCount = report.summary.by_state.REVOKED_VERIFIED;
  const result = {
    experiment: "deterministic core, 1,000-record benchmark (not an SLA)",
    records,
    provider: "SYNTHETIC (no provider I/O)",
    total_ms: total,
    target_ms: 30_000,
    within_target: total <= 30_000,
    revoked_verified: verifiedCount,
    bundle_ok: verified.ok,
    bundle_bytes: bundle.bytes.length,
    worker_passes: passes,
    phases_ms: phases,
    environment: { node: process.versions.node, cpus: cpus().length, memory_gb: Math.round((totalmem() / 2 ** 30) * 10) / 10, constrained: process.env.ACCESSLEASE_BENCH_CONTAINER ?? "host (unconstrained)" },
  };
  console.log(JSON.stringify(result));
  if (outFile) writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  if (verifiedCount !== records || !verified.ok) {
    console.error(`benchmark-core: expected ${records} verified revocations and a valid bundle, got ${verifiedCount} / ${verified.ok}`);
    status = 1;
  }
} catch (error) {
  console.error(`benchmark-core: ${error instanceof Error ? error.stack : error}`);
  status = 1;
} finally {
  await ctx?.providers?.closeAll?.().catch(() => undefined);
  await ctx?.db?.close?.().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}
process.exit(status);
