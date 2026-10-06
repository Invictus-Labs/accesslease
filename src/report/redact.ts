/**
 * Defence-in-depth redaction applied to every free-text value before it reaches a report or the CLI output.
 * The backend is the authority on what is stored; this makes sure a credential-shaped value that slipped
 * into an operator-supplied field (task reference, reason, audit action) or into an untrusted saved
 * report-data file is not printed. The token shapes mirror the backend's src/lib/redact.ts.
 */

export const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // scheme://user:password@host  -> keep scheme and host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
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
  [/\b[A-Za-z0-9_-]*(?:planted|canary|fakesecret|fake[-_]secret|fake[-_]token|fake[-_]key)[A-Za-z0-9_-]*\b/gi, REDACTED],
  [/\b[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:SECRET|TOKEN|PASSWORD|API_KEY)(?:_[A-Za-z0-9]+)+\b/g, REDACTED],
  // key=value and key: value for credential-like keys; the value runs to whitespace, a quote, a comma or a semicolon
  [
    /\b([\w-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|authorization|private[_-]?key)[\w-]*)(["']?\s*[:=]\s*)(?!(?:select|insert|update|read|write)\b)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
    (_m, key, sep) => `${key}${sep}${REDACTED}`,
  ],
];

export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as never);
  }
  return out;
}
