import type { ProviderRegistry } from "./connectors/provider.js";
import type { ServerKey } from "./crypto.js";
import type { Database } from "./db/index.js";
import type { Logger } from "./lib/log.js";

/** Injectable UTC clock. Deterministic tests and the offline demo pass a fixed/advancing clock. */
export type Clock = () => Date;

export interface Settings {
  publicUrl: string;
  sessionTtlSeconds: number;
  /** Requests per minute per authenticated session (anonymous login has its own budgets). */
  sessionRequestsPerMinute: number;
  secureCookies: boolean;
  /** Worker poll interval; bounds how long after expiry revocation is requested (AC-04). */
  workerPollMs: number;
  /** A running job whose lease expires is reclaimable (restart/crash recovery, AC-13). */
  jobLeaseSeconds: number;
  /** Hard deadline per provider call (lookup, probe, issue) and for a revoke call; both stay well below `jobLeaseSeconds` (a job runs at most three calls). */
  providerCallTimeoutMs: number;
  providerRevokeTimeoutMs: number;
  /** Maximum jobs claimed per worker pass (bounded claims). */
  maxJobsPerPass: number;
  /** Jobs processed concurrently inside one pass (claims are row-locked and per-lease serialized, so this is safe). */
  maxConcurrentJobs: number;
  /** First retry delay and cap for unconfirmed revocation / unknown issue reconciliation. */
  retryBaseSeconds: number;
  retryCapSeconds: number;
  /** Bounded attempts for an issue job whose provider answered definitively (no ambiguity). Reconcile/revoke are unbounded. */
  issueMaxAttempts: number;
  maxBodyBytes: number;
  importMaxMetadataBytes: number;
  importMaxFiles: number;
  /** Explicit override for the 250 MB blob cap (0 = use the default metadata limit only). */
  importBlobCapBytes: number;
  /** Egress allowlist entries (host, host:port, ip, cidr) checked against redirects and DNS resolution. */
  egressAllowlist: string[];
  /** Initial policy defaults applied when a workspace is created (admins change them later). */
  initialPolicy: { defaultTtlSeconds: number; maxTtlSeconds: number; minTtlSeconds: number; retentionDays: number };
  appVersion: string;
}

export const defaultSettings: Settings = {
  publicUrl: "http://localhost:8791",
  sessionTtlSeconds: 12 * 3600,
  sessionRequestsPerMinute: 600,
  secureCookies: true,
  workerPollMs: 5000,
  jobLeaseSeconds: 120,
  providerCallTimeoutMs: 20_000,
  providerRevokeTimeoutMs: 40_000,
  maxJobsPerPass: 25,
  maxConcurrentJobs: 4,
  retryBaseSeconds: 5,
  retryCapSeconds: 300,
  issueMaxAttempts: 3,
  maxBodyBytes: 64 * 1024,
  importMaxMetadataBytes: 25 * 1024 * 1024,
  importMaxFiles: 1000,
  importBlobCapBytes: 0,
  egressAllowlist: [],
  initialPolicy: { defaultTtlSeconds: 3600, maxTtlSeconds: 28800, minTtlSeconds: 60, retentionDays: 90 },
  appVersion: "0.1.0",
};

export interface Ctx {
  db: Database;
  clock: Clock;
  key: ServerKey;
  settings: Settings;
  providers: ProviderRegistry;
  log: Logger;
}

export const systemClock: Clock = () => new Date();
export const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

/** A clock that returns a fixed instant and can be advanced; used by tests and the offline demo. */
export function fixedClock(start: Date | string): Clock & { advance(seconds: number): Date; set(at: Date | string): void } {
  let now = new Date(start);
  const clock = (() => new Date(now)) as Clock & { advance(seconds: number): Date; set(at: Date | string): void };
  clock.advance = (seconds: number) => {
    now = addSeconds(now, seconds);
    return new Date(now);
  };
  clock.set = (at) => {
    now = new Date(at);
  };
  return clock;
}
