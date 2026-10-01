#!/usr/bin/env node
// Negative control for the gate itself: a seeded mandatory failure must make (1) the real test runner exit non-zero and
// (2) the release verdict RED. A passing control run must stay green. Exit 0 only when all three hold.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { computeVerdict, parseMatrix } from "./lib/verdict.mjs";

const root = resolve(import.meta.dirname, "..");
const vitest = (seeded) =>
  spawnSync("npx", ["vitest", "run", "tests/negative-controls/seeded-failure.test.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ACCESSLEASE_SEEDED_FAILURE: seeded ? "1" : "0" },
  });

const clean = vitest(false);
if (clean.status !== 0) {
  console.error("seeded-failure control: the un-seeded run must pass");
  console.error(clean.stdout, clean.stderr);
  process.exit(1);
}
console.log("seeded-failure control: un-seeded run passes (exit 0)");

const seeded = vitest(true);
if (seeded.status === 0) {
  console.error("seeded-failure control: a seeded mandatory failure did NOT fail the test runner");
  process.exit(1);
}
console.log(`seeded-failure control: seeded run fails as required (exit ${seeded.status})`);

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
