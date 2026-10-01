import { UsageError } from "./exit.js";

export interface FlagSpec {
  type: "string" | "boolean";
  description: string;
  required?: boolean;
  /** Placeholder shown in help, for example PATH. */
  value?: string;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandSpec {
  name: string;
  summary: string;
  flags: Record<string, FlagSpec>;
  positionals?: PositionalSpec[];
}

export type FlagValues = Record<string, string | boolean>;

export interface ParsedCommand {
  command: string;
  flags: FlagValues;
  positionals: string[];
  help: boolean;
}

/**
 * Parse `command [--flag value | --flag=value | --switch] [positionals]`. Strict: unknown flags, duplicates,
 * missing values and missing required flags are usage errors (exit 2) rather than being ignored.
 */
export function parseCommand(command: string, rest: string[], spec: CommandSpec): ParsedCommand {
  const flags: FlagValues = {};
  const positionals: string[] = [];
  let help = false;
  let literal = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (literal || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`unknown option ${arg} for ${command}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const flag = spec.flags[name];
    if (!flag) throw new UsageError(`unknown option --${name} for ${command}`);
    if (name in flags) throw new UsageError(`--${name} was given more than once`);
    if (flag.type === "boolean") {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = rest[i + 1];
      if (value !== undefined && value.startsWith("--")) value = undefined;
      i += value === undefined ? 0 : 1;
    }
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  if (!help) {
    for (const [name, flag] of Object.entries(spec.flags)) if (flag.required && !(name in flags)) throw new UsageError(`${command} needs --${name}`);
    const required = (spec.positionals ?? []).filter((p) => p.required).length;
    if (positionals.length < required) throw new UsageError(`${command} needs ${spec.positionals?.[positionals.length]?.name ?? "an argument"}`);
    if (positionals.length > (spec.positionals ?? []).length) throw new UsageError(`unexpected argument ${positionals[(spec.positionals ?? []).length]} for ${command}`);
  }
  return { command, flags, positionals, help };
}

export const stringFlag = (flags: FlagValues, name: string): string | undefined => {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
};

export const boolFlag = (flags: FlagValues, name: string): boolean => flags[name] === true;

/** Parse a bounded positive integer flag. */
export function intFlag(flags: FlagValues, name: string, bounds: { min: number; max: number }, fallback: number): number {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new UsageError(`--${name} must be a whole number`);
  const n = Number(raw);
  if (n < bounds.min || n > bounds.max) throw new UsageError(`--${name} must be between ${bounds.min} and ${bounds.max}`);
  return n;
}

export function commandHelp(spec: CommandSpec): string {
  const lines = [`accesslease ${spec.name}${spec.positionals?.length ? ` ${spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ")}` : ""}`, `  ${spec.summary}`];
  for (const p of spec.positionals ?? []) lines.push(`  ${p.name.padEnd(18)} ${p.description}`);
  for (const [name, flag] of Object.entries(spec.flags)) {
    const left = flag.type === "boolean" ? `--${name}` : `--${name} ${flag.value ?? "VALUE"}`;
    lines.push(`  ${left.padEnd(26)} ${flag.description}${flag.required ? " (required)" : ""}`);
  }
  return lines.join("\n");
}
