import { readFileSync } from "node:fs";
import { commandHelp, parseCommand } from "./cli/args.js";
import { describeError, EXIT, exitCodeForError, UsageError } from "./cli/exit.js";
import * as h from "./cli/handlers.js";
import { type CommandDeps, type Io, type Outcome } from "./cli/runtime.js";
import { COMMAND_NAMES, COMMAND_SPECS } from "./cli/specs.js";
import { assetPath } from "./report/assets.js";
import { redactText } from "./report/redact.js";

export type { CommandDeps, Io, Outcome } from "./cli/runtime.js";

const HANDLERS: Record<string, (input: h.HandlerInput) => Promise<Outcome>> = {
  serve: h.serve,
  worker: h.worker,
  migrate: h.migrate,
  "bootstrap-admin": h.bootstrapAdmin,
  demo: h.demo,
  export: h.exportBundle,
  import: h.importBundle,
  "verify-bundle": h.verifyBundle,
  report: h.report,
  doctor: h.doctor,
  events: h.events,
};

/** First clause of a summary for the command list: up to the first sentence or colon, at most 72 characters. */
export function brief(summary: string): string {
  const first = (summary.split(/[.:] /)[0] ?? summary).replace(/\.$/, "");
  if (first.length <= 72) return first;
  const cut = first.slice(0, 72);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))}...`;
}

export const usage = (): string =>
  [
    "usage: accesslease <command> [options]",
    "",
    ...COMMAND_NAMES.map((name) => `  ${name.padEnd(16)} ${brief(COMMAND_SPECS[name]?.summary ?? "")}`),
    "  help [command]   show help for a command",
    "  version          print the version",
    "",
    "exit codes: 0 ok | 1 runtime error | 2 invalid input or refused by policy | 3 dependency unavailable or live connector disconnected | 4 unresolved uncertain state present (not success)",
  ].join("\n");

function version(): string {
  try {
    return (JSON.parse(readFileSync(assetPath("package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * CLI entry. Returns the process exit code, or (for `serve` and `worker`) a function that stops the running command.
 * Expected failures never throw out of here: they print one line to stderr and map to exit 2, 3 or 1.
 */
export async function runCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io, deps: CommandDeps = {}): Promise<Outcome> {
  const originalIo = io;
  io = { ...io, err: (line: string) => originalIo.err(redactText(line)) };
  const [command, ...rest] = argv;
  if (!command) {
    io.err(usage());
    return EXIT.INVALID;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = rest[0];
    if (topic && COMMAND_SPECS[topic]) io.out(commandHelp(COMMAND_SPECS[topic]));
    else if (topic) {
      io.err(`unknown command ${topic}\n${usage()}`);
      return EXIT.INVALID;
    } else io.out(usage());
    return EXIT.OK;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    io.out(`accesslease ${version()}`);
    return EXIT.OK;
  }
  const spec = COMMAND_SPECS[command];
  const handler = HANDLERS[command];
  if (!spec || !handler) {
    io.err(`unknown command ${command}\n${usage()}`);
    return EXIT.INVALID;
  }
  try {
    const parsed = parseCommand(command, rest, spec);
    if (parsed.help) {
      io.out(commandHelp(spec));
      return EXIT.OK;
    }
    return await handler({ flags: parsed.flags, positionals: parsed.positionals, env, io, deps });
  } catch (error) {
    io.err(`accesslease ${command}: ${describeError(error)}`);
    if (error instanceof UsageError) io.err(`run \`accesslease help ${command}\` for usage`);
    return exitCodeForError(error);
  }
}
