#!/usr/bin/env node
// Negative control for the gate itself: a seeded mandatory failure must make (1) the real test runner exit non-zero and
// (2) the release verdict RED. A passing control run must stay green. Exit 0 only when all three hold.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { computeVerdict, parseMatrix } from "./lib/verdict.mjs";

const root = resolve(import.meta.dirname, "..");
// A fresh private report per invocation prevents an earlier success/failure from certifying this run.
const reports = mkdtempSync(join(tmpdir(), "al-seeded-proof-"));
process.on("exit", () => rmSync(reports, { recursive: true, force: true }));
const testFile = "tests/negative-controls/seeded-failure.test.ts";
const describeTitle = "seeded mandatory failure (negative control)";
const testTitle = "mandatory control stays green unless a failure is seeded";
const fullName = `${describeTitle} ${testTitle}`;

function vitest(seeded) {
  const report = join(reports, seeded ? "seeded.json" : "clean.json");
  const junit = join(reports, seeded ? "seeded.xml" : "clean.xml");
  const result = spawnSync("npx", ["vitest", "run", testFile, "--reporter=json", "--reporter=junit", `--outputFile.json=${report}`, `--outputFile.junit=${junit}`], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ACCESSLEASE_SEEDED_FAILURE: seeded ? "1" : "0" },
  });
  const reject = () => {
    // Do not print arbitrary runner output or report values into a successful release receipt.
    console.error(`seeded-failure control: ${seeded ? "seeded assertion failure" : "clean assertion pass"} was not proven by this runner invocation`);
    process.exit(1);
  };
  if (result.error || result.signal !== null || result.status !== (seeded ? 1 : 0)) reject();
  let data;
  let xml;
  try { data = JSON.parse(readFileSync(report, "utf8")); xml = readFileSync(junit, "utf8"); } catch { reject(); }
  // Pinned Vitest JSON omits unhandled-error totals. Its JUnit root includes them separately from assertion failures.
  const rootTag = /^\s*(?:<\?xml[^?]*\?>\s*)?<testsuites\b([^>]*)>/.exec(xml);
  const attribute = (name, value) => new RegExp(`(?:^|\\s)${name}="${value}"(?:\\s|$)`).test(rootTag?.[1] ?? "");
  if (!rootTag || !/<\/testsuites>\s*$/.test(xml) || !attribute("errors", "0") || !attribute("tests", "1") ||
      !attribute("failures", seeded ? "1" : "0")) reject();
  if (!data || data.success !== !seeded || data.numTotalTests !== 1 || data.numPassedTests !== (seeded ? 0 : 1) ||
      data.numFailedTests !== (seeded ? 1 : 0) || data.numPendingTests !== 0 || data.numTodoTests !== 0 ||
      (data.numRuntimeErrorTestSuites !== undefined && data.numRuntimeErrorTestSuites !== 0) ||
      (data.unhandledErrors !== undefined && (!Array.isArray(data.unhandledErrors) || data.unhandledErrors.length !== 0)) ||
      !Array.isArray(data.testResults) || data.testResults.length !== 1) reject();
  const suite = data.testResults[0];
  if (!suite || suite.name !== resolve(root, testFile) || suite.status !== (seeded ? "failed" : "passed") || suite.message !== "" ||
      !Array.isArray(suite.assertionResults) || suite.assertionResults.length !== 1) reject();
  const assertion = suite.assertionResults[0];
  if (!assertion || assertion.fullName !== fullName || assertion.title !== testTitle ||
      !Array.isArray(assertion.ancestorTitles) || assertion.ancestorTitles.length !== 1 || assertion.ancestorTitles[0] !== describeTitle ||
      assertion.status !== (seeded ? "failed" : "passed") || !Array.isArray(assertion.failureMessages)) reject();
  if (seeded) {
    if (assertion.failureMessages.length !== 1 || typeof assertion.failureMessages[0] !== "string" ||
        !/^AssertionError: expected ['"]seeded-failure-active['"] to be ['"]no-failure-seeded['"]/.test(assertion.failureMessages[0])) reject();
  } else if (assertion.failureMessages.length !== 0) reject();
  return result;
}

const clean = vitest(false);
console.log("seeded-failure control: un-seeded run passes (exit 0)");
const seeded = vitest(true);
console.log("seeded-failure control: intended named assertion fails as required (exit 1)");

// Feed the seeded outcome through the real verdict function with an otherwise perfect matrix.
const perfect = parseMatrix(
  Array.from({ length: 13 }, (_, i) => `| AC-${String(i + 1).padStart(2, "0")} | ${i === 10 ? "PENDING_HUMAN_RECEIPT" : "PASS"} | x |`).join("\n"),
);
const green = computeVerdict({ steps: [{ name: "tests", required: true, status: "PASS" }], matrix: perfect });
if (green.verdict !== "GREEN_PENDING_HUMAN_RECEIPT") {
  console.error(`seeded-failure control: baseline verdict should be GREEN_PENDING_HUMAN_RECEIPT, got ${green.verdict}`);
  process.exit(1);
}
const red = computeVerdict({ steps: [{ name: "tests", required: true, status: seeded.status === 0 ? "PASS" : "FAIL" }], matrix: perfect });
if (red.verdict !== "RED") {
  console.error(`seeded-failure control: a failed mandatory step produced verdict ${red.verdict}, expected RED`);
  process.exit(1);
}
const skipped = computeVerdict({ steps: [{ name: "tests", required: true, status: "SKIPPED" }], matrix: perfect });
if (skipped.verdict !== "RED") {
  console.error(`seeded-failure control: a skipped required step produced verdict ${skipped.verdict}, expected RED`);
  process.exit(1);
}
const partial = computeVerdict({ steps: [{ name: "tests", required: true, status: "PASS" }], matrix: parseMatrix(Array.from({ length: 13 }, (_, i) => `| AC-${String(i + 1).padStart(2, "0")} | ${i === 10 ? "PENDING_HUMAN_RECEIPT" : i === 6 ? "PARTIAL" : "PASS"} | x |`).join("\n")) });
if (partial.verdict !== "RED") {
  console.error(`seeded-failure control: a PARTIAL required row produced verdict ${partial.verdict}, expected RED`);
  process.exit(1);
}
const agentPass = computeVerdict({ steps: [{ name: "tests", required: true, status: "PASS" }], matrix: parseMatrix(Array.from({ length: 13 }, (_, i) => `| AC-${String(i + 1).padStart(2, "0")} | PASS | x |`).join("\n")), humanReceiptValid: false });
if (agentPass.verdict !== "RED") {
  console.error(`seeded-failure control: AC-11 PASS without a human receipt produced verdict ${agentPass.verdict}, expected RED`);
  process.exit(1);
}
console.log("seeded-failure control: verdict is RED for a failed step, a skipped step, a PARTIAL row and an agent-marked AC-11");
