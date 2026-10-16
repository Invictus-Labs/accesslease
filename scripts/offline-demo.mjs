#!/usr/bin/env node
// Gate step: the outbound-denied demo (AC-08). Runs the packaged Compose project `compose.offline.yaml` (database + smoke container on an
// INTERNAL network, no route off the host) under unique labelled names, then independently probes that the network really is isolated and
// requires the smoke container's own proof (`OFFLINE SMOKE PASSED`). Everything it creates is removed afterwards.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const id = randomBytes(4).toString("hex");
const project = `al-offline-${id}`;
const files = ["-f", "compose.offline.yaml", "-f", "scripts/compose.qa-labels.yaml"];
const env = { ...process.env, POSTGRES_PASSWORD: randomBytes(18).toString("base64url"), ACCESSLEASE_SECRET_KEY: randomBytes(32).toString("base64") };
const docker = (args, options = {}) => spawnSync("docker", args, { cwd: root, env, encoding: "utf8", timeout: 900_000, ...options });
let status = 1;
try {
  const up = docker(["compose", "-p", project, ...files, "up", "--build", "--abort-on-container-exit", "--exit-code-from", "smoke"]);
  const log = `${up.stdout}\n${up.stderr}`;
  process.stdout.write(log.replace(/postgres:\/\/[^@\s]*@/g, "postgres://***@"));
  if (up.status !== 0) throw new Error(`compose smoke exited ${up.status}`);
  if (!log.includes("OFFLINE SMOKE PASSED")) throw new Error("the smoke container did not print OFFLINE SMOKE PASSED");
  if (!log.includes("ok: outbound network is denied")) throw new Error("the smoke container did not prove that outbound access is denied");
  // Independent probes from outside the product's own smoke script.
  const network = `${project}_offline`;
  const inspect = docker(["network", "inspect", network, "--format", "{{.Internal}}"]);
  if (inspect.stdout.trim() !== "true") throw new Error(`network ${network} is not internal (Internal=${inspect.stdout.trim()})`);
  const probe = docker(["run", "--rm", "--label", "accesslease-test=1", "--network", network, "node:22-alpine", "node", "-e",
    "Promise.allSettled([fetch('https://example.com',{signal:AbortSignal.timeout(4000)}),fetch('http://192.0.2.1',{signal:AbortSignal.timeout(3000)})]).then(r=>process.exit(r.every(x=>x.status==='rejected')?0:7))"]);
  if (probe.status !== 0) throw new Error(`an independent container on the offline network could reach the internet (exit ${probe.status})`);
  console.log("offline-demo: PASS (smoke passed, network internal, independent egress probe blocked)");
  status = 0;
} catch (error) {
  console.error(`offline-demo: FAIL ${error instanceof Error ? error.message : error}`);
} finally {
  docker(["compose", "-p", project, ...files, "down", "-v", "--remove-orphans"]);
}
process.exit(status);
