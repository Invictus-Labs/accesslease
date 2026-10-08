import { spawnSync } from "node:child_process";

/**
 * Fault injection against the disposable provider cluster. Guarded: only containers whose name starts with `al-`
 * AND that carry the accesslease-test=1 label can be touched, so other containers on the host are never affected.
 */

function docker(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function assertOurs(name: string): void {
  if (!/^al-[a-z0-9-]+$/.test(name)) throw new Error(`refusing to touch container "${name}": not an al- test container`);
  const label = docker(["inspect", name, "--format", '{{index .Config.Labels "accesslease-test"}}']);
  if (label.status !== 0 || label.stdout.trim() !== "1") throw new Error(`refusing to touch container "${name}": missing accesslease-test=1 label`);
}

export function providerContainer(): string {
  const name = process.env.ACCESSLEASE_TEST_PROVIDER_CONTAINER;
  if (!name) throw new Error("ACCESSLEASE_TEST_PROVIDER_CONTAINER is required for outage tests (set by scripts/test-db.sh)");
  assertOurs(name);
  return name;
}

/**
 * Freeze the provider cluster: TCP connects still queue but no query is answered. Models a provider timeout.
 * Pause (not stop) is used because the throwaway containers run with --rm and a stop would destroy their state.
 */
export function pauseProvider(): void {
  const r = docker(["pause", providerContainer()]);
  if (r.status !== 0) throw new Error(`docker pause failed: ${r.stderr}`);
}

export function unpauseProvider(): void {
  // Cleanup hooks call this unconditionally. Without a provider container (the Node 22 container run) pauseProvider throws
  // before pausing anything, so there is nothing to unpause.
  if (!process.env.ACCESSLEASE_TEST_PROVIDER_CONTAINER) return;
  const r = docker(["unpause", providerContainer()]);
  if (r.status !== 0 && !/not paused/i.test(r.stderr)) throw new Error(`docker unpause failed: ${r.stderr}`);
}

export function isProviderPaused(): boolean {
  return docker(["inspect", providerContainer(), "--format", "{{.State.Paused}}"]).stdout.trim() === "true";
}

/** Run a body with the provider paused and always unpause afterwards. */
export async function withProviderPaused<T>(body: () => Promise<T>): Promise<T> {
  pauseProvider();
  try {
    return await body();
  } finally {
    unpauseProvider();
  }
}
