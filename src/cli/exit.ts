/**
 * Process exit codes (docs/CONTRACT.md section 8). Code 4 exists so that an unresolved uncertain state can
 * never be mistaken for success by a script that only checks "exit code 0".
 */
export const EXIT = {
  /** Done, and no unresolved uncertain state is present. */
  OK: 0,
  /** Unexpected runtime error. */
  RUNTIME: 1,
  /** Invalid input, or refused by policy. */
  INVALID: 2,
  /** A dependency is unavailable, or a live connector is disconnected. Explicit failure, never a silent fallback. */
  UNAVAILABLE: 3,
  /** ISSUE_UNKNOWN or REVOCATION_UNCONFIRMED is present: the result must not be read as success. */
  UNCERTAIN: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error that already knows its exit code. Messages are operator-facing and must never contain secrets. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly code: string = "cli_error",
  ) {
    super(message);
  }
}

/** Bad command line or refused input: exit 2. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.INVALID, "usage");
  }
}

/** A dependency (database, provider, event source) cannot be reached: exit 3. */
export class UnavailableError extends CliError {
  constructor(message: string, code = "dependency_unavailable") {
    super(message, EXIT.UNAVAILABLE, code);
  }
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);
const UNAVAILABLE_CODES = new Set(["adapter_unavailable", "provider_disconnected", "provider_unavailable", "dependency_unavailable", "not_ready", "migration_failed"]);
const INVALID_CODES = new Set(["usage", "report_invalid", "endpoint_refused", "bundle_invalid", "validation_error", "policy_rejected", "forbidden", "not_found", "conflict"]);

/**
 * Map an unknown thrown value to an exit code. Duck-typed on `exitCode`, `code` and `status` so errors from the
 * backend services map without this module importing them.
 */
export function exitCodeForError(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode;
  if (typeof error !== "object" || error === null) return EXIT.RUNTIME;
  const e = error as { exitCode?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
  if (e.exitCode === EXIT.INVALID || e.exitCode === EXIT.UNAVAILABLE) return e.exitCode;
  const code = typeof e.code === "string" ? e.code : "";
  if (NETWORK_CODES.has(code) || UNAVAILABLE_CODES.has(code)) return EXIT.UNAVAILABLE;
  // PostgreSQL: class 08 connection exceptions, 57P03 cannot_connect_now, 3D000 database missing
  if (/^08/.test(code) || code === "57P03" || code === "3D000") return EXIT.UNAVAILABLE;
  if (INVALID_CODES.has(code)) return EXIT.INVALID;
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 0;
  if (status === 503) return EXIT.UNAVAILABLE;
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 413 || status === 422) return EXIT.INVALID;
  if (e.cause) return exitCodeForError(e.cause);
  return EXIT.RUNTIME;
}

/** An unresolved uncertain state turns an otherwise successful run into exit 4. A real error keeps its own code. */
export function finalExitCode(code: ExitCode, uncertainCount: number): ExitCode {
  return code === EXIT.OK && uncertainCount > 0 ? EXIT.UNCERTAIN : code;
}

/** Operator-facing one-line message for an unexpected error; never prints stacks or values from the cause. */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "unexpected error";
}
