/**
 * Service-function contract for the CLI, the adapters and the API. FROZEN at M0.
 *
 * Every function below is exported, under exactly this name and signature, from `src/services/index.ts`
 * (the barrel) and implemented in the module named in the comment. `AccessLeaseServices` is checked at compile
 * time in `src/services/index.ts`, so drift fails `npm run typecheck`.
 *
 * Conventions
 * - First argument is always the `Ctx` (db, clock, key, settings, providers, log). The CLI builds it with
 *   `contextFromConfig(loadConfig(process.env))` from `src/config.ts`.
 * - Functions that act on behalf of someone take a `Principal`. The CLI uses `cliPrincipal(ctx, workspace?)`
 *   (actorRef "cli:local", role admin: the CLI trusts the local OS user); the worker uses actorRef "system:worker".
 * - Failures are thrown as `AppError` (src/errors.ts) with the registered codes in `ERROR_CODES`.
 *   The CLI maps: 422 -> exit 2, 503 / provider_unavailable -> exit 3, other AppError/unknown -> exit 1,
 *   and exit 4 when a successful command left unresolved states (see `unresolvedCount`).
 * - All timestamps are UTC; `ctx.clock()` is the only time source (injectable, deterministic in tests/demo).
 */
import type { Ctx } from "../context.js";
import type { ServerConfig } from "../config.js";
import type {
  BundleVerification,
  CredentialDelivery,
  EventEnvelope,
  ImportReceipt,
  LeaseDetail,
  LeaseRequestInput,
  LeaseState,
  WireLeaseState,
  LeaseView,
  Page,
  Policy,
  Principal,
  ProviderLabel,
  Role,
} from "../domain/types.js";

// ---- configuration / lifecycle (src/config.ts, src/db/migrate.ts) -----------

export interface MigrateResult {
  applied: string[];
}

/** Optional per-call options for mutating operations. */
export interface MutationOptions {
  /** `Idempotency-Key` semantics (scope workspace + actor + route). Absent: not idempotent-keyed. */
  idempotencyKey?: string;
  /** Optimistic concurrency: the lease version the caller saw. */
  expectedVersion?: number;
}

export interface LeaseReceipt {
  id: string;
  state: WireLeaseState;
  plan_hash: string;
  lease: LeaseView;
  /** true when an Idempotency-Key replay returned the stored receipt. */
  replayed: boolean;
}

export interface BootstrapInput {
  email: string;
  password: string;
  workspaceName: string;
}

export interface BootstrapResult {
  workspaceId: string;
  userId: string;
  created: { workspace: boolean; user: boolean };
}

// ---- worker / sweep ----------------------------------------------------------

export interface SweepReport {
  /** Leases whose expires_at passed that were moved to REVOKING with a revoke job queued. */
  expiredToRevoking: number;
  /** Leases that were already overdue and un-swept at the start of the pass (restart recovery, AC-06). */
  overdueRecovered: number;
  /** Approvals/requests that expired before issuance and were closed. */
  staleRequestsClosed: number;
  /** Jobs whose lease expired (worker died) and were returned to the queue. */
  jobsReclaimed: number;
  at: string;
}

export interface WorkerPassReport {
  sweep: SweepReport;
  jobsProcessed: number;
  issued: number;
  reconciled: number;
  revokeAttempts: number;
  verified: number;
  unconfirmed: number;
  /** Unresolved leases remaining in the workspace(s) after the pass (exit code 4 material). */
  unresolved: { issueUnknown: number; revocationUnconfirmed: number };
}

export interface WorkerLoopOptions {
  workerId?: string;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called after every pass (tests, `accesslease worker` progress line). */
  onPass?: (report: WorkerPassReport) => void;
}

// ---- evidence ---------------------------------------------------------------

export interface ExportOptions {
  /** Restrict to these lease ids (workspace-scoped). Default: all leases of the workspace. */
  leaseIds?: string[];
}

export interface ExportResult {
  bytes: Buffer;
  bundle_hash: string;
  lease_count: number;
  file_count: number;
}

export interface VerifyBundleOptions {
  /** Metadata byte limit; default 25 MB. */
  maxBytes?: number;
  maxFiles?: number;
  /** Explicit override up to 250 MB for large bundles. */
  allowLarge?: boolean;
}

// ---- report data (surface renders HTML; the data is already redacted) ----------

export interface ReportLease extends LeaseDetail {}

export interface ReportData {
  schema_version: 1;
  generated_at: string;
  workspace: { id: string; name: string };
  providers: ProviderLabel[];
  /** true when any lease came from a SYNTHETIC provider: reports must say so. */
  contains_synthetic: boolean;
  /** true when the workspace holds more leases than the `leases` list carries (newest kept). Summary counts always cover the WHOLE workspace. */
  truncated: boolean;
  /** Number of leases in the whole workspace (or in the requested subset). */
  workspace_total: number;
  summary: {
    total: number;
    by_state: Record<WireLeaseState, number>;
    unresolved: { issue_unknown: number; revocation_unconfirmed: number };
    /** Maximum seconds between expires_at and the first revocation request among revoked leases, or null. */
    max_revocation_request_delay_seconds: number | null;
  };
  leases: ReportLease[];
  /** Redacted evidence imports available for reading (restored bundles). */
  imports: { import_id: string; bundle_hash: string; lease_count: number; imported_at: string }[];
}

export interface ReportOptions {
  leaseIds?: string[];
  limit?: number;
}

// ---- doctor -----------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  /** ok = pass; warn = works but needs attention; fail = broken; unavailable = a live dependency is disconnected (exit 3). */
  status: "ok" | "warn" | "fail" | "unavailable";
  message: string;
  /** Actionable next step for the operator (failure diagnosis, AC-11). */
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** Suggested CLI exit code: 0 ok, 1 fail, 3 unavailable, 4 unresolved states present. */
  exitCode: 0 | 1 | 3 | 4;
}

// ---- demo ------------------------------------------------------------------

export interface DemoOptions {
  /** PostgreSQL URL for the demo. The demo runs inside a throwaway schema and drops it afterwards. */
  databaseUrl: string;
  /** Output directory (created 0700). When omitted nothing is written and the data is only returned. */
  outDir?: string;
  /** Fixed starting instant; default 2026-01-01T00:00:00.000Z. The demo never reads the wall clock. */
  startAt?: string;
}

export interface DemoResult {
  /** Always "SYNTHETIC": the demo never touches a live provider. */
  provider: ProviderLabel;
  reportData: ReportData;
  bundle: ExportResult;
  /** Files written when outDir was given: absolute paths. */
  files: { reportData?: string; bundle?: string };
  /** Leases left in ISSUE_UNKNOWN / REVOCATION_UNCONFIRMED on purpose (exit code 4 material). */
  unresolved: { issueUnknown: number; revocationUnconfirmed: number };
  /** Requests the policy refused during the demo (wildcard/admin scopes): scope text and error code. Nothing was created for them. */
  rejectedRequests: { scope: string; code: string }[];
}

// ---- the contract -------------------------------------------------------------

export interface AccessLeaseServices {
  // config.ts
  loadConfig(env?: NodeJS.ProcessEnv): ServerConfig;
  contextFromConfig(config: ServerConfig): Ctx;
  // db/migrate.ts
  migrate(ctx: Ctx): Promise<MigrateResult>;
  // services/bootstrap.ts: local admin bootstrap (no default password; the CLI prompts or reads a file/env)
  bootstrapAdmin(ctx: Ctx, input: BootstrapInput): Promise<BootstrapResult>;
  cliPrincipal(ctx: Ctx, workspace?: string): Promise<Principal>;
  // services/leases.ts
  requestLease(ctx: Ctx, principal: Principal, input: unknown, options?: MutationOptions): Promise<LeaseReceipt>;
  approveLease(ctx: Ctx, principal: Principal, leaseId: string, input: unknown, options?: MutationOptions): Promise<LeaseReceipt>;
  revokeLease(ctx: Ctx, principal: Principal, leaseId: string, input: unknown, options?: MutationOptions): Promise<LeaseReceipt>;
  closeLease(ctx: Ctx, principal: Principal, leaseId: string, input: unknown, options?: MutationOptions): Promise<LeaseReceipt>;
  getLease(ctx: Ctx, principal: Principal, leaseId: string): Promise<LeaseDetail>;
  listLeases(ctx: Ctx, principal: Principal, query?: { state?: LeaseState | WireLeaseState; cursor?: string; limit?: number }): Promise<Page<LeaseView>>;
  retrieveCredential(ctx: Ctx, principal: Principal, leaseId: string): Promise<CredentialDelivery>;
  // services/policy.ts
  getPolicy(ctx: Ctx, principal: Principal): Promise<Policy>;
  setPolicy(ctx: Ctx, principal: Principal, input: unknown): Promise<Policy>;
  // workers/index.ts
  runWorkerOnce(ctx: Ctx, options?: { workerId?: string }): Promise<WorkerPassReport>;
  runWorker(ctx: Ctx, options?: WorkerLoopOptions): Promise<void>;
  sweepOverdue(ctx: Ctx): Promise<SweepReport>;
  // services/evidence.ts
  exportBundle(ctx: Ctx, principal: Principal, options?: ExportOptions): Promise<ExportResult>;
  verifyBundle(bytes: Uint8Array, options?: VerifyBundleOptions): BundleVerification;
  importBundle(ctx: Ctx, principal: Principal, bytes: Uint8Array, options?: VerifyBundleOptions): Promise<ImportReceipt>;
  // services/events.ts
  pullEvents(ctx: Ctx, principal: Principal, query?: { after?: string; limit?: number }): Promise<{ items: EventEnvelope[]; next_cursor: string }>;
  // services/report.ts
  getReportData(ctx: Ctx, principal: Principal, options?: ReportOptions): Promise<ReportData>;
  unresolvedCount(ctx: Ctx, workspaceId?: string): Promise<{ issueUnknown: number; revocationUnconfirmed: number }>;
  // services/doctor.ts
  runDoctor(ctx: Ctx): Promise<DoctorReport>;
  // services/demo.ts
  runDemo(options: DemoOptions): Promise<DemoResult>;
}

/** Role helpers the CLI/UI may import (src/services/auth.ts). */
export type RoleCheck = (principal: Principal, minimum: Role) => void;
