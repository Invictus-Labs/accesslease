import { redactDeep } from "../lib/redact.js";

/**
 * Defence-in-depth redaction applied to every free-text value before it reaches a report or the CLI output.
 * The backend is the authority on what is stored; this makes sure a credential-shaped value that slipped
 * into an operator-supplied field (task reference, reason, audit action) or into an untrusted saved
 * report-data file is not printed. The token shapes mirror the backend's src/lib/redact.ts.
 */

export const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // scheme://user:password@host  -> keep scheme and host
  [/(?<![a-z0-9+.-])([+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // PEM blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Authorization / bearer tokens
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // well-known token shapes, wherever they appear in prose
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bsk[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // identifiers that announce themselves as fake, planted or canary secrets
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*?(?:planted|canary|fakesecret|fake[-_]secret|fake[-_]token|fake[-_]key))[A-Za-z0-9_-]+/gi, REDACTED],
  [/\b[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:SECRET|TOKEN|PASSWORD|API_KEY)(?:_[A-Za-z0-9]+)+\b/g, REDACTED],
  // key=value and key: value for credential-like keys (prefixed and suffixed too, matched once per key token so the scan
  // stays linear); the value runs to whitespace, a quote, a comma or a semicolon, and quoted values honour backslash escapes.
  // The first alternative keeps a scope such as pg:app.secrets_vault:select (same rule as src/lib/redact.ts).
  [
    /([.:])((?=[\w-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|authorization|private[_-]?key))[\w-]+:)((?:select|insert|update|read|write)(?=[\s"')\]}]|$|[.,;](?=\s|$)|[,;](?=[a-z][\w.-]*:)))|(^|[^\w-])((?=[\w-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|authorization|private[_-]?key))[\w-]+)(["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
    (match, _scopeBefore, _scopeKey, _privilege, before, key, sep) => (before === undefined ? match : `${before}${key}${sep}${REDACTED}`),
  ],
  // a key already replaced by an earlier pattern (AWS_SECRET_ACCESS_KEY -> [redacted]) still assigns a secret value
  [/(\[redacted\]["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/g, `$1${REDACTED}`],
];

export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as never);
  }
  return out;
}

/** JSON uses the backend's recursive boundary plus the HTML report's text boundary.
 * Redact secret-bearing member names too, retaining distinct members when their masked names collide.
 * Numeric/boolean counts and uncertainty/completeness fields keep their original values.
 */
export function redactedReportJson(value: unknown): string {
  return JSON.stringify(redactDeep(value), (_key: string, item: unknown) => {
    if (typeof item === "string") return redactText(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const entries = Object.entries(item);
    const occupied = new Set(entries.map(([key]) => key));
    const nextSuffix = new Map<string, number>();
    return Object.fromEntries(entries.map(([key, field]) => {
      const masked = redactText(key);
      if (masked === key) return [key, field];
      let safeKey = masked;
      let suffix = nextSuffix.get(masked) ?? 1;
      while (occupied.has(safeKey)) safeKey = `${masked} (${suffix++})`;
      nextSuffix.set(masked, suffix);
      occupied.add(safeKey);
      return [safeKey, field];
    }));
  }, 2);
}
