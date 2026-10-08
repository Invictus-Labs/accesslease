#!/usr/bin/env node
// Supported-runtime check on Docker node:22: install from the lockfile, typecheck, build, run the CLI demo and the
// real-PostgreSQL test suite inside a node:22 container against the host's throwaway PostgreSQL pair. The npm install needs the
// package registry (a developer-toolchain step, not part of the product's deterministic core).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const image = process.env.ACCESSLEASE_NODE22_IMAGE ?? "node:22-alpine";
const name = `al-node22-${randomBytes(4).toString("hex")}`;
const db = process.env.ACCESSLEASE_TEST_DATABASE_URL;
const provider = process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL;
if (!db || !provider) {
  console.error("runtime-check-node22: ACCESSLEASE_TEST_DATABASE_URL and ACCESSLEASE_TEST_PROVIDER_DATABASE_URL are required");
  process.exit(1);
}
// The suites and their egress allowlists address the throwaway pair as 127.0.0.1. Inside the container a TCP relay listens on
// the same loopback ports and forwards straight to the database containers on the Docker bridge network (container to
// container, not through the host port forwarder, which dropped connections intermittently), so the tests run unchanged.
const bridgeAddress = (container) => {
  // Only the labelled throwaway test containers may be targeted (same rule as tests/helpers/docker.ts).
  if (!/^al-[a-z0-9-]+$/.test(container)) throw new Error(`runtime-check-node22: refusing container "${container}": not an al- test container`);
  const r = spawnSync("docker", ["inspect", "-f", '{{index .Config.Labels "accesslease-test"}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', "--", container], { encoding: "utf8", timeout: 15_000 });
  const [label, address] = (r.stdout ?? "").trim().split(/\s+/);
  if (r.status !== 0 || label !== "1" || !address) throw new Error(`runtime-check-node22: cannot use ${container} (missing accesslease-test=1 label or bridge address)`);
  return address;
};
const meta = process.env.ACCESSLEASE_TEST_META_CONTAINER;
const prov = process.env.ACCESSLEASE_TEST_PROVIDER_CONTAINER;
if (!meta || !prov) {
  console.error("runtime-check-node22: ACCESSLEASE_TEST_META_CONTAINER and ACCESSLEASE_TEST_PROVIDER_CONTAINER are required (set by scripts/test-db.sh)");
  process.exit(1);
}
const routes = { [Number(new URL(db).port)]: bridgeAddress(meta), [Number(new URL(provider).port)]: bridgeAddress(prov) };
const ports = Object.keys(routes).map(Number);
const relay = `const net=require("net");const routes=${JSON.stringify(routes)};for(const p of Object.keys(routes))net.createServer((c)=>{const u=net.connect(5432,routes[p]);c.setNoDelay(true);u.setNoDelay(true);c.pipe(u).pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());}).listen(Number(p),"127.0.0.1");`;
const waitRelay = `const net=require("net");const ports=${JSON.stringify(ports)};const t=Date.now();(function f(){Promise.all(ports.map((p)=>new Promise((ok,no)=>{const s=net.connect(p,"127.0.0.1",()=>{s.end();ok();});s.on("error",no);}))).then(()=>process.exit(0),()=>Date.now()-t>10000?process.exit(1):setTimeout(f,100));})();`;
// Tests that need the Docker socket (provider pause, container exec for backup/restore, an internal Docker network).
const DOCKER_ONLY = [
  "a real provider outage during issuance (cluster frozen)",
  "the demo also completes inside an internal Docker network",
  "login failures, malformed requests and provider errors never echo",
  "planted secrets in free-text request fields never reach",
  "a restored backup preserves every reference",
  "a worker killed while the provider call is in flight",
  "a frozen provider during explicit revocation",
  "expiry during an outage is also unconfirmed",
];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const notDockerOnly = `^(?!.*(?:${DOCKER_ONLY.map(escapeRe).join("|")})).*$`;
const demoDb = `al_demo_${randomBytes(5).toString("hex")}`;
const demoUrlParsed = new URL(db);
demoUrlParsed.pathname = `/${demoDb}`;
const demoUrl = demoUrlParsed.toString();

const script = [
  "set -e",
  "node -v",
  "(node -e \"$AL_RELAY\" &)",
  "node -e \"$AL_WAIT_RELAY\"",
  "mkdir /work && cd /work",
  "tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./coverage --exclude=./.git --exclude=./docs/qa/receipts -cf - . | tar -xf -",
  "npm ci --no-audit --no-fund",
  "npx tsc -p tsconfig.json --noEmit",
  "npx tsc -p tsconfig.web.json --noEmit",
  "npm run build --silent",
  // Like scripts/demo-smoke.mjs: the demo needs its own disposable database and key; exit 4 marks the deliberately unresolved demo leases.
  `node -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.ACCESSLEASE_TEST_DATABASE_URL});c.connect().then(()=>c.query('CREATE DATABASE ${demoDb}')).then(()=>c.end())"`,
  `(ACCESSLEASE_DATABASE_URL='${demoUrl}' ACCESSLEASE_SECRET_KEY='${randomBytes(32).toString("base64")}' node dist/src/cli.js demo --out /tmp/demo-out || [ $? -eq 4 ])`,
  "test -s /tmp/demo-out/report.html",
  // The container has no Docker socket: tests that pause or exec into the disposable containers, start Docker networks or
  // drive scripts/test-db.sh are covered by the host gate run and excluded here by name (DOCKER_ONLY below).
  "npx vitest run --exclude 'tests/e2e/**' --exclude tests/integration/test-db-with.test.ts -t \"$AL_NOT_DOCKER_ONLY\"",
].join(" && ");

const result = spawnSync(
  "docker",
  [
    "run", "--rm", "--name", name, "--label", "accesslease-test=1", "--memory", "2g",
    "-v", `${root}:/src:ro`,
    "-e", `ACCESSLEASE_TEST_DATABASE_URL=${db}`,
    "-e", `ACCESSLEASE_TEST_PROVIDER_DATABASE_URL=${provider}`,
    "-e", "ACCESSLEASE_TEST_IN_CONTAINER=1",
    "-e", `AL_RELAY=${relay}`,
    "-e", `AL_WAIT_RELAY=${waitRelay}`,
    "-e", `AL_NOT_DOCKER_ONLY=${notDockerOnly}`,
    image, "sh", "-c", script,
  ],
  { stdio: "inherit", cwd: root },
);
if (result.status !== 0) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  console.error(`runtime-check-node22: FAILED (exit ${result.status})`);
  process.exit(result.status ?? 1);
}
console.log("runtime-check-node22: PASS on Docker node:22");
