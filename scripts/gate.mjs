#!/usr/bin/env node
// AccessLease quality gate orchestrator (run through scripts/verify-quality.sh). Executes every gate step, records command,
// exit code and duration for each, and writes a machine-readable receipt plus a short human summary. Never reports a
// skipped required step as success.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join, relative, resolve } from "node:path";
import { computeVerdict, parseMatrix, verdictIsAcceptable } from "./lib/verdict.mjs";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const full = flag("--full");
const benchmark = flag("--benchmark");
const keepDb = flag("--keep-db");
const supplemental = flag("--supplemental");
const allowIncompleteMatrix = flag("--allow-incomplete-matrix");
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const receiptDir = resolve(option("--receipt-dir") ?? join(root, "docs/qa/receipts"));
const workDir = join(receiptDir, `run-${stamp}`);
mkdirSync(workDir, { recursive: true });

const redactions = [
  [root, "<repo>"],
  [homedir(), "<home>"],
];
const redact = (text) => {
  let out = String(text);
  for (const [from, to] of redactions) if (from && from.length > 3) out = out.split(from).join(to);
  return out.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/g, "$1***@");
};

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", cwd: root, ...opts });
const out = (cmd, argv) => {
  const r = run(cmd, argv);
  return r.status === 0 ? r.stdout.trim() : null;
};
const nodeVersion = process.versions.node;
const supportedNode = (v) => {
  const [major, minor, patch] = v.split(".").map(Number);
  return (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15) || major >= 26;
};

const steps = [];
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
delete env.FORCE_COLOR;

function step(name, command, argv, { required = true, stepEnv = {}, parse } = {}) {
  console.log(`\n== ${name}`);
  const started = Date.now();
  const logPath = join(workDir, `${name}.log`);
  const log = createWriteStream(logPath);
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd: root, env: { ...env, ...stepEnv }, stdio: ["ignore", "pipe", "pipe"] });
    const forward = (stream, sink) => stream.on("data", (chunk) => {
      const text = redact(chunk.toString());
      sink.write(text);
      log.write(text);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on("error", (error) => {
      log.write(`spawn error: ${error.message}\n`);
    });
    child.on("close", (code) => {
      log.end();
      const record = {
        name,
        required,
        status: code === 0 ? "PASS" : "FAIL",
        command: redact([command, ...argv].join(" ")),
        exit_code: code,
        started_at: new Date(started).toISOString(),
        duration_ms: Date.now() - started,
        log: relative(receiptDir, logPath),
      };
      if (parse) Object.assign(record, parse(record) ?? {});
      steps.push(record);
      console.log(`-- ${name}: ${record.status} (exit ${code}, ${(record.duration_ms / 1000).toFixed(1)}s)`);
      done(record);
    });
  });
}

function skip(name, reason, required = true) {
  console.log(`\n== ${name}: SKIPPED (${reason})`);
  steps.push({ name, required, status: "SKIPPED", command: null, exit_code: null, started_at: new Date().toISOString(), duration_ms: 0, reason });
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function hashTree(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  if (!existsSync(dir)) return null;
  walk(dir);
  const h = createHash("sha256");
  for (const f of files) h.update(relative(dir, f)).update("\0").update(readFileSync(f));
  return { sha256: h.digest("hex"), files: files.length };
}

// --- 0. supported runtime -------------------------------------------------------------------------------------------
if (!supportedNode(nodeVersion)) {
  console.error(`verify-quality: Node ${nodeVersion} is unsupported for the dev toolchain (need 22.22.2+, 24.15+ or 26+). Put a supported Node on PATH.`);
  process.exit(2);
}
steps.push({ name: "supported-host-runtime", required: true, status: "PASS", command: "node -v", exit_code: 0, started_at: startedAt.toISOString(), duration_ms: 0, detail: `node ${nodeVersion}` });

// --- 1. typecheck and build ------------------------------------------------------------------------------------------
await step("typecheck-server", "npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]);
await step("typecheck-web", "npx", ["tsc", "-p", "tsconfig.web.json", "--noEmit"]);
await step("typecheck-tests", "npx", ["tsc", "-p", "tests/tsconfig.json"]);
await step("build", "npm", ["run", "build", "--silent"]);

// --- 2. throwaway PostgreSQL pair --------------------------------------------------------------------------------------
let runId = null;
let dbEnv = {};
if (process.env.ACCESSLEASE_TEST_DATABASE_URL && process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL) {
  dbEnv = {
    ACCESSLEASE_TEST_DATABASE_URL: process.env.ACCESSLEASE_TEST_DATABASE_URL,
    ACCESSLEASE_TEST_PROVIDER_DATABASE_URL: process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL,
    ACCESSLEASE_TEST_PROVIDER_CONTAINER: process.env.ACCESSLEASE_TEST_PROVIDER_CONTAINER ?? "",
    ACCESSLEASE_TEST_META_CONTAINER: process.env.ACCESSLEASE_TEST_META_CONTAINER ?? "",
  };
  steps.push({ name: "test-databases", required: true, status: "PASS", command: "reuse ACCESSLEASE_TEST_* from environment", exit_code: 0, started_at: new Date().toISOString(), duration_ms: 0, detail: "externally supplied disposable servers" });
} else {
  runId = createHash("sha256").update(`${stamp}-${process.pid}`).digest("hex").slice(0, 8);
  const up = await step("test-databases", "bash", ["scripts/test-db.sh", "up", runId]);
  if (up.status === "PASS") {
    const envOut = run("bash", ["scripts/test-db.sh", "env", runId]).stdout;
    for (const line of envOut.split("\n")) {
      const m = /^export (ACCESSLEASE_TEST_[A-Z_]+)=(.*)$/.exec(line);
      if (m) dbEnv[m[1]] = m[2].replace(/^'|'$/g, "").replace(/\\(.)/g, "$1");
    }
  }
}
const cleanup = () => {
  if (runId && !keepDb) run("bash", ["scripts/test-db.sh", "down", runId]);
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const haveDb = Boolean(dbEnv.ACCESSLEASE_TEST_DATABASE_URL);

// --- 3. unit + integration (real PostgreSQL, real provider) with the coverage gate ------------------------------------
let tests = null;
let coverage = null;
if (haveDb) {
  const vitestJson = join(workDir, "vitest.json");
  await step("tests-coverage", "npx", ["vitest", "run", "--coverage", "--reporter=default", "--reporter=json", `--outputFile.json=${vitestJson}`], {
    stepEnv: { ...dbEnv, ACCESSLEASE_EVIDENCE_DIR: join(workDir, "evidence") },
    parse: () => {
      if (!existsSync(vitestJson)) return { detail: "vitest produced no JSON report" };
      const data = JSON.parse(readFileSync(vitestJson, "utf8"));
      const assertions = data.testResults.flatMap((suite) => (suite.assertionResults ?? []).map((a) => ({ ...a, file: relative(root, suite.name) })));
      tests = {
        files: data.numTotalTestSuites,
        total: data.numTotalTests,
        passed: data.numPassedTests,
        failed: data.numFailedTests,
        skipped: data.numPendingTests,
        todo: data.numTodoTests,
        skipped_tests: assertions.filter((a) => ["pending", "skipped", "todo"].includes(a.status)).map((a) => `${a.file} :: ${a.fullName}`),
      };
      return { detail: `${tests.passed}/${tests.total} passed, ${tests.skipped} skipped` };
    },
  });
  const summaryPath = join(root, "coverage/coverage-summary.json");
  if (existsSync(summaryPath)) {
    const total = JSON.parse(readFileSync(summaryPath, "utf8")).total;
    coverage = { lines: total.lines.pct, branches: total.branches.pct, statements: total.statements.pct, functions: total.functions.pct, threshold: 90 };
    const ok = coverage.lines >= 90 && coverage.branches >= 90;
    steps.push({ name: "coverage-threshold", required: true, status: ok ? "PASS" : "FAIL", command: "coverage/coverage-summary.json >= 90% lines and branches", exit_code: ok ? 0 : 1, started_at: new Date().toISOString(), duration_ms: 0, detail: `lines ${coverage.lines}%, branches ${coverage.branches}%` });
  } else {
    steps.push({ name: "coverage-threshold", required: true, status: "FAIL", command: "coverage/coverage-summary.json", exit_code: 1, started_at: new Date().toISOString(), duration_ms: 0, detail: "no coverage summary produced" });
  }
  if (tests && tests.skipped > 0) {
    steps.push({ name: "no-skipped-tests", required: true, status: "FAIL", command: "vitest skipped count == 0", exit_code: 1, started_at: new Date().toISOString(), duration_ms: 0, detail: `${tests.skipped} skipped test(s) must be resolved or justified as BLOCKED rows` });
  }
} else {
  skip("tests-coverage", "no throwaway PostgreSQL available");
}

// --- 4. negative controls and seeded failure -------------------------------------------------------------------------
if (haveDb) {
  await step("negative-controls", "node", ["scripts/verify-mutations.mjs", "--report", join(workDir, "negative-controls.json")], { stepEnv: dbEnv });
  await step("seeded-failure-turns-verdict-red", "node", ["scripts/verify-seeded-failure.mjs"], { stepEnv: dbEnv });
} else {
  skip("negative-controls", "no throwaway PostgreSQL available");
  skip("seeded-failure-turns-verdict-red", "no throwaway PostgreSQL available");
}

// --- 5. browser E2E (real UI against the real API) ----------------------------------------------------------------------
if (haveDb) {
  await step("browser-e2e", "npx", ["playwright", "test", "--reporter=list,json"], { stepEnv: { ...dbEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: join(workDir, "playwright.json") }, parse: () => {
    const p = join(workDir, "playwright.json");
    if (!existsSync(p)) return { detail: "playwright produced no JSON report" };
    const stats = JSON.parse(readFileSync(p, "utf8")).stats ?? {};
    return { detail: `expected ${stats.expected}, unexpected ${stats.unexpected}, skipped ${stats.skipped}, flaky ${stats.flaky}` };
  } });
} else {
  skip("browser-e2e", "no throwaway PostgreSQL available");
}

// --- 5c. terminal-fence races on the throwaway provider cluster: real advisory locks, isolation and commit loss, which the
// synthetic unit model can only assume. The harness refuses anything but the disposable loopback al_admin pair.
if (haveDb) {
  await step("provider-terminal-fence-pg17", "npx", ["vitest", "run", "--config", "vitest.provider-terminal-fence.config.ts"], { stepEnv: { ...dbEnv, ACCESSLEASE_TERMINAL_FENCE_LIVE_ACK: "disposable-pg17" } });
} else {
  skip("provider-terminal-fence-pg17", "no throwaway PostgreSQL available");
}

// --- 5a. the acceptance matrix is computed from this run's reports (a PASS cannot be typed by hand)
if (haveDb && existsSync(join(workDir, "vitest.json"))) {
  const headSha = out("git", ["rev-parse", "HEAD"]) ?? "";
  await step("acceptance-matrix-from-run", "node", ["scripts/update-matrix.mjs", "--vitest", join(workDir, "vitest.json"), "--playwright", join(workDir, "playwright.json"), "--sha", headSha]);
} else {
  skip("acceptance-matrix-from-run", "needs the vitest report of this run");
}

// --- 5b. the PRD "Proven by" cells must point at the real tests of this very run
if (haveDb && existsSync(join(workDir, "vitest.json")) && existsSync(join(workDir, "playwright.json"))) {
  await step("prd-proven-by-reconciled", "node", ["scripts/reconcile-prd.mjs", "--vitest", join(workDir, "vitest.json"), "--playwright", join(workDir, "playwright.json"), "--check"]);
} else {
  skip("prd-proven-by-reconciled", "needs the vitest and Playwright reports of this run");
}

// --- 6. hygiene: secret scan, license audit, public-content sanitizer --------------------------------------------------
await step("secret-and-hygiene-scan", "node", ["scripts/secret-scan.mjs"]);
await step("license-audit", "node", ["scripts/license-audit.mjs", "--check"]);
if (out("sh", ["-c", "command -v sanitize-content"])) {
  const files = (out("git", ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "").split("\n").filter((f) => f && existsSync(f) && statSync(f).isFile());
  await step("sanitize-content-public", "sanitize-content", ["--scope", "public", ...files], { required: false });
} else {
  skip("sanitize-content-public", "sanitize-content is not installed on this machine (the in-repo secret-and-hygiene-scan still ran)", false);
}

// --- 7. packaged CLI demo, offline by construction ---------------------------------------------------------------------
await step("cli-demo-offline", "node", ["scripts/demo-smoke.mjs", "--out", join(workDir, "demo")], { stepEnv: dbEnv });

// --- 8. optional benchmark ---------------------------------------------------------------------------------------------
if (benchmark) await step("core-benchmark-experiment", "node", ["scripts/benchmark-core.mjs", "--out", join(workDir, "benchmark.json")], { stepEnv: dbEnv, required: false });

// --- 9. heavy Docker steps (required for a release verdict) --------------------------------------------------------------
if (full) {
  await step("offline-outbound-denied-demo", "node", ["scripts/offline-demo.mjs"]);
  await step("supported-runtime-docker-node22", "node", ["scripts/runtime-check-node22.mjs"], { stepEnv: dbEnv });
} else {
  skip("offline-outbound-denied-demo", "run with --full");
  skip("supported-runtime-docker-node22", "run with --full");
}

// --- 9b. supplemental, agent-run fresh-operator smoke (never the AC-11 human receipt)
if (supplemental) await step("supplemental-agent-run-fresh-operator-smoke", "node", ["scripts/fresh-operator-smoke.mjs", "--out", join(workDir, "fresh-operator-smoke.json")], { required: false });

// --- 10. matrix, findings, receipt ----------------------------------------------------------------------------------------
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const matrix = parseMatrix(read("docs/qa/ac-matrix.md"));
const humanReceipt = read("docs/qa/receipts/ac-11-human-receipt.md");
const humanReceiptValid = /^Performed-by:\s*human\s*$/im.test(humanReceipt) && /^Identity:\s*\S+/im.test(humanReceipt) && /^Cleanup receipt:\s*\S+/im.test(humanReceipt);
const { verdict, reasons } = computeVerdict({ steps, matrix, humanReceiptValid, allowIncompleteMatrix });

const findings = [];
const registerAt = read("docs/qa/ac-matrix.md").indexOf("## Defect register");
for (const line of (registerAt >= 0 ? read("docs/qa/ac-matrix.md").slice(registerAt) : "").split("\n")) {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length >= 7 && /^F-\d+/.test(cells[1] ?? "")) findings.push({ id: cells[1], severity: cells[2], owner: cells[3], status: cells[4], title: cells[5] });
}
if (registerAt < 0) reasons.push("docs/qa/ac-matrix.md has no Defect register section");
const unresolved = findings.filter((f) => !/^(resolved|closed|verified)/i.test(f.status)).map(({ id, severity, owner, status, title }) => ({ id, severity, owner, status, title }));
const blocking = unresolved.filter((f) => /^P[01]$/.test(f.severity));
if (blocking.length > 0) reasons.push(`unresolved P0/P1 findings: ${blocking.map((f) => f.id).join(", ")}`);
const finalVerdict = blocking.length > 0 && verdictIsAcceptable(verdict) ? "RED" : verdict;

const gitHead = out("git", ["rev-parse", "HEAD"]);
const worktrees = (out("git", ["worktree", "list", "--porcelain"]) ?? "").split("\n\n").map((block) => {
  const sha = /^HEAD (\w+)/m.exec(block)?.[1];
  const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "(detached)";
  return sha ? { branch, sha } : null;
}).filter(Boolean);
const porcelain = (out("git", ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const fixtureVersion = existsSync("fixtures/demo.json") ? JSON.parse(readFileSync("fixtures/demo.json", "utf8")).fixture_version : null;
const artifactPaths = ["package-lock.json", "fixtures/demo.json", "coverage/coverage-summary.json", "docs/qa/ac-matrix.md"];
const artifacts = artifactPaths.filter(existsSync).map((p) => ({ path: p, sha256: sha256(p), bytes: statSync(p).size }));
for (const dir of ["dist/src", "dist/web"]) {
  const tree = hashTree(dir);
  if (tree) artifacts.push({ path: dir, ...tree });
}
const demoDir = join(workDir, "demo");
if (existsSync(demoDir)) for (const f of readdirSync(demoDir)) artifacts.push({ path: relative(root, join(demoDir, f)), sha256: sha256(join(demoDir, f)), bytes: statSync(join(demoDir, f)).size });

const receipt = {
  receipt_version: 1,
  verdict: finalVerdict,
  verdict_reasons: reasons,
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  run_time_seconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
  command: redact(`bash scripts/verify-quality.sh ${args.join(" ")}`.trim()),
  exit_code: verdictIsAcceptable(finalVerdict) ? 0 : 1,
  repository: { head_sha: gitHead, branch: out("git", ["branch", "--show-current"]), dirty: porcelain.length > 0, status_porcelain: porcelain, worktrees },
  environment: {
    node: nodeVersion,
    npm: out("npm", ["-v"]),
    platform: `${platform()}-${arch()}`,
    docker: out("docker", ["version", "--format", "{{.Server.Version}}"]),
    postgres_image: out("docker", ["image", "inspect", "postgres:17-alpine", "--format", "{{index .RepoDigests 0}}"]),
    toolchain: { typescript: pkg.devDependencies.typescript, vitest: pkg.devDependencies.vitest, playwright: pkg.devDependencies["@playwright/test"] },
  },
  fixture_version: fixtureVersion,
  steps,
  tests,
  coverage,
  skipped_tests: tests?.skipped_tests ?? [],
  matrix,
  human_receipt_valid: humanReceiptValid,
  unresolved_findings: unresolved,
  artifacts,
};
const receiptPath = join(receiptDir, `receipt-${stamp}-${(gitHead ?? "nosha").slice(0, 8)}.json`);
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

console.log(`\n== VERDICT: ${finalVerdict}`);
for (const r of reasons) console.log(`   - ${r}`);
console.log(`receipt: ${relative(root, receiptPath)}`);
process.exit(receipt.exit_code);
