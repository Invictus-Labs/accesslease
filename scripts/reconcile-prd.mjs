#!/usr/bin/env node
// Reconcile the "Proven by" cells of PRD section 5b (docs/prd/accesslease.md and .html) to REAL test identifiers, generated from the
// vitest and Playwright JSON reports of an actual run. Only that cell changes. Identifiers have the form `file :: describe > test`.
//   node scripts/reconcile-prd.mjs --vitest vitest.json --playwright playwright.json [--check]
// --check exits 1 when the committed cells differ from what the reports would produce (so stale pointers fail the gate).
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? resolve(argv[argv.indexOf(name) + 1]) : null);
const vitestFile = opt("--vitest");
const playwrightFile = opt("--playwright");
const check = argv.includes("--check");
if (!vitestFile) {
  console.error("reconcile-prd: --vitest FILE is required");
  process.exit(2);
}

const SPEC = "tests/accesslease.spec.ts";
// AC -> vitest describe titles (the PRD 5b flow names) and Playwright test-title fragments that also prove the row.
const MAP = {
  "AC-01": { describe: "scope and TTL policy", e2e: ["policy rejections are shown as errors"] },
  "AC-02": { describe: "approval freshness", e2e: [] },
  "AC-03": { describe: "native TTL and issue ambiguity", e2e: [] },
  "AC-04": { describe: "expiry and closure", e2e: [] },
  "AC-05": { describe: "revocation outage", e2e: ["a provider outage shows REVOCATION UNCONFIRMED"] },
  "AC-06": { describe: "restart sweep", e2e: [] },
  "AC-07": { describe: "real denial proof", e2e: ["operator walks a lease from request to verified revocation"] },
  "AC-08": { describe: "offline demo", e2e: [] },
  "AC-09": { describe: "redaction and hostile input", e2e: ["hostile HTML in lease fields", "hostile fields and planted secrets render", "a corrupt report-data file"] },
  "AC-10": { describe: "portability and corruption", e2e: [] },
  "AC-12": { describe: "workspace isolation", e2e: ["viewers get a read-only view"] },
  "AC-13": { describe: "restart and restore", e2e: [] },
};
const GATE = {
  "AC-04": ["scripts/gate.mjs :: cli-demo-offline"],
  "AC-08": ["scripts/gate.mjs :: offline-outbound-denied-demo", "scripts/gate.mjs :: cli-demo-offline"],
  "AC-09": ["scripts/gate.mjs :: secret-and-hygiene-scan"],
};

const vitest = JSON.parse(readFileSync(vitestFile, "utf8"));
const specTests = vitest.testResults.filter((s) => relative(root, s.name) === SPEC).flatMap((s) => s.assertionResults ?? []);
const playwright = playwrightFile ? JSON.parse(readFileSync(playwrightFile, "utf8")) : { suites: [] };
const pwTests = [];
const walk = (suite, file) => {
  for (const spec of suite.specs ?? []) pwTests.push({ file: suite.file ?? file, title: spec.title });
  for (const child of suite.suites ?? []) walk(child, child.file ?? suite.file ?? file);
};
for (const suite of playwright.suites ?? []) walk(suite, suite.file);

const cells = {};
for (const [ac, m] of Object.entries(MAP)) {
  const ids = specTests.filter((t) => t.ancestorTitles[0] === m.describe).map((t) => `${SPEC} :: ${t.ancestorTitles.join(" > ")} > ${t.title}`);
  if (ids.length === 0) throw new Error(`${ac}: no vitest tests found under describe "${m.describe}"`);
  const e2e = m.e2e.flatMap((frag) => {
    const hit = pwTests.filter((t) => t.title.includes(frag));
    if (hit.length === 0 && playwrightFile) throw new Error(`${ac}: no Playwright test matching "${frag}"`);
    return hit.map((t) => `tests/e2e/${t.file.split("/").pop()} :: ${t.title}`);
  });
  cells[ac] = [...ids, ...e2e, ...(GATE[ac] ?? [])];
}

// AC-11 is human-only: point at the drill and the supplemental harness, and say plainly that no agent may pass it.
cells["AC-11"] = ["docs/qa/ac-11-human-drill.md :: independent human drill (status PENDING_HUMAN_RECEIPT; no agent may mark it PASS)", "scripts/fresh-operator-smoke.mjs :: SUPPLEMENTAL, AGENT-RUN harness of the runbook (not the human receipt)"];

const md = (ids) => ids.map((id) => `\`${id}\``).join("; ");
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (ids) => ids.map((id) => `<code>${escapeHtml(id)}</code>`).join("<br>\n");

let changed = false;
function patch(file, transform) {
  const path = resolve(root, file);
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after !== before) {
    changed = true;
    if (!check) writeFileSync(path, after);
  }
  console.log(`${file}: ${after === before ? "already reconciled" : check ? "STALE" : "updated"}`);
}

patch("docs/prd/accesslease.md", (text) =>
  text.replace(/^\| (AC-\d\d) \| ([^|]*) \| (.*?) \| ([^|]*) \| ([^|]*) \|$/gm, (line, ac, level, proven, execution, status) => {
    if (!cells[ac]) return line;
    return `| ${ac} | ${level} | ${md(cells[ac])} | ${execution} | ${status} |`;
  }),
);
patch("docs/prd/accesslease.html", (text) =>
  text.replace(/<td>(AC-\d\d)<\/td>\n<td>([^<]*)<\/td>\n<td>([\s\S]*?)<\/td>\n<td>([^<]*)<\/td>\n<td>([^<]*)<\/td>/g, (block, ac, level, proven, execution, status) => {
    if (!cells[ac]) return block;
    return `<td>${ac}</td>\n<td>${level}</td>\n<td>${html(cells[ac])}</td>\n<td>${execution}</td>\n<td>${status}</td>`;
  }),
);
if (check && changed) process.exit(1);
