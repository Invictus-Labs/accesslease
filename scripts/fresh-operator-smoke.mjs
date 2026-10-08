#!/usr/bin/env node
// SUPPLEMENTAL, AGENT-RUN evidence only. Never a substitute for the human drill (AC-11 stays PENDING_HUMAN_RECEIPT).
// Executes docs/runbook/smoke.md Parts A, B, C (through the API instead of a browser), D and cleanup from a pristine copy of the working
// tree in a fresh temporary directory, using only what the documentation tells an operator to do, and records timing, every step outcome
// and every place where the documentation's stated expectations differ from what actually happened.
//   node scripts/fresh-operator-smoke.mjs [--out FILE]
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outFile = process.argv.includes("--out") ? resolve(process.argv[process.argv.indexOf("--out") + 1]) : null;
const id = randomBytes(3).toString("hex");
const project = `al-fresh-${id}`;
const offlineProject = `al-fresh-off-${id}`;
const work = mkdtempSync(join(tmpdir(), "al-fresh-"));
const steps = [];
const discrepancies = [];
const started = new Date();

const run = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: work, encoding: "utf8", timeout: 900_000, ...options });
const step = async (name, fn) => {
  const t0 = Date.now();
  const entry = { step: name, started_at: new Date(t0).toISOString(), outcome: "pass", notes: [] };
  steps.push(entry);
  try {
    await fn(entry);
  } catch (error) {
    entry.outcome = "fail";
    entry.notes.push(String(error instanceof Error ? error.message : error));
  }
  entry.seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`${entry.outcome.toUpperCase()}  ${name} (${entry.seconds}s)${entry.notes.length ? `: ${entry.notes.join("; ")}` : ""}`);
};
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
const note = (cond, message) => {
  if (!cond) discrepancies.push(message);
};
const compose = (files, args, options) => run("docker", ["compose", "-p", project, ...files.flatMap((f) => ["-f", f]), ...args], options);
const main = ["compose.yaml", "compose.qa-main.yaml"];
let baseUrl = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await step("copy a pristine working tree into a fresh directory", async () => {
    const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
    for (const file of listed) {
      const from = join(root, file);
      if (!existsSync(from) || !statSync(from).isFile() || file.startsWith("docs/qa/receipts/")) continue;
      mkdirSync(dirname(join(work, file)), { recursive: true });
      cpSync(from, join(work, file));
    }
    expect(existsSync(join(work, "compose.offline.yaml")) && existsSync(join(work, "Dockerfile")), "compose or Dockerfile missing from the tree");
    cpSync(join(root, "scripts/compose.qa-main.yaml"), join(work, "compose.qa-main.yaml"));
    cpSync(join(root, "scripts/compose.qa-labels.yaml"), join(work, "compose.qa-labels.yaml"));
  });

  const postgresPassword = randomBytes(18).toString("base64url");
  const secretKey = randomBytes(32).toString("base64");
  await step("prepare .env from .env.example with generated values (install.md, smoke.md top)", async () => {
    let env = readFileSync(join(work, ".env.example"), "utf8");
    env = env.replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${postgresPassword}`).replace(/^ACCESSLEASE_SECRET_KEY=.*$/m, `ACCESSLEASE_SECRET_KEY=${secretKey}`).replace(/^PROVIDER_DB_PASSWORD=.*$/m, `PROVIDER_DB_PASSWORD=${randomBytes(12).toString("hex")}`);
    writeFileSync(join(work, ".env"), env, { mode: 0o600 });
    chmodSync(join(work, ".env"), 0o600);
  });

  await step("Part A: offline proof (compose.offline.yaml)", async (entry) => {
    const files = ["compose.offline.yaml", "compose.qa-labels.yaml"].flatMap((f) => ["-f", f]);
    const up = run("docker", ["compose", "-p", offlineProject, ...files, "up", "--build", "--abort-on-container-exit", "--exit-code-from", "smoke"]);
    const log = `${up.stdout}\n${up.stderr}`;
    run("docker", ["compose", "-p", offlineProject, ...files, "down", "-v", "--remove-orphans"]);
    entry.notes.push(`compose exit ${up.status}`);
    expect(up.status === 0, `compose exit code ${up.status}`);
    expect(log.includes("OFFLINE SMOKE PASSED"), "OFFLINE SMOKE PASSED not found in the log");
    note(log.includes("ok: outbound network is denied"), "smoke.md Part A says the log contains 'ok: outbound network is denied'");
    note(log.includes("provider: SYNTHETIC (live: false)"), "smoke.md Part A says the log contains 'provider: SYNTHETIC (live: false)'");
  });

  const demoDir = join(work, "demo-artifacts");
  const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  await step("Part B: demo output, report, bundle, tamper test", async (entry) => {
    mkdirSync(demoDir, { recursive: true });
    expect(compose(main, ["up", "-d", "--wait", "db"]).status === 0, "docker compose up -d db failed");
    const demo = compose(main, ["run", "--rm", "--no-deps", "--user", uid, "-v", `${demoDir}:/out`, "accesslease", "demo", "--out", "/out/demo", "--database-url", "postgres://accesslease@db:5432/accesslease"], { env: { ...process.env } });
    entry.notes.push(`demo exit ${demo.status}`);
    expect(demo.status === 4, `smoke.md says the demo exits 4; got ${demo.status}: ${demo.stderr.slice(-300)}`);
    const files = readdirSync(join(demoDir, "demo")).sort();
    note(JSON.stringify(files) === JSON.stringify(["evidence-bundle.json", "report-data.json", "report.html"]), `smoke.md lists evidence-bundle.json, report-data.json, report.html; found ${files.join(", ")}`);
    note((statSync(join(demoDir, "demo")).mode & 0o777) === 0o700, "smoke.md says the demo directory is mode 700");
    const bundle = JSON.parse(readFileSync(join(demoDir, "demo/evidence-bundle.json"), "utf8"));
    const documented = /`([0-9a-f]{64})`/.exec(readFileSync(join(work, "docs/runbook/smoke.md"), "utf8"))?.[1];
    note(documented === bundle.bundle_hash, `smoke.md documents bundle hash ${documented}; the demo produced ${bundle.bundle_hash}`);
    const html = readFileSync(join(demoDir, "demo/report.html"), "utf8");
    expect(html.includes("SYNTHETIC") && !/<script/i.test(html), "report is not labelled SYNTHETIC or contains a script");
    const verify = (file) => compose(main, ["run", "--rm", "--no-deps", "--user", uid, "-v", `${demoDir}:/out:ro`, "accesslease", "verify-bundle", file]);
    expect(verify("/out/demo/evidence-bundle.json").status === 0, "verify-bundle of the demo bundle did not exit 0");
    const good = readFileSync(join(demoDir, "demo/evidence-bundle.json"));
    const tampered = Buffer.from(good);
    tampered[200] = tampered[200] === 88 ? 89 : 88;
    writeFileSync(join(demoDir, "tampered.json"), tampered);
    writeFileSync(join(demoDir, "truncated.json"), good.subarray(0, 500));
    for (const f of ["tampered", "truncated"]) expect(verify(`/out/${f}.json`).status === 2, `${f} bundle must exit 2`);
  });

  await step("Part C: install, bootstrap, and the lease lifecycle through the API", async (entry) => {
    expect(compose(main, ["up", "-d", "--build", "--wait"]).status === 0, "docker compose up -d --build failed");
    const port = /:(\d+)$/.exec(compose(main, ["port", "accesslease", "8791"]).stdout.trim())?.[1];
    expect(port, "published port not found");
    baseUrl = `http://localhost:${port}`;
    const ready = await fetch(`${baseUrl}/api/v1/health/ready`).then((r) => r.json());
    expect(ready.status === "ready", "health/ready is not ready");
    const boot = compose(main, ["exec", "-T", "accesslease", "node", "dist/src/cli.js", "bootstrap-admin", "--workspace", "Smoke Workspace", "--email", "admin@example.test"]);
    expect(boot.status === 0, `bootstrap-admin failed: ${boot.stderr}`);
    const password = /generated password \(shown once, copy it now\): (\S+)/.exec(boot.stdout)?.[1];
    expect(password, "bootstrap-admin did not print a generated password");
    const again = compose(main, ["exec", "-T", "accesslease", "node", "dist/src/cli.js", "bootstrap-admin", "--workspace", "Smoke Workspace", "--email", "admin@example.test"]);
    note(again.status === 2 || again.status === 0, `smoke.md says a second bootstrap-admin is refused with exit 2; got ${again.status}`);
    const api = async (cookie, csrf, method, path, body) => {
      const res = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get("set-cookie") };
    };
    const login = await api(null, null, "POST", "/auth/login", { email: "admin@example.test", password });
    expect(login.status === 200, `login ${login.status}`);
    const cookie = login.cookie.split(";")[0];
    const csrf = login.body.csrf_token;
    const wildcard = await api(cookie, csrf, "POST", "/leases", { task_ref: "SMOKE-W", subject_ref: "contractor-a", resource_ref: "reporting", scopes: ["synthetic:*:read"] });
    expect(wildcard.status === 422, "wildcard scope must be refused");
    const long = await api(cookie, csrf, "POST", "/leases", { task_ref: "SMOKE-L", subject_ref: "contractor-a", resource_ref: "reporting", scopes: ["synthetic:reporting:read"], expires_at: new Date(Date.now() + 600 * 60_000).toISOString() });
    expect(long.status === 422, "a 600 minute lease must be refused");
    const lease = await api(cookie, csrf, "POST", "/leases", { task_ref: "SMOKE-1", subject_ref: "contractor-a", resource_ref: "reporting", scopes: ["synthetic:reporting:read"], expires_at: new Date(Date.now() + 75_000).toISOString() });
    expect(lease.status === 201, `request lease ${lease.status}`);
    const leaseId = lease.body.id;
    expect((await api(cookie, csrf, "POST", `/leases/${leaseId}/approve`, { plan_hash: lease.body.plan_hash })).status === 202, "approve failed");
    const stateOf = async (lid) => (await api(cookie, null, "GET", `/leases/${lid}`)).body;
    let detail;
    for (let i = 0; i < 40 && detail?.state !== "active"; i += 1) {
      await sleep(1000);
      detail = await stateOf(leaseId);
    }
    expect(detail.state === "active", `lease did not become ACTIVE (state ${detail?.state})`);
    expect((await api(cookie, csrf, "POST", `/leases/${leaseId}/credential`, {})).status === 200, "first credential retrieval failed");
    expect((await api(cookie, csrf, "POST", `/leases/${leaseId}/credential`, {})).status === 409, "second credential retrieval must be 409");
    for (let i = 0; i < 120 && detail?.state !== "revoked_verified"; i += 1) {
      await sleep(1000);
      detail = await stateOf(leaseId);
    }
    expect(detail.state === "revoked_verified" && detail.close_reason === "expired", `expiry did not end verified (state ${detail?.state}, reason ${detail?.close_reason})`);
    note(/introspection:absent\+probe:denied/.test(detail.attempts.at(-1)?.verification_ref ?? ""), `smoke.md expects verification reference introspection:absent+probe:denied; got ${detail.attempts.at(-1)?.verification_ref}`);
    entry.notes.push(`expired lease verified after ${detail.attempts.length} attempt(s)`);
    const second = await api(cookie, csrf, "POST", "/leases", { task_ref: "SMOKE-2", subject_ref: "contractor-b", resource_ref: "reporting", scopes: ["synthetic:reporting:read"], expires_at: new Date(Date.now() + 30 * 60_000).toISOString() });
    await api(cookie, csrf, "POST", `/leases/${second.body.id}/approve`, { plan_hash: second.body.plan_hash });
    for (let i = 0; i < 40 && (await stateOf(second.body.id)).state !== "active"; i += 1) await sleep(1000);
    expect((await stateOf(second.body.id)).state === "active", "second lease did not become ACTIVE before explicit revoke");
    await api(cookie, csrf, "POST", `/leases/${second.body.id}/revoke`, { reason: "smoke explicit revoke" });
    let d2;
    for (let i = 0; i < 40 && d2?.state !== "revoked_verified"; i += 1) {
      await sleep(1000);
      d2 = await stateOf(second.body.id);
    }
    expect(d2.state === "revoked_verified" && d2.close_reason === "operator_revoked", `explicit revoke state ${d2?.state}`);
    const viewer = await api(cookie, csrf, "POST", "/members", { email: "viewer@example.test", password: "a-long-synthetic-password", role: "viewer" });
    expect(viewer.status === 201, `adding a viewer failed (${viewer.status})`);
    const v = await api(null, null, "POST", "/auth/login", { email: "viewer@example.test", password: "a-long-synthetic-password" });
    const vc = v.cookie.split(";")[0];
    expect((await api(vc, v.body.csrf_token, "POST", `/leases/${second.body.id}/revoke`, { reason: "x" })).status === 403, "a viewer must get 403 on writes");
  });

  await step("Part D: report, export, verify and import into a clean database", async () => {
    const exec = (...args) => compose(main, ["exec", "-T", "accesslease", "node", "dist/src/cli.js", ...args]);
    const report = exec("report", "--out", "/tmp/report.html");
    expect([0, 4].includes(report.status), `report exit ${report.status}`);
    const exported = exec("export", "--out", "/tmp/bundle.json");
    expect(exported.status === 0 || exported.status === 4, `export exit ${exported.status}`);
    expect(exec("verify-bundle", "/tmp/bundle.json").status === 0, "verify-bundle of the live export failed");
    const imp = compose(main, ["run", "--rm", "--no-deps", "--user", uid, "-v", `${demoDir}:/in:ro`, "accesslease", "import", "/in/demo/evidence-bundle.json"]);
    expect(imp.status === 0 && /imported 3 lease/.test(imp.stdout), `import exit ${imp.status}: ${imp.stdout}`);
    const again = compose(main, ["run", "--rm", "--no-deps", "--user", uid, "-v", `${demoDir}:/in:ro`, "accesslease", "import", "/in/demo/evidence-bundle.json"]);
    expect(again.status === 0 && /already imported/.test(again.stdout), `second import: ${again.stdout}`);
    const bad = compose(main, ["run", "--rm", "--no-deps", "--user", uid, "-v", `${demoDir}:/in:ro`, "accesslease", "import", "/in/tampered.json"]);
    expect(bad.status === 2, `tampered import exit ${bad.status}`);
  });
} finally {
  await step("cleanup: remove everything the drill created", async (entry) => {
    compose(main, ["down", "-v", "--remove-orphans"]);
    run("docker", ["compose", "-p", offlineProject, "-f", "compose.offline.yaml", "-f", "compose.qa-labels.yaml", "down", "-v", "--remove-orphans"]);
    const leftovers = ["ps -a --format {{.Names}}", "volume ls --format {{.Name}}", "network ls --format {{.Name}}"]
      .map((c) => run("docker", c.split(" ")).stdout.split("\n").filter((n) => n.includes(`al-fresh-`) && n.includes(id)))
      .flat();
    entry.notes.push(leftovers.length === 0 ? "no container, volume or network left" : `left over: ${leftovers.join(", ")}`);
    expect(leftovers.length === 0, "resources left behind");
    rmSync(work, { recursive: true, force: true });
  });
}

const receipt = {
  label: "SUPPLEMENTAL, AGENT-RUN: not the AC-11 human receipt; AC-11 remains PENDING_HUMAN_RECEIPT",
  started_at: started.toISOString(),
  finished_at: new Date().toISOString(),
  revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  docs_sha256: createHash("sha256").update(readFileSync(join(root, "docs/runbook/smoke.md"))).digest("hex"),
  steps,
  documentation_discrepancies: discrepancies,
};
if (outFile) writeFileSync(outFile, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`\nfresh-operator-smoke (supplemental, agent-run): ${steps.filter((s) => s.outcome === "pass").length}/${steps.length} steps passed, ${discrepancies.length} documentation discrepancies`);
for (const d of discrepancies) console.log(`  - ${d}`);
process.exit(steps.every((s) => s.outcome === "pass") ? 0 : 1);
