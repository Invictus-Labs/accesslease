/**
 * Redaction (AC-09). Planted or real secret tokens must never reach logs, errors, audit metadata,
 * exports or reports. Three layers:
 *   1. key based: values under secret-looking keys are replaced wholesale;
 *   2. pattern based: well-known token shapes and `key=value` assignments inside free text;
 *   3. registered secrets: exact values AccessLease itself issued/derived (credentials, probe secrets).
 */

export const REDACTED = "[REDACTED]";

const SECRET_KEY = /(password|passwd|pwd|secret|token|api[_-]?key|apikey|cookie|authorization|credential|private[_-]?key|session|csrf)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bsk[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // identifiers that announce themselves as fake/planted/canary secrets, e.g. PLANTED_SECRET_TOKEN_9f3a
  /\b[A-Za-z0-9_-]*(?:planted|canary|fakesecret|fake[-_]secret|fake[-_]token|fake[-_]key)[A-Za-z0-9_-]*\b/gi,
  /\b[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:SECRET|TOKEN|PASSWORD|API_KEY)(?:_[A-Za-z0-9]+)+\b/g,
];

/** `password=hunter2`, `"api_key": "abc"`, `token: abc` inside free text. */
const ASSIGNMENT =
  /\b((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;

const registered = new Set<string>();
const MAX_REGISTERED = 10_000;

/** Register an exact secret value (issued credential, probe secret) so any accidental occurrence is scrubbed. */
export function registerSecret(value: string): void {
  if (value.length < 8) return;
  if (registered.size >= MAX_REGISTERED) {
    const oldest = registered.values().next().value;
    if (oldest !== undefined) registered.delete(oldest);
  }
  registered.add(value);
}

export function clearRegisteredSecrets(): void {
  registered.clear();
}

export interface RedactOptions {
  /** Also mask e-mail addresses (logs: "personal fields"). */
  personal?: boolean;
  /** Additional exact secret values for this call. */
  secrets?: readonly string[];
}

export function redactText(text: string, options: RedactOptions = {}): string {
  let out = text;
  for (const secret of [...registered, ...(options.secrets ?? [])]) {
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(URL_USERINFO, `$1${REDACTED}$3`);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(ASSIGNMENT, (_m, key: string) => `${key}${REDACTED}`);
  if (options.personal) out = out.replace(EMAIL, "[REDACTED_EMAIL]");
  return out;
}

/** True when redaction would change the text (used to flag intake of secret-looking content). */
export const containsSecret = (text: string): boolean => redactText(text) !== text;

export function redactDeep(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === "string") return redactText(value, options);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) && typeof item !== "boolean" && typeof item !== "number" ? REDACTED : redactDeep(item, options, depth + 1);
  }
  return out;
}

/**
 * Metadata allow-list for audit events: scalars only, secret-looking keys dropped, strings redacted and truncated.
 * Audit metadata is stored redacted so exports cannot leak what was never stored.
 */
export function auditMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY.test(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = redactText(value).slice(0, 300);
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value.map((v) => redactText(v).slice(0, 200)).slice(0, 50);
  }
  return out;
}
