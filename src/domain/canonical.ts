import { createHash } from "node:crypto";

/**
 * Canonical JSON encoding used for every content hash in AccessLease.
 *
 * - object keys sorted by UTF-16 code unit order, recursively
 * - no insignificant whitespace
 * - `undefined` members are omitted (as JSON.stringify does); `null` is kept
 * - Date values are encoded as UTC ISO-8601 strings with millisecond precision
 * - numbers must be finite; non-finite numbers throw (they are not JSON)
 * - arrays keep their order (callers sort sets, e.g. scopes, before hashing)
 */
export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    if (typeof value === "bigint") throw new Error("canonicalJson: bigint is not supported");
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** SHA-256 over the canonical JSON encoding. */
export const contentHash = (value: unknown): string => sha256Hex(canonicalJson(value));
