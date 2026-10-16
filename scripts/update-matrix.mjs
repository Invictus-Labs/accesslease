#!/usr/bin/env node
// Regenerate docs/qa/ac-matrix.md from the vitest and Playwright reports of a real run, so a PASS can never be typed by hand: an AC is PASS
// only when every test mapped to it passed and none was skipped; failures make it PARTIAL; a missing live dependency makes it BLOCKED.
// AC-11 is human-only and is never computed: it stays PENDING_HUMAN_RECEIPT unless the matrix already carries a human PASS with a receipt.
//   node scripts/update-matrix.mjs --vitest FILE --playwright FILE --sha FULL_SHA [--gate-receipt FILE]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const vitestFile = opt("--vitest");
const playwrightFile = opt("--playwright");
const sha = opt("--sha");
// --blocker TEXT: an external dependency (for example the container runtime) prevented the live suites from starting; rows that did not
// execute any test are then BLOCKED with this exact reason instead of NOT RUN.
const blocker = opt("--blocker");
if (!vitestFile || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("update-matrix: --vitest FILE and --sha <40 hex> are required");
  process.exit(2);
}
const SPEC = "tests/accesslease.spec.ts";
const rows = {
  "AC-01": { describe: "scope and TTL policy", e2e: ["policy rejections are shown as errors"], level: "Real PostgreSQL + API (7 policy boundaries), browser policy rejection." },
  "AC-02": { describe: "approval freshness", e2e: [], level: "Real PostgreSQL + API: independent plan-hash oracle, changed-field hashes, expired and stale approvals, idempotent replay." },
  "AC-03": { describe: "native TTL and issue ambiguity", e2e: [], level: "LIVE postgres-role: VALID UNTIL equals expiry, narrow role attributes, injected ambiguous issue, real frozen-cluster outage, definite rejection, no-native-TTL refusal." },
  "AC-04": { describe: "expiry and closure", e2e: [], level: "LIVE postgres-role, real wall clock, shipped 5 s poll: revocation requested within 30 s of expiry and of task closure, verified by introspection and probe." },
  "AC-05": { describe: "revocation outage", e2e: ["a provider outage shows REVOCATION UNCONFIRMED"], level: "LIVE: frozen provider cluster (docker pause) and a real partial revoke; API, report and browser never show green." },
  "AC-06": { describe: "restart sweep", e2e: [], level: "LIVE: overdue leases swept before a new lease is issued (provider call order and audit order), redelivered issue job keeps one grant." },
  "AC-07": { describe: "real denial proof", e2e: ["operator walks a lease from request to verified revocation"], level: "LIVE postgres-role: allowed during the lease, native TTL blocks new logins, open session survives until revoked (residual access), denied after expiry and after revocation, residual window measured." },
  "AC-08": { describe: "offline demo", e2e: [], level: "Packaged CLI demo under a network guard, internal Docker network run, explicit failure of a disconnected live connector, no telemetry." },
  "AC-09": { describe: "redaction and hostile input", e2e: ["hostile HTML in lease fields", "hostile fields and planted secrets render", "a corrupt report-data file"], level: "Planted secrets absent from logs, responses, exports, report and database; size and schema rejected before processing; hostile HTML inert in API, static report and UI." },
  "AC-10": { describe: "portability and corruption", e2e: [], level: "Independent canonical-JSON oracle, clean-installation restore, truncated, tampered, unsupported, unsafe-path and oversize bundles leave no partial state." },
  "AC-12": { describe: "workspace isolation", e2e: ["viewers get a read-only view"], level: "Two workspaces: identical 404 for foreign ids on every route, role matrix, CSRF, sessions, rate limit, no state change (table fingerprints)." },
  "AC-13": { describe: "restart and restore", e2e: [], level: "LIVE: SIGKILL of a real worker process mid-provider-call and after the provider commit, failed and modified migrations, pg_dump/pg_restore with references and secrets intact." },
};

const vitest = JSON.parse(readFileSync(vitestFile, "utf8"));
const specTests = vitest.testResults.filter((s) => relative(root, s.name) === SPEC).flatMap((s) => s.assertionResults ?? []);
const pw = playwrightFile && existsSync(playwrightFile) ? JSON.parse(readFileSync(playwrightFile, "utf8")) : { suites: [] };
const pwTests = [];
const walk = (suite, file) => {
  for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) pwTests.push({ file: suite.file ?? file, title: spec.title, status: t.status });
  for (const child of suite.suites ?? []) walk(child, child.file ?? suite.file ?? file);
};
for (const suite of pw.suites ?? []) walk(suite, suite.file);

const short = (message) => String(message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim()) ?.slice(0, 160) ?? "";
const existing = existsSync(resolve(root, "docs/qa/ac-matrix.md")) ? readFileSync(resolve(root, "docs/qa/ac-matrix.md"), "utf8") : "";
const ac11Existing = /^\| AC-11 \| (\S+)/m.exec(existing)?.[1] ?? "PENDING_HUMAN_RECEIPT";
const humanReceipt = existsSync(resolve(root, "docs/qa/receipts/ac-11-human-receipt.md")) ? readFileSync(resolve(root, "docs/qa/receipts/ac-11-human-receipt.md"), "utf8") : "";
const humanOk = /^Performed-by:\s*human\s*$/im.test(humanReceipt) && ac11Existing === "PASS";

const out = [];
out.push("# AccessLease acceptance matrix (QA-owned, graded against `docs/DOD.md`)");
out.push("");
out.push("Generated by `node scripts/update-matrix.mjs` from the vitest and Playwright reports of a real run; a PASS cannot be typed by hand. Status vocabulary: `PASS` only when every mapped test passed against real persistence (and, for live criteria, the real `postgres-role` provider on a disposable cluster) with none skipped; `PARTIAL` when any mapped test failed or was skipped; `BLOCKED` when a live dependency was unavailable; `NOT RUN` when nothing ran. `AC-11` is human-only: an agent can never mark it PASS; it stays `PENDING_HUMAN_RECEIPT` until a non-builder files a receipt (`ac-11-human-drill.md`). The SYNTHETIC provider supports deterministic and fault-injection coverage only and never satisfies a live criterion.");
out.push("");
out.push(`Revision of the run: \`${sha}\`. A row shows a "Tested at SHA" only when at least one of its tests actually executed; "n/a" means nothing ran for that row, so it is not evidence of anything. The matrix is regenerated by every gate run; test identifiers are \`file :: describe > test\`.`);
out.push("");
out.push("| AC | Status | Proven by (`file :: test`) | Tested at SHA | Level, result and notes |");
out.push("| --- | --- | --- | --- | --- |");
for (let n = 1; n <= 13; n += 1) {
  const ac = `AC-${String(n).padStart(2, "0")}`;
  if (ac === "AC-11") {
    out.push(`| AC-11 | ${humanOk ? "PASS" : "PENDING_HUMAN_RECEIPT"} | ${humanOk ? "docs/qa/receipts/ac-11-human-receipt.md" : "none: needs a human receipt (docs/qa/ac-11-human-drill.md)"} | n/a | HUMAN-ONLY. The automated fresh-directory harness (\`scripts/fresh-operator-smoke.mjs\`, labelled SUPPLEMENTAL, AGENT-RUN) and the drill instructions exist; no agent may mark this PASS. |`);
    continue;
  }
  const m = rows[ac];
  const v = specTests.filter((t) => t.ancestorTitles[0] === m.describe);
  const e = m.e2e.flatMap((frag) => pwTests.filter((t) => t.title.includes(frag)));
  const failedV = v.filter((t) => t.status === "failed");
  const skippedV = v.filter((t) => t.status !== "passed" && t.status !== "failed");
  const failedE = e.filter((t) => t.status !== "expected");
  const total = v.length + e.length;
  const blocked = failedV.some((t) => /is required|not reachable|ECONNREFUSED|docker/i.test(t.failureMessages?.[0] ?? ""));
  const passedV = v.filter((t) => t.status === "passed");
  let status = "PASS";
  if (v.length === 0) status = "NOT RUN";
  else if (passedV.length === 0 && failedV.length === 0) status = blocker ? "BLOCKED" : "NOT RUN";
  else if (blocked) status = "BLOCKED";
  else if (failedV.length || failedE.length || skippedV.length) status = "PARTIAL";
  const ids = [
    `${SPEC} :: ${m.describe} (${v.filter((t) => t.status === "passed").length}/${v.length} passed)`,
    ...(e.length ? [`tests/e2e (${e.filter((t) => t.status === "expected").length}/${e.length} passed)`] : []),
  ].join("; ");
  const notes = [m.level];
  if (status === "BLOCKED" && blocker && passedV.length === 0) notes.push(`BLOCKER: ${blocker}`);
  const listed = (label, items) => {
    if (items.length === 0) return;
    notes.push(`${label} ${items.length}: ${items.slice(0, 2).map((t) => t.title.slice(0, 90)).join("; ")}${items.length > 2 ? `; +${items.length - 2} more` : ""}.`);
  };
  for (const t of failedV.slice(0, 3)) notes.push(`FAILING: ${t.title.slice(0, 110)} - ${short(t.failureMessages?.[0])}`);
  if (status !== "BLOCKED") listed("FAILING (browser)", failedE);
  if (!(status === "BLOCKED" && passedV.length === 0)) listed("SKIPPED", skippedV);
  out.push(`| ${ac} | ${status} | ${ids} | ${total && passedV.length + failedV.length > 0 ? sha : "n/a"} | ${notes.join(" ").replace(/\|/g, "/")} |`);
}
out.push("");
const register = existing.includes("## Defect register") ? existing.slice(existing.indexOf("## Defect register")) : "";
writeFileSync(resolve(root, "docs/qa/ac-matrix.md"), out.join("\n") + (register ? `\n${register}` : ""));
console.log("update-matrix: wrote docs/qa/ac-matrix.md");
