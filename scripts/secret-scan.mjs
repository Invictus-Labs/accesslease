#!/usr/bin/env node
// Secret and public-repo hygiene scan over every tracked and not-yet-ignored file. Fails on live-looking credentials, personal paths,
// globally routable IP addresses, real-looking e-mail addresses and connection strings that point at a non-local host. Obviously fake
// planted secrets (they say fake/example/planted/synthetic, or are the documented AWS/known examples) are allowed only under tests/,
// fixtures/ and docs/qa/, where redaction and leak tests need them. A self-test proves the scan is not vacuous.
//   node scripts/secret-scan.mjs [--self-test-only]
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const FAKE_ALLOWED_PATHS = [/^tests\//, /^fixtures\//, /^docs\/qa\//, /^scripts\/secret-scan\.mjs$/];
const FAKE_MARKER = /fake|example|planted|synthetic|hunter2|tr0ub4dor|abcdefghijklmnop|0000000000|placeholder|do-not-use/i;

const SECRET_PATTERNS = [
  ["private key", /BEGIN [A-Z ]*PRIVATE KEY(?! BLOCK)/],
  ["live-style API key", /\bsk-(?:live|proj)-[A-Za-z0-9]{16,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._-]{24,}/],
];

const PERSONAL_PATH = /(?:\/Users\/([A-Za-z0-9._-]+)|\/home\/([A-Za-z0-9._-]+)|C:\\Users\\([A-Za-z0-9._-]+))/g;
const GENERIC_USERS = new Set(["someone", "user", "username", "you", "me", "example", "name", "runner", "node", "app", "agent", "alice", "bob", "dev", "developer", "operator", "yourname", "your-name", "knox_example"]);
const EMAIL = /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|invalid|test)\b)(?!anthropic\.com\b)(?!users\.noreply\.github\.com)(?!localhost\b)(?!ex\.test\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|dev|ai|co|me)\b/;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** True for addresses that are not globally routable infrastructure: private, loopback, link-local, CGNAT, documentation, multicast, reserved. */
function reservedOrPrivate([a, b, c]) {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
  );
}

// Connection strings with an embedded password are fine only for loopback or compose-internal hosts, or obvious placeholders.
const URL_WITH_PASSWORD = /\bpostgres(?:ql)?:\/\/([^:\s/@]+):([^@\s/]+)@([^/\s:?]+)/g;
const PLACEHOLDER_PASSWORD = /^(?:\$\{?[A-Za-z_]+\}?|<[^>]+>|\*+|%[A-Za-z_]+|change[-_]?me|placeholder|example|password|secret|pass|\$\{[^}]+\})$/i;
const LOCAL_HOSTS = /^(?:(?:localhost|127\.0\.0\.1|db|postgres|provider-db|host\.docker\.internal)$|[$<{])/;

export function scanText(path, text) {
  const findings = [];
  const fakeOk = FAKE_ALLOWED_PATHS.some((re) => re.test(path));
  text.split("\n").forEach((line, index) => {
    const n = index + 1;
    const lineIsFake = fakeOk && FAKE_MARKER.test(line);
    for (const [name, re] of SECRET_PATTERNS) if (re.test(line) && !lineIsFake) findings.push({ path, line: n, rule: name });
    for (const m of line.matchAll(PERSONAL_PATH)) {
      const user = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase();
      if (!GENERIC_USERS.has(user) && path !== "scripts/secret-scan.mjs") findings.push({ path, line: n, rule: "personal path" });
    }
    if (EMAIL.test(line) && path !== "scripts/secret-scan.mjs") findings.push({ path, line: n, rule: "non-placeholder e-mail" });
    for (const m of line.matchAll(IPV4)) {
      const octets = m.slice(1, 5).map(Number);
      if (octets.some((o) => o > 255)) continue;
      if (!reservedOrPrivate(octets) && !/^tests\//.test(path) && path !== "scripts/secret-scan.mjs") findings.push({ path, line: n, rule: "globally routable IPv4 address" });
    }
    for (const m of line.matchAll(URL_WITH_PASSWORD)) {
      const [, , password, host] = m;
      if (!LOCAL_HOSTS.test(host) && !/\.example\.(?:test|invalid|com|org|net)$/.test(host) && !(PLACEHOLDER_PASSWORD.test(password) && /example|localhost/.test(host)) && path !== "scripts/secret-scan.mjs") {
        findings.push({ path, line: n, rule: "connection string pointing at a non-local host" });
      }
    }
  });
  return findings;
}

function selfTest() {
  const probes = [
    ["src/probe.ts", `const k = "${"AKIA"}${"0123456789ABCDEF"}";`, "AWS access key id"],
    ["README.md", `see ${"/Users"}/jdoe42/work`, "personal path"],
    ["docs/probe.md", `mail ${"ops"}@${"acme"}.com`, "non-placeholder e-mail"],
    ["src/probe.ts", `postgres://admin:hunter2@${"db.internal.corp"}:5432/x`, "connection string pointing at a non-local host"],
    ["docs/probe.md", `connect to ${"8.8"}.${"8.8"}`, "globally routable IPv4 address"],
    ["src/probe.ts", `const t = "${"ghp_"}${"x".repeat(30)}";`, "GitHub token"],
  ];
  for (const [path, text, rule] of probes) {
    if (!scanText(path, text).some((f) => f.rule === rule)) {
      console.error(`secret-scan self-test failed: probe for "${rule}" was not detected (a vacuous scan would pass)`);
      process.exit(1);
    }
  }
  const benign = [
    ["README.md", "postgres://user:${PASSWORD}@localhost:5432/db mail a@example.invalid at 10.0.0.1 and 192.0.2.7, /home/someone/path"],
    ["tests/x.test.ts", `const k = "${"AKIA"}IOSFODNN7EXAMPLE"; // planted fake`],
  ];
  for (const [path, text] of benign) {
    if (scanText(path, text).length !== 0) {
      console.error(`secret-scan self-test failed: benign probe was flagged: ${path}`);
      process.exit(1);
    }
  }
  if (scanText("src/probe.ts", `const k = "${"AKIA"}IOSFODNN7EXAMPLE";`).length === 0) {
    console.error("secret-scan self-test failed: a credential-shaped value outside tests must be flagged even when it says EXAMPLE");
    process.exit(1);
  }
}

selfTest();
if (process.argv.includes("--self-test-only")) {
  console.log("secret-scan self-test: ok");
  process.exit(0);
}

const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
if (listed.status !== 0) {
  console.error("secret-scan: git ls-files failed");
  process.exit(1);
}
const files = listed.stdout.split("\0").filter(Boolean);
const findings = [];
let scanned = 0;
for (const path of files) {
  let st;
  try {
    st = statSync(resolve(root, path));
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > 5_000_000 || /\.(?:png|jpg|jpeg|gif|ico|woff2?|svg|lock)$/i.test(path) || path === "package-lock.json") continue;
  const text = readFileSync(resolve(root, path), "utf8");
  if (text.includes("\0")) continue;
  scanned += 1;
  findings.push(...scanText(path, text));
}
console.log(`secret-scan: scanned ${scanned} files`);
if (scanned < 10) {
  console.error(`secret-scan: scanned too few files (${scanned}); refusing a vacuous pass`);
  process.exit(1);
}
if (findings.length > 0) {
  for (const f of findings) console.error(`${f.path}:${f.line}: ${f.rule}`);
  console.error(`secret-scan: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log("secret-scan: clean");
