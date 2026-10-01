import type { ProviderKind, ProviderLabel } from "../domain/types.js";

/**
 * Provider (connector) contract. FROZEN at M0. Narrative: docs/contracts/provider.md.
 *
 * Two implementations ship: `synthetic` (labelled SYNTHETIC, deterministic, fault injection, never live)
 * and `postgres-role` (REAL local PostgreSQL provider; the only provider that can satisfy live criteria).
 *
 * Idempotency rule: the provider reference is a pure function of the lease id (`providerRefFor`), so
 * `issue` on the same lease is "create or align" and a retry identifies the same provider grant, never a
 * second one (AC-03, AC-06).
 *
 * Failure rule: a provider throws `ProviderRejectedError` only when it knows nothing was created.
 * Anything else that can leave the outcome unknown (timeout, dropped connection, outage) is
 * `ProviderUnavailableError`; callers must reconcile by `lookup`, never blind-retry.
 */

export interface ProviderCapabilities extends ProviderLabel {
  /** The provider enforces `expires_at` natively (e.g. VALID UNTIL). A provider without it is refused (AC-03). */
  nativeTtl: boolean;
  revocation: boolean;
  /** `lookup` reads provider state independently of what we last wrote. */
  introspection: boolean;
  /** `probeUse` attempts real use of the issued credential. */
  deniedUseProbe: boolean;
  /**
   * Documented maximum seconds an already-established session can outlive `expires_at` when the
   * worker is healthy: poll interval + claim latency + provider termination time. See docs/contracts/residual-access.md.
   */
  maxResidualAccessSeconds: number;
  /** Human-readable scope grammar, e.g. "pg:<schema>.<table>:<select|insert|update>". */
  scopeGrammar: string;
  /** Provider/server version string observed or declared, e.g. "synthetic/1" or "postgresql 17.x". */
  version: string;
}

/** Identifies one provider grant. `resource` is the provider-specific target (postgres-role: the database name). */
export interface GrantTarget {
  leaseId: string;
  resource: string;
}

export interface IssueRequest extends GrantTarget {
  /** Issue attempt counter for evidence only; it never changes the provider reference. */
  attempt: number;
  subject: string;
  scopes: string[];
  /** Hard expiry the provider must enforce natively. */
  expiresAt: Date;
  /** Secret chosen by AccessLease (derived with the operator key); the provider sets it as the credential. Never logged. */
  credentialSecret: string;
}

/** Non-secret connection facts for the grantee. The secret itself is held by AccessLease. */
export interface ConnectionFacts {
  host: string;
  port: number;
  database: string;
  username: string;
}

export interface IssueResult {
  providerRef: string;
  validUntil: Date;
  /** true when the grant already existed and was aligned (retry/reconcile); never a second grant. */
  alreadyExisted: boolean;
  connection: ConnectionFacts;
}

export interface LookupResult {
  state: "present" | "absent" | "unknown";
  validUntil: Date | null;
  /** Whether new logins are possible right now according to the provider (login flag and validity). */
  loginAllowed: boolean | null;
  /** Established sessions of the grant, or null when unknown. */
  activeSessions: number | null;
  /** The scopes currently granted (sorted), or null when unknown/absent. */
  scopes: string[] | null;
  /** Redacted evidence details (role flags, counts). Never secrets. */
  detail: Record<string, unknown>;
}

export interface RevokeStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface RevokeResult {
  steps: RevokeStep[];
  sessionsTerminated: number;
}

export type ProbeResult = "denied" | "allowed" | "unknown";

export type ScopeCheck = { ok: true } | { ok: false; code: "invalid_scope" | "scope_wildcard" | "scope_forbidden"; message: string };

export class ProviderRejectedError extends Error {
  readonly definite = true;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

export class ProviderUnavailableError extends Error {
  readonly definite = false;
  constructor(
    readonly code: "provider_unavailable" | "provider_timeout" | "provider_disconnected" | "provider_ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface Provider {
  readonly kind: ProviderKind;
  capabilities(): ProviderCapabilities;
  /** Deterministic provider reference for a lease (idempotent issue). Pure; no I/O. */
  providerRefFor(leaseId: string): string;
  validateScope(scope: string): ScopeCheck;
  /** Validate the provider-specific resource reference (postgres-role: a database name). */
  validateResource(resource: string): { ok: true } | { ok: false; message: string };
  /** Throws ProviderUnavailableError when the connector is disconnected or unreachable (AC-08: explicit failure). */
  ping(): Promise<void>;
  issue(request: IssueRequest): Promise<IssueResult>;
  lookup(target: GrantTarget): Promise<LookupResult>;
  /** Idempotent: safe to call repeatedly and on grants that no longer exist. */
  revoke(target: GrantTarget): Promise<RevokeResult>;
  probeUse(target: GrantTarget & { credentialSecret: string }): Promise<ProbeResult>;
  close(): Promise<void>;
}

/** Providers available to this process, keyed by kind. Absent kind = disconnected (explicit failure). */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, Provider>();

  constructor(
    providers: Provider[] = [],
    readonly defaultKind: ProviderKind = "synthetic",
  ) {
    for (const provider of providers) this.register(provider);
  }

  /** A provider without native, provider-enforced TTL is refused (AC-03): local scheduling alone is never a safe expiry. */
  register(provider: Provider): void {
    if (!provider.capabilities().nativeTtl) throw new Error(`provider ${provider.kind} has no native TTL and is refused`);
    this.providers.set(provider.kind, provider);
  }

  get(kind: ProviderKind): Provider | undefined {
    return this.providers.get(kind);
  }

  require(kind: ProviderKind): Provider {
    const provider = this.providers.get(kind);
    if (!provider) throw new ProviderUnavailableError("provider_disconnected", `provider ${kind} is not configured`);
    return provider;
  }

  kinds(): ProviderKind[] {
    return [...this.providers.keys()];
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.providers.values()].map((p) => p.close()));
  }
}

export const labelOf = (capabilities: ProviderCapabilities): ProviderLabel => ({
  kind: capabilities.kind,
  label: capabilities.label,
  live: capabilities.live,
});
