import { type CloseReason, type LeaseState, type RevocationStatus, UNRESOLVED_STATES } from "./types.js";

/**
 * Lease state machine (PRD section 6). Authoritative transition table.
 *
 *   REQUESTED -> APPROVED -> ISSUING -> ACTIVE | ISSUE_UNKNOWN
 *   ISSUE_UNKNOWN -> ACTIVE (reconciled: adopted or re-issued by deterministic provider ref) | REVOKING | ISSUE_UNKNOWN (still unresolved)
 *   REQUESTED | APPROVED | ISSUING | ACTIVE | ISSUE_UNKNOWN -> REVOKING (expiry, task closure, operator revocation, failure cleanup)
 *   REVOKING -> REVOKED_VERIFIED | REVOCATION_UNCONFIRMED
 *   REVOCATION_UNCONFIRMED -> REVOKED_VERIFIED | REVOCATION_UNCONFIRMED (a retry that is still unconfirmed)
 *
 * Elapsed time alone never produces REVOKED_VERIFIED: that state requires independent
 * verification (provider introspection and/or a denied-use probe).
 */
export const TRANSITIONS: Readonly<Record<LeaseState, readonly LeaseState[]>> = {
  REQUESTED: ["APPROVED", "REVOKING"],
  APPROVED: ["ISSUING", "REVOKING"],
  ISSUING: ["ACTIVE", "ISSUE_UNKNOWN", "REVOKING"],
  ACTIVE: ["REVOKING"],
  ISSUE_UNKNOWN: ["ACTIVE", "REVOKING", "ISSUE_UNKNOWN"],
  REVOKING: ["REVOKED_VERIFIED", "REVOCATION_UNCONFIRMED"],
  REVOKED_VERIFIED: [],
  REVOCATION_UNCONFIRMED: ["REVOKED_VERIFIED", "REVOCATION_UNCONFIRMED"],
};

export function canTransition(from: LeaseState, to: LeaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: LeaseState,
    readonly to: LeaseState,
  ) {
    super(`invalid lease transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: LeaseState, to: LeaseState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const isTerminal = (state: LeaseState): boolean => state === "REVOKED_VERIFIED";
export const isUnresolved = (state: LeaseState): boolean => UNRESOLVED_STATES.includes(state);

/** A lease in one of these states can be asked to revoke/close (idempotently if already revoking). */
export const REVOKE_REQUESTABLE: readonly LeaseState[] = ["REQUESTED", "APPROVED", "ISSUING", "ACTIVE", "ISSUE_UNKNOWN"];

/** States the expiry sweep acts on once `expires_at` has passed (a grant may exist, or approval is still pending). */
export const SWEEP_STATES: readonly LeaseState[] = ["REQUESTED", "APPROVED", "ISSUING", "ACTIVE", "ISSUE_UNKNOWN"];

export function revocationStatusFor(state: LeaseState): RevocationStatus {
  switch (state) {
    case "REVOKED_VERIFIED":
      return "verified";
    case "REVOCATION_UNCONFIRMED":
      return "unconfirmed";
    case "REVOKING":
      return "pending";
    default:
      return "none";
  }
}

/** Visible warning for unresolved states. Null states are not "green" either: only REVOKED_VERIFIED means revoked. */
export function warningFor(state: LeaseState, reason: CloseReason | null, nextRetryAt: Date | null): string | null {
  const retry = nextRetryAt ? ` Next retry at ${nextRetryAt.toISOString()}.` : "";
  if (state === "ISSUE_UNKNOWN") {
    return `WARNING: issuance outcome is unknown; the provider may or may not hold a grant. Reconciling by deterministic provider reference; no duplicate grant will be created.${retry}`;
  }
  if (state === "REVOCATION_UNCONFIRMED") {
    const why = reason === "expired" ? "The lease has expired but" : "Revocation was requested but";
    return `WARNING: ${why} revocation is NOT verified; access may still exist at the provider. Native provider TTL still applies.${retry}`;
  }
  if (state === "REVOKING") return "Revocation requested; independent verification pending. Not yet verified as revoked.";
  return null;
}
