import { z } from "zod";
import { redactText } from "../report/redact.js";

/** The only envelope major version this consumer understands. */
export const SUPPORTED_MAJOR = 1;

const id = z.string().min(1).max(128);
const token = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/, "must be a short identifier");

/** Version 1 envelope (PRD section 6, adapter boundary). Unknown fields are rejected: a stray field is where a raw credential would hide. */
export const envelopeV1Schema = z
  .object({
    schema_version: z.literal(1),
    event_id: id,
    source: token,
    resource_id: id,
    event_type: token,
    occurred_at: z.iso.datetime({ offset: true }),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidence_ref: z.string().min(1).max(512),
    correlation_id: id.optional(),
  })
  .strict();

export type EventEnvelope = z.infer<typeof envelopeV1Schema>;

export type RejectReason = "not_an_object" | "missing_version" | "unsupported_version" | "invalid_envelope" | "credential_in_event";

export type ParseResult = { ok: true; event: EventEnvelope } | { ok: false; reason: RejectReason; detail: string };

/** Major version of a `schema_version` that may be an integer or a "major.minor" string. */
export function majorVersion(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string") {
    const m = /^(\d{1,6})(\.\d{1,6})*$/.exec(value);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/** True when any string leaf of the value looks like a credential (see report/redact patterns). */
function carriesCredential(value: unknown): boolean {
  if (typeof value === "string") return redactText(value) !== value;
  if (Array.isArray(value)) return value.some(carriesCredential);
  if (value && typeof value === "object") return Object.values(value).some(carriesCredential);
  return false;
}

/**
 * Validate one untrusted envelope. The version gate runs first, so an event from a future major version is
 * reported as unsupported rather than as a malformed v1 event. The bounded `detail` never echoes input values.
 */
export function parseEnvelope(input: unknown): ParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "not_an_object", detail: "event must be a JSON object" };
  const raw = input as Record<string, unknown>;
  if (!("schema_version" in raw)) return { ok: false, reason: "missing_version", detail: "schema_version is required" };
  const major = majorVersion(raw.schema_version);
  if (major !== SUPPORTED_MAJOR) return { ok: false, reason: "unsupported_version", detail: `unsupported schema_version major (supported: ${SUPPORTED_MAJOR})` };
  if (carriesCredential(raw)) return { ok: false, reason: "credential_in_event", detail: "event carries a credential-shaped value and was rejected" };
  const parsed = envelopeV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue && issue.path.length ? issue.path.join(".") : "event";
    return { ok: false, reason: "invalid_envelope", detail: `invalid ${field}: ${issue?.message ?? "schema mismatch"}` };
  }
  return { ok: true, event: parsed.data };
}
