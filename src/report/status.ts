/**
 * Presentation rules for lease states, shared by the static report and the React lease view.
 * Pure and dependency free so it can run in the browser and in Node.
 *
 * Rules enforced here (PRD section 6, AC-05):
 *  - only REVOKED_VERIFIED with a recorded verification time may use the "verified" tone;
 *  - ISSUE_UNKNOWN and REVOCATION_UNCONFIRMED are always "uncertain" and never green;
 *  - an expired time is not a revoked state, so nothing here derives state from a clock.
 */

export const LEASE_STATES = [
  "REQUESTED",
  "APPROVED",
  "ISSUING",
  "ACTIVE",
  "ISSUE_UNKNOWN",
  "REVOKING",
  "REVOKED_VERIFIED",
  "REVOCATION_UNCONFIRMED",
] as const;

export type LeaseState = (typeof LEASE_STATES)[number];

/** Visual tone. `verified` is the only green; `uncertain` is the warning style. */
export type Tone = "neutral" | "live" | "progress" | "uncertain" | "verified" | "invalid";

export interface StatePresentation {
  label: string;
  tone: Tone;
  /** True when the outcome of an external side effect is not known; must be visible and never success. */
  uncertain: boolean;
  /** One sentence for the operator: what the state means and what happens next. */
  explanation: string;
}

const TABLE: Record<LeaseState, StatePresentation> = {
  REQUESTED: { label: "Requested", tone: "neutral", uncertain: false, explanation: "Waiting for human approval. No access exists." },
  APPROVED: { label: "Approved", tone: "neutral", uncertain: false, explanation: "Approved; waiting for the worker to issue the provider grant." },
  ISSUING: { label: "Issuing", tone: "progress", uncertain: false, explanation: "The provider grant is being issued." },
  ACTIVE: { label: "Active", tone: "live", uncertain: false, explanation: "Access is live and will be revoked at expiry, on closure or on explicit revocation." },
  ISSUE_UNKNOWN: {
    label: "ISSUE UNKNOWN",
    tone: "uncertain",
    uncertain: true,
    explanation: "The provider did not confirm whether the grant was issued. Access may exist. The system reconciles by looking up the same provider grant and never issues a duplicate.",
  },
  REVOKING: { label: "Revoking", tone: "progress", uncertain: false, explanation: "Revocation was requested and is being verified. This is not yet a revoked state." },
  REVOKED_VERIFIED: {
    label: "Revoked (verified)",
    tone: "verified",
    uncertain: false,
    explanation: "Revocation was independently verified by provider introspection or a denied-use probe.",
  },
  REVOCATION_UNCONFIRMED: {
    label: "REVOCATION UNCONFIRMED",
    tone: "uncertain",
    uncertain: true,
    explanation: "Revocation could not be verified. Access may still exist. The system retries; see the next retry time. Expiry alone does not mean revoked.",
  },
};

export const isLeaseState = (value: unknown): value is LeaseState => typeof value === "string" && (LEASE_STATES as readonly string[]).includes(value);

export const UNCERTAIN_STATES: readonly LeaseState[] = ["ISSUE_UNKNOWN", "REVOCATION_UNCONFIRMED"];

export function isUncertainState(state: string): boolean {
  return state === "ISSUE_UNKNOWN" || state === "REVOCATION_UNCONFIRMED";
}

/**
 * Resolve how a state is shown. Unknown states are shown as invalid, never as success, and a
 * REVOKED_VERIFIED lease without a verification time is flagged instead of shown green.
 */
export function presentState(state: string, lastVerifiedAt?: string | null): StatePresentation {
  if (!isLeaseState(state)) {
    return { label: `Unrecognised state: ${state}`, tone: "invalid", uncertain: true, explanation: "This state is not part of the lease contract. Treat the lease as unresolved." };
  }
  const base = TABLE[state];
  if (state === "REVOKED_VERIFIED" && !lastVerifiedAt) {
    return {
      label: "Revoked state without verification time",
      tone: "invalid",
      uncertain: true,
      explanation: "The record claims verified revocation but has no verification time. Do not treat it as verified; inspect the evidence.",
    };
  }
  return base;
}

/** True when the lease needs an operator's attention (uncertain or inconsistent). */
export function needsAttention(state: string, lastVerifiedAt?: string | null): boolean {
  const p = presentState(state, lastVerifiedAt);
  return p.uncertain || p.tone === "invalid";
}

/**
 * One-line view of an audit event's metadata for display: scalar values only, sorted by key, bounded.
 * The backend stores this metadata already redacted; the renderers still escape (and the report redacts) it.
 */
export function formatMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${String(value)}`);
  }
  const text = parts.join("; ");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** Provider kinds. `synthetic` is always labelled and can never be live evidence. */
export type ProviderKind = "synthetic" | "postgres-role";

export function providerLabel(kind: string): string {
  if (kind === "synthetic") return "SYNTHETIC (not a live provider)";
  if (kind === "postgres-role") return "PostgreSQL role (local provider)";
  if (kind === "mixed") return "Mixed: synthetic and live leases";
  return `Unrecognised provider: ${kind}`;
}
