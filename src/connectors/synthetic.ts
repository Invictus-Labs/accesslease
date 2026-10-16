import { type Clock, systemClock } from "../context.js";
import { sha256Hex } from "../domain/canonical.js";
import { isSyntheticResource, isSyntheticScope, normalizeScopes } from "../domain/scopes.js";
import { REVOCATION_REQUEST_SLA_SECONDS } from "../domain/types.js";
import {
  type GrantTarget,
  type IssueRequest,
  type IssueResult,
  type LookupResult,
  type Provider,
  type ProbeResult,
  type ProviderCapabilities,
  ProviderRejectedError,
  ProviderUnavailableError,
  type RevokeResult,
  type ScopeCheck,
} from "./provider.js";

export type SyntheticOp = "issue" | "lookup" | "revoke" | "probe" | "ping";
/**
 * Fault injection for deterministic state-machine tests and the demo:
 * - `outage` / `timeout`: the call fails before any effect (the caller cannot know that);
 * - `ambiguous`: (issue) the write happens but the answer is lost: the caller sees an error;
 * - `reject`: (issue) the provider refuses and creates nothing (definite failure);
 * - `partial_revoke`: (revoke) new logins are disabled but a session and the grant survive;
 * - `stale_introspection`: (lookup) answers with the pre-revocation snapshot (still "present");
 * - `probe_unknown`: (probe) the denied-use probe cannot decide.
 */
export type SyntheticFault = "outage" | "timeout" | "ambiguous" | "reject" | "partial_revoke" | "stale_introspection" | "probe_unknown";

interface SyntheticGrant {
  leaseId: string;
  resource: string;
  scopes: string[];
  validUntil: Date;
  secret: string;
  loginDisabled: boolean;
  sessions: number;
}

export interface SyntheticOptions {
  clock?: Clock;
  host?: string;
  port?: number;
}

/** SYNTHETIC provider: in-process, deterministic, never live. Native TTL is modelled with the injected clock. */
export class SyntheticProvider implements Provider {
  readonly kind = "synthetic" as const;
  private readonly grants = new Map<string, SyntheticGrant>();
  /** Snapshots of removed grants, served by `stale_introspection`. */
  private readonly tombstones = new Map<string, SyntheticGrant>();
  private readonly queue = new Map<SyntheticOp, { fault: SyntheticFault; persistent: boolean }[]>();
  private readonly clock: Clock;
  private readonly host: string;
  private readonly port: number;
  readonly calls: { op: SyntheticOp; ref?: string }[] = [];

  constructor(options: SyntheticOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.host = options.host ?? "localhost";
    this.port = options.port ?? 5432;
  }

  readonly faults = {
    /** Fail the next `times` calls of `op` with `fault`. */
    next: (op: SyntheticOp, fault: SyntheticFault, times = 1): void => {
      const list = this.queue.get(op) ?? [];
      for (let i = 0; i < times; i += 1) list.push({ fault, persistent: false });
      this.queue.set(op, list);
    },
    /** Fail every call of `op` until cleared. */
    always: (op: SyntheticOp, fault: SyntheticFault): void => {
      this.queue.set(op, [{ fault, persistent: true }]);
    },
    clear: (op?: SyntheticOp): void => {
      if (op) this.queue.delete(op);
      else this.queue.clear();
    },
  };

  private take(op: SyntheticOp): SyntheticFault | null {
    const list = this.queue.get(op);
    const head = list?.[0];
    if (!list || !head) return null;
    if (!head.persistent) list.shift();
    return head.fault;
  }

  capabilities(): ProviderCapabilities {
    return {
      kind: "synthetic",
      label: "SYNTHETIC",
      live: false,
      nativeTtl: true,
      revocation: true,
      introspection: true,
      deniedUseProbe: true,
      maxResidualAccessSeconds: REVOCATION_REQUEST_SLA_SECONDS,
      scopeGrammar: "synthetic:<resource>:<read|write>",
      version: "synthetic/1",
    };
  }

  providerRefFor(leaseId: string): string {
    return `syn_${sha256Hex(leaseId).slice(0, 24)}`;
  }

  validateScope(scope: string): ScopeCheck {
    return isSyntheticScope(scope) ? { ok: true } : { ok: false, code: "invalid_scope", message: "scope must match synthetic:<resource>:<read|write>" };
  }

  validateResource(resource: string) {
    return isSyntheticResource(resource) ? ({ ok: true } as const) : ({ ok: false, message: "resource must be a short lowercase name" } as const);
  }

  async ping(): Promise<void> {
    this.calls.push({ op: "ping" });
    const fault = this.take("ping");
    if (fault === "outage" || fault === "timeout") throw new ProviderUnavailableError(fault === "outage" ? "provider_unavailable" : "provider_timeout", "synthetic provider unreachable (injected)");
  }

  private loginAllowed(grant: SyntheticGrant): boolean {
    return !grant.loginDisabled && this.clock().getTime() < grant.validUntil.getTime();
  }

  async issue(request: IssueRequest): Promise<IssueResult> {
    const ref = this.providerRefFor(request.leaseId);
    this.calls.push({ op: "issue", ref });
    const fault = this.take("issue");
    if (fault === "outage" || fault === "timeout") {
      throw new ProviderUnavailableError(fault === "outage" ? "provider_unavailable" : "provider_timeout", "synthetic provider unreachable (injected)");
    }
    if (fault === "reject") throw new ProviderRejectedError("provider_rejected", "synthetic provider rejected the grant (injected)");
    if (!isSyntheticResource(request.resource)) throw new ProviderRejectedError("invalid_resource", "invalid synthetic resource");
    for (const scope of request.scopes) if (!isSyntheticScope(scope)) throw new ProviderRejectedError("invalid_scope", "invalid synthetic scope");
    const existed = this.grants.has(ref);
    this.grants.set(ref, {
      leaseId: request.leaseId,
      resource: request.resource,
      scopes: normalizeScopes(request.scopes),
      validUntil: request.expiresAt,
      secret: request.credentialSecret,
      loginDisabled: false,
      sessions: this.grants.get(ref)?.sessions ?? 0,
    });
    this.tombstones.delete(ref);
    if (fault === "ambiguous") throw new ProviderUnavailableError("provider_ambiguous", "synthetic provider lost the response after applying the grant (injected)");
    return { providerRef: ref, validUntil: request.expiresAt, alreadyExisted: existed, connection: { host: this.host, port: this.port, database: request.resource, username: ref } };
  }

  async lookup(target: GrantTarget): Promise<LookupResult> {
    const ref = this.providerRefFor(target.leaseId);
    this.calls.push({ op: "lookup", ref });
    const fault = this.take("lookup");
    if (fault === "outage" || fault === "timeout") throw new ProviderUnavailableError(fault === "outage" ? "provider_unavailable" : "provider_timeout", "synthetic provider unreachable (injected)");
    const live = this.grants.get(ref);
    const stale = fault === "stale_introspection" ? this.tombstones.get(ref) : undefined;
    const grant = live ?? stale;
    if (!grant) return { state: "absent", validUntil: null, loginAllowed: false, activeSessions: 0, scopes: null, detail: { synthetic: true } };
    return {
      state: "present",
      validUntil: grant.validUntil,
      loginAllowed: this.loginAllowed(grant),
      activeSessions: grant.sessions,
      scopes: grant.scopes,
      detail: { synthetic: true, stale: stale !== undefined },
    };
  }

  async revoke(target: GrantTarget): Promise<RevokeResult> {
    const ref = this.providerRefFor(target.leaseId);
    this.calls.push({ op: "revoke", ref });
    const fault = this.take("revoke");
    if (fault === "outage" || fault === "timeout") throw new ProviderUnavailableError(fault === "outage" ? "provider_unavailable" : "provider_timeout", "synthetic provider unreachable (injected)");
    const grant = this.grants.get(ref);
    if (!grant) return { steps: [{ step: "grant_absent", ok: true }], sessionsTerminated: 0 };
    if (fault === "partial_revoke") {
      grant.loginDisabled = true;
      return { steps: [{ step: "disable_login", ok: true }, { step: "terminate_sessions", ok: false, detail: "injected partial revoke" }], sessionsTerminated: 0 };
    }
    const terminated = grant.sessions;
    this.tombstones.set(ref, { ...grant });
    this.grants.delete(ref);
    return { steps: [{ step: "disable_login", ok: true }, { step: "terminate_sessions", ok: true }, { step: "remove_grant", ok: true }], sessionsTerminated: terminated };
  }

  async probeUse(target: GrantTarget & { credentialSecret: string }): Promise<ProbeResult> {
    const ref = this.providerRefFor(target.leaseId);
    this.calls.push({ op: "probe", ref });
    const fault = this.take("probe");
    if (fault === "probe_unknown" || fault === "outage" || fault === "timeout") return "unknown";
    const grant = this.grants.get(ref);
    return grant && grant.secret === target.credentialSecret && this.loginAllowed(grant) ? "allowed" : "denied";
  }

  async close(): Promise<void> {}

  // ---- test / demo helpers (not part of the Provider interface) ----

  /** A grantee connects with the credential. Returns whether the login succeeded (native TTL enforced at login only). */
  openSession(leaseId: string, secret: string): boolean {
    const grant = this.grants.get(this.providerRefFor(leaseId));
    if (!grant || grant.secret !== secret || !this.loginAllowed(grant)) return false;
    grant.sessions += 1;
    return true;
  }

  hasGrant(leaseId: string): boolean {
    return this.grants.has(this.providerRefFor(leaseId));
  }

  grantCount(): number {
    return this.grants.size;
  }

  sessionCount(leaseId: string): number {
    return this.grants.get(this.providerRefFor(leaseId))?.sessions ?? 0;
  }

  /** Test hook: create a grant behind AccessLease's back (reconciliation tests). */
  seedGrant(request: IssueRequest): void {
    this.grants.set(this.providerRefFor(request.leaseId), {
      leaseId: request.leaseId,
      resource: request.resource,
      scopes: normalizeScopes(request.scopes),
      validUntil: request.expiresAt,
      secret: request.credentialSecret,
      loginDisabled: false,
      sessions: 0,
    });
  }
}
