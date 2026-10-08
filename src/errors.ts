import type { ErrorCode } from "./domain/types.js";
import { ERROR_CODES } from "./domain/types.js";
import { redactText } from "./lib/redact.js";

/** API error with the PRD error envelope `{error:{code,message,request_id}}`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(redactText(message));
    this.name = "AppError";
  }
}

/** Build an AppError for a registered code; the status comes from the frozen ERROR_CODES table. */
export const fail = (code: ErrorCode, message: string, headers: Record<string, string> = {}): AppError =>
  new AppError(ERROR_CODES[code], code, message, headers);

export const badRequest = (code: ErrorCode, message: string) => fail(code, message);
export const unauthorized = (code: ErrorCode = "unauthorized", message = "Authentication required") => fail(code, message);
export const forbidden = (message = "This action is not permitted for your role") => fail("forbidden", message);
/** Foreign and missing objects look identical so existence never leaks across workspaces. */
export const notFound = () => fail("not_found", "Not found");
export const conflict = (code: ErrorCode, message: string) => fail(code, message);
export const tooLarge = (message = "Payload exceeds the size limit") => fail("payload_too_large", message);
export const unprocessable = (code: ErrorCode, message: string) => fail(code, message);
export const unavailable = (code: ErrorCode, message: string) => fail(code, message);
export const tooManyRequests = (retryAfterSeconds: number) => fail("rate_limited", "Too many requests", { "retry-after": String(retryAfterSeconds) });
