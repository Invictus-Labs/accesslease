#!/usr/bin/env node
// Negative controls: seeded behavioral mutations of safety rules, applied to an isolated snapshot (never the working tree).
// Each mutation must make its named tests fail with a real assertion failure; a surviving mutation, a mutation that fails only by
// crashing, an ambiguous anchor, or files that do not restore byte-for-byte all fail the gate.
//   node scripts/verify-mutations.mjs [--report FILE] [--only "name substring"] [--with-baseline]
// Needs the same environment as the test suite (ACCESSLEASE_TEST_* variables) because the killing tests are the real ones.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MUTATIONS } from "./mutations.mjs";

const sourceRoot = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const only = option("--only");
const reportPath = option("--report");
const withBaseline = argv.includes("--with-baseline");
const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;
if (selected.length === 0) {
  console.error("negative controls: no mutations selected; refusing a vacuous pass");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "accesslease-mutations-"));
const results = [];
const copy = ["src", "tests", "migrations", "schemas", "fixtures", "scripts", "templates", "package.json", "tsconfig.json", "tsconfig.web.json", "vitest.config.ts", "vite.config.ts"];
const sha = (text) => createHash("sha256").update(text).digest("hex");
let exitCode = 0;

const tsc = () => spawnSync(process.execPath, [join(sourceRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: root, encoding: "utf8", timeout: 240_000 });
const jsonOut = join(root, "result.json");
function runTests(test, grep) {
  rmSync(jsonOut, { force: true });
  const args = [join(sourceRoot, "node_modules/vitest/vitest.mjs"), "run", test, ...(grep ? ["-t", grep] : []), "--reporter=json", `--outputFile=${jsonOut}`];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: process.env, timeout: 900_000 });
  let data;
  try {
    data = JSON.parse(readFileSync(jsonOut, "utf8"));
  } catch {
    throw new Error(`mutation instrument produced no test report\n${result.stdout}\n${result.stderr}`);
  }
  if (result.error || result.signal || !data.numTotalTests) throw new Error("mutation instrument failed or ran no tests");
  return { result, data };
}

try {
  for (const entry of copy) if (existsSync(join(sourceRoot, entry))) cpSync(join(sourceRoot, entry), join(root, entry), { recursive: true });
  symlinkSync(join(sourceRoot, "node_modules"), join(root, "node_modules"), "dir");

  if (withBaseline) {
    for (const key of new Set(selected.map((m) => `${m.test}\0${m.grep ?? ""}`))) {
      const [test, grep] = key.split("\0");
      const base = runTests(test, grep || undefined);
      if (base.result.status !== 0 || base.data.numFailedTests) throw new Error(`mutation baseline must be green: ${test} -t ${grep} (${base.data.numFailedTests} failing)`);
      console.log(`BASELINE PASS ${grep || test}: ${base.data.numPassedTests} tests`);
    }
  }

  for (const m of selected) {
    const originals = new Map();
    const record = { name: m.name, rule: m.rule, test: m.test, grep: m.grep ?? null, outcome: "", failing_tests: [] };
    results.push(record);
    try {
      let anchorError = null;
      for (const change of m.changes) {
        const path = join(root, change.file);
        const original = originals.get(path) ?? readFileSync(path, "utf8");
        originals.set(path, original);
        const occurrences = original.split(change.find).length - 1;
        if (occurrences !== 1) {
          anchorError = `${change.file}: anchor must occur exactly once, found ${occurrences}`;
          break;
        }
      }
      if (anchorError) {
        record.outcome = `ANCHOR_ERROR (${anchorError})`;
        console.error(`ANCHOR ERROR ${m.name}: ${anchorError}`);
        exitCode = 1;
        continue;
      }
      for (const change of m.changes) {
        const path = join(root, change.file);
        writeFileSync(path, readFileSync(path, "utf8").replace(change.find, () => change.replace));
      }
      if (m.rebuild) {
        const built = tsc();
        if (built.status !== 0) {
          record.outcome = "BUILD_ERROR";
          console.error(`BUILD ERROR ${m.name}\n${built.stdout}`);
          exitCode = 1;
          continue;
        }
      }
      const { result, data } = runTests(m.test, m.grep);
      const failed = data.testResults.flatMap((suite) => suite.assertionResults ?? []).filter((t) => t.status === "failed");
      const behavioral = failed.some((t) => t.failureMessages.some((msg) => /AssertionError|expected .* to/.test(msg)));
      record.failing_tests = failed.map((t) => t.fullName);
      if (result.status === 1 && failed.length > 0 && behavioral) {
        record.outcome = "KILLED";
        console.log(`KILLED   ${m.name}: ${failed.length} failing test(s), e.g. "${failed[0].fullName}"`);
      } else {
        record.outcome = failed.length > 0 ? "FAILED_WITHOUT_ASSERTION" : "SURVIVED";
        console.error(`${record.outcome} ${m.name}`);
        exitCode = 1;
      }
    } finally {
      for (const [path, original] of originals) writeFileSync(path, original);
      for (const [path, original] of originals) if (sha(readFileSync(path, "utf8")) !== sha(original)) throw new Error(`failed to restore ${path}`);
    }
  }
  const killed = results.filter((r) => r.outcome === "KILLED").length;
  console.log(`negative controls: ${killed}/${selected.length} mutations killed by assertions`);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ mutations: results }, null, 2)}\n`);
process.exit(exitCode);
