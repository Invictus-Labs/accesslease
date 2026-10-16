import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { sleep } from "./clock.js";

export const repoRoot = resolve(import.meta.dirname, "..", "..");

export interface ChildHandle {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

/** Spawn a child process with an explicit environment (nothing inherited except PATH), capturing line-oriented output. */
export function spawnChild(command: string, args: string[], env: Record<string, string>, cwd = repoRoot): ChildHandle {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const collect = (sink: string[]) => {
    let buffer = "";
    return (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      sink.push(...lines);
    };
  };
  child.stdout!.on("data", collect(stdout));
  child.stderr!.on("data", collect(stderr));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on("close", (code, signal) => done({ code, signal })));
  return {
    child,
    stdout,
    stderr,
    exited,
    async kill(signal = "SIGKILL") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
    },
  };
}

export async function waitForLine(handle: ChildHandle, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = handle.stdout.find((line) => pattern.test(line));
    if (hit) return hit;
    if (handle.child.exitCode !== null) throw new Error(`child exited (${handle.child.exitCode}) before printing ${pattern}: ${handle.stderr.slice(-5).join(" | ")}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for output matching ${pattern}`);
    await sleep(50);
  }
}

/** Run a command to completion and return its exit code and output (CLI end-to-end tests). */
export async function runToCompletion(command: string, args: string[], env: Record<string, string>, options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const handle = spawnChild(command, args, env, options.cwd ?? repoRoot);
  if (options.input !== undefined) handle.child.stdin?.end(options.input);
  const timer = setTimeout(() => handle.child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
  const { code } = await handle.exited;
  clearTimeout(timer);
  return { code, stdout: handle.stdout.join("\n"), stderr: handle.stderr.join("\n") };
}
