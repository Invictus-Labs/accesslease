#!/usr/bin/env node
// Gate step: run the PACKAGED CLI demo (SYNTHETIC provider, fixed clock) in a fresh temporary directory under a network guard, then
// check exit code, owner-only permissions, report content and that zero outbound connections other than the database were attempted.
//   node scripts/demo-smoke.mjs --out DIR     (DIR receives copies of the demo artifacts for the receipt hashes)
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const root = resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const receiptOut = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : null;
const adminUrl = process.env.ACCESSLEASE_TEST_DATABASE_URL;
if (!adminUrl) {
  console.error("demo-smoke: ACCESSLEASE_TEST_DATABASE_URL is required (a disposable PostgreSQL server)");
  process.exit(1);
}
const cli = join(root, "dist/src/cli.js");
if (!existsSync(cli)) {
  console.error("demo-smoke: dist/src/cli.js is missing; run `npm run build` first");
  process.exit(1);
}
const fail = (message) => {
  console.error(`demo-smoke: FAIL ${message}`);
  process.exitCode = 1;
};

const name = `al_demo_${randomBytes(5).toString("hex")}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${name}`;
const work = mkdtempSync(join(tmpdir(), "al-demo-smoke-"));
const out = join(work, "demo-out");
const netLog = join(work, "net.log");
try {
  const result = spawnSync(process.execPath, ["--import", join(root, "tests/helpers/netguard.mjs"), cli, "demo", "--out", out], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: work,
      ACCESSLEASE_DATABASE_URL: dbUrl.toString(),
      ACCESSLEASE_SECRET_KEY: randomBytes(32).toString("base64"),
      QA_NET_LOG: netLog,
      QA_NET_ALLOW: `${dbUrl.hostname}:${dbUrl.port}`,
    },
    timeout: 120_000,
  });
  console.log(result.stdout);
  console.error(result.stderr);
  if (![0, 4].includes(result.status)) fail(`demo exited ${result.status}; expected 0, or 4 for the deliberately unresolved demo leases`);
  const attempts = existsSync(netLog) ? readFileSync(netLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const blocked = attempts.filter((a) => a.blocked);
  if (blocked.length > 0) fail(`outbound network attempts were made: ${JSON.stringify(blocked)}`);
  if (!existsSync(out)) fail("demo produced no output directory");
  else {
    const files = readdirSync(out);
    if (files.length === 0) fail("demo output directory is empty");
    if ((statSync(out).mode & 0o777) !== 0o700) fail(`output directory mode is ${(statSync(out).mode & 0o777).toString(8)}, expected 700`);
    for (const f of files) if ((statSync(join(out, f)).mode & 0o077) !== 0) fail(`${f} is accessible to group or others`);
    const reportPath = join(out, "report.html");
    if (!existsSync(reportPath)) fail("report.html was not written");
    else {
      const html = readFileSync(reportPath, "utf8");
      if (!html.includes("SYNTHETIC")) fail("the report does not label the provider SYNTHETIC");
      if (/<script/i.test(html)) fail("the static report contains a script element");
      if (/LIVE_LOCAL_POSTGRES/.test(html)) fail("a synthetic demo report claims a live provider");
    }
    if (receiptOut) {
      mkdirSync(receiptOut, { recursive: true });
      for (const f of files) copyFileSync(join(out, f), join(receiptOut, f));
    }
    console.log(`demo-smoke: ${files.length} files, ${attempts.length} guarded connection(s), exit ${result.status}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}
if (!process.exitCode) console.log("demo-smoke: PASS");
