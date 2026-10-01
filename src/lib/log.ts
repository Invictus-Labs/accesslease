import { redactDeep } from "./redact.js";

/**
 * Structured diagnostics. One JSON line per event on stderr by default; every field is redacted
 * (secret keys, token patterns, registered credentials, e-mail addresses). Request bodies, headers
 * and cookies are never passed to the logger in the first place.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export type Logger = (entry: LogEntry) => void;

export function createLogger(write: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)): Logger {
  return (entry) => {
    const safe = redactDeep(entry, { personal: true }) as LogEntry;
    write(JSON.stringify({ ts: new Date().toISOString(), ...safe }));
  };
}

/** Logger that keeps redacted JSON lines in memory (tests assert on `lines`). */
export function memoryLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger((line) => void lines.push(line)), lines };
}

export const silentLogger: Logger = () => undefined;
