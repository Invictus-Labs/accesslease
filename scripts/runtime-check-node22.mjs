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
const toContainerHost = (url) => (url ?? "").replace("127.0.0.1", "host.docker.internal");
const db = toContainerHost(process.env.ACCESSLEASE_TEST_DATABASE_URL);
const provider = toContainerHost(process.env.ACCESSLEASE_TEST_PROVIDER_DATABASE_URL);
if (!db || !provider) {
  console.error("runtime-check-node22: ACCESSLEASE_TEST_DATABASE_URL and ACCESSLEASE_TEST_PROVIDER_DATABASE_URL are required");
  process.exit(1);
}

const script = [
  "set -e",
  "node -v",
  "mkdir /work && cd /work",
  "tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./coverage --exclude=./.git --exclude=./docs/qa/receipts -cf - . | tar -xf -",
  "npm ci --no-audit --no-fund",
  "npx tsc -p tsconfig.json --noEmit",
  "npx tsc -p tsconfig.web.json --noEmit",
  "npm run build --silent",
  "node dist/src/cli.js demo --out /tmp/demo-out",
  "test -s /tmp/demo-out/report.html",
  // The container cannot pause the provider (no Docker socket); outage tests detect the missing container variable and
  // are covered on the host run, so only non-fault suites run here.
  "npx vitest run --exclude 'tests/e2e/**'",
].join(" && ");

const result = spawnSync(
  "docker",
  [
    "run", "--rm", "--name", name, "--label", "accesslease-test=1", "--memory", "2g",
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${root}:/src:ro`,
    "-e", `ACCESSLEASE_TEST_DATABASE_URL=${db}`,
    "-e", `ACCESSLEASE_TEST_PROVIDER_DATABASE_URL=${provider}`,
    "-e", "ACCESSLEASE_TEST_IN_CONTAINER=1",
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
