import type { Ctx } from "../context.js";
import type { Principal } from "../domain/types.js";
import type { AccessLeaseServices } from "../services/contract.js";
import { CliError, EXIT } from "./exit.js";

/** Output sink. The CLI prints operator-facing lines only; it never prints secrets other than a one-time generated password. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Everything a command may need from outside the process. Tests inject fakes; production uses the defaults. */
export interface CommandDeps {
  /** Load the backend service functions (a lazy import so `help` and `verify-bundle --help` stay cheap). */
  services?: () => Promise<AccessLeaseServices>;
  /** Start the HTTP server. Injected so the CLI module does not own routing. */
  startServer?: StartServer;
  /** Process-level pieces that tests replace. */
  randomPassword?: () => string;
}

export interface RunningServer {
  address: string;
  close(): Promise<void>;
}

export type StartServer = (ctx: Ctx, options: { host: string; port: number; webRoot: string; worker: boolean }) => Promise<RunningServer>;

/** A command either finishes with an exit code, or keeps running and returns a function that stops it. */
export type Outcome = number | (() => Promise<void>);

export interface Runtime {
  svc: AccessLeaseServices;
  ctx: Ctx;
  close(): Promise<void>;
}

export async function loadServices(deps: CommandDeps): Promise<AccessLeaseServices> {
  if (deps.services) return deps.services();
  const mod = await import("../services/index.js");
  return mod as unknown as AccessLeaseServices;
}

/** Build the service context from the environment. Configuration problems are invalid input (exit 2), with the diagnostic. */
export async function openRuntime(env: NodeJS.ProcessEnv, deps: CommandDeps): Promise<Runtime> {
  const svc = await loadServices(deps);
  let ctx: Ctx;
  try {
    ctx = svc.contextFromConfig(svc.loadConfig(env));
  } catch (error) {
    throw new CliError(`configuration problem: ${(error as Error).message}`, EXIT.INVALID, "config_invalid");
  }
  return { svc, ctx, close: () => ctx.db.close() };
}

/** Run `fn` with a runtime and always close the database pool. */
export async function withRuntime<T>(env: NodeJS.ProcessEnv, deps: CommandDeps, fn: (rt: Runtime) => Promise<T>): Promise<T> {
  const rt = await openRuntime(env, deps);
  try {
    return await fn(rt);
  } finally {
    await rt.close().catch(() => undefined);
  }
}

export const principalFor = (rt: Runtime, workspace: string | undefined): Promise<Principal> => rt.svc.cliPrincipal(rt.ctx, workspace);
