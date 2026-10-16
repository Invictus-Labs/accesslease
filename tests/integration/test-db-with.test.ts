import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../helpers/clock.js";
import { repoRoot, runToCompletion, spawnChild, waitForLine } from "../helpers/process.js";

/**
 * Regression tests for `scripts/test-db.sh with -- CMD...`: it must always tear down exactly its own pair, return the wrapped command's
 * exit code, and survive SIGTERM. A fake `docker` on PATH (state kept in a temporary directory) makes these deterministic and
 * independent of the container engine, so they run even when Docker is unavailable.
 */
const script = join(repoRoot, "scripts/test-db.sh");
let shim: string;
let state: string;

const SHIM = `#!/usr/bin/env bash
# Fake docker for test-db.sh tests. State: $SHIM_STATE/<container-name> marker files, $SHIM_STATE/calls.log.
set -u
echo "docker $*" >> "$SHIM_STATE/calls.log"
cmd="$1"; shift
name_of_run() { while [[ $# -gt 0 ]]; do if [[ "$1" == "--name" ]]; then echo "$2"; return; fi; shift; done; }
case "$cmd" in
  run) n="$(name_of_run "$@")"; touch "$SHIM_STATE/$n"; echo "fakeid-$n" ;;
  inspect)
    n="$1"; shift
    [[ -f "$SHIM_STATE/$n" ]] || exit 1
    case "$*" in
      *Config.Labels*) echo 1 ;;
      *Config.Env*) echo "POSTGRES_PASSWORD=fakepw" ;;
    esac ;;
  exec) exit 0 ;;
  port) echo "127.0.0.1:5432" ;;
  stop|rm) for a in "$@"; do [[ "$a" == -* || "$a" =~ ^[0-9]+$ ]] || rm -f "$SHIM_STATE/$a"; done ;;
  *) exit 0 ;;
esac
`;

const pairs = () => readdirSync(state).filter((f) => f.startsWith("al-meta-") || f.startsWith("al-prov-")).sort();
const env = () => ({ PATH: `${shim}:${process.env.PATH ?? ""}`, SHIM_STATE: state });

describe("scripts/test-db.sh with", () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "al-testdb-shim-"));
    shim = join(dir, "bin");
    state = join(dir, "state");
    mkdirSync(shim);
    mkdirSync(state);
    writeFileSync(join(shim, "docker"), SHIM);
    chmodSync(join(shim, "docker"), 0o755);
  });
  afterAll(() => rmSync(join(shim, ".."), { recursive: true, force: true }));

  it("a wrapped command that succeeds exits 0 and its pair is removed", async () => {
    const r = await runToCompletion("bash", [script, "with", "--", "sh", "-c", "echo RUN=$ACCESSLEASE_TEST_RUN_ID; echo $ACCESSLEASE_TEST_DATABASE_URL | grep -q postgres://"], env());
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const run = /RUN=([0-9a-f]+)/.exec(r.stdout)?.[1];
    expect(run).toBeTruthy();
    expect(readFileSync(join(state, "calls.log"), "utf8")).toContain(`--name al-meta-${run}`);
    expect(pairs(), "the pair must be gone").toEqual([]);
    expect(r.stderr).not.toContain("unbound variable");
  });

  it("returns the wrapped command's exact exit code and still removes the pair", async () => {
    const r = await runToCompletion("bash", [script, "with", "--", "sh", "-c", "exit 7"], env());
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(7);
    expect(pairs()).toEqual([]);
    expect(r.stderr).not.toContain("unbound variable");
  });

  it("SIGTERM to the wrapper removes the pair, kills the wrapped command and exits 143", async () => {
    const wrapper = spawnChild("bash", [script, "with", "--", "sh", "-c", "echo RUN=$ACCESSLEASE_TEST_RUN_ID; exec sleep 60"], env());
    const line = await waitForLine(wrapper, /^RUN=[0-9a-f]+$/, 30_000);
    const run = line.slice("RUN=".length);
    await waitFor("the pair to exist", async () => existsSync(join(state, `al-meta-${run}`)) && existsSync(join(state, `al-prov-${run}`)), 5000, 50);
    wrapper.child.kill("SIGTERM");
    const exited = await Promise.race([wrapper.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))]);
    expect(exited, "the wrapper must exit promptly on SIGTERM").not.toBeNull();
    expect(exited!.code).toBe(143);
    expect(pairs()).toEqual([]);
    expect(wrapper.stderr.join("\n")).not.toContain("unbound variable");
  }, 60_000);

  it("never touches a pair that belongs to someone else", async () => {
    writeFileSync(join(state, "al-meta-ffff0000"), "");
    writeFileSync(join(state, "al-prov-ffff0000"), "");
    const r = await runToCompletion("bash", [script, "with", "--", "true"], env());
    expect(r.code).toBe(0);
    expect(pairs()).toEqual(["al-meta-ffff0000", "al-prov-ffff0000"]);
    const calls = readFileSync(join(state, "calls.log"), "utf8");
    expect(calls).not.toContain("ffff0000 ");
    expect(calls).not.toMatch(/system prune|volume prune|network prune/);
  });
});
