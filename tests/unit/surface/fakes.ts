import { vi } from "vitest";
import type { Ctx } from "../../../src/context";
import type { LeaseDetail } from "../../../src/domain/types";
import { AppError } from "../../../src/errors";
import type { AccessLeaseServices, ReportData } from "../../../src/services/contract";

export const SYNTH = { kind: "synthetic", label: "SYNTHETIC", live: false } as const;
export const LIVE = { kind: "postgres-role", label: "LIVE_LOCAL_POSTGRES", live: true } as const;

export const lease = (over: Partial<LeaseDetail> = {}): LeaseDetail => ({
  id: "lease-synthetic-0001",
  workspace_id: "workspace-synthetic-0001",
  task_ref: "TASK-1",
  subject_ref: "contractor-a",
  resource_ref: "pg:reporting",
  scopes: ["pg:public.orders:select"],
  state: "REVOKED_VERIFIED",
  expires_at: "2026-01-01T01:00:00.000Z",
  version: 4,
  plan_hash: "a".repeat(64),
  policy_hash: "b".repeat(64),
  provider: SYNTH,
  approval: null,
  issued_at: "2026-01-01T00:01:00.000Z",
  revoked_at: "2026-01-01T01:00:05.000Z",
  last_verified_at: "2026-01-01T01:00:06.000Z",
  revocation_status: "verified",
  next_retry_at: null,
  close_reason: "expired",
  warning: null,
  credential_available: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T01:00:06.000Z",
  provider_grant: null,
  attempts: [{ id: "att-1", lease_id: "l", attempt_no: 1, attempted_at: "2026-01-01T01:00:05.000Z", result: "verified", verification_ref: "introspection+probe:denied", detail: {}, next_retry_at: null }],
  audit: [{ id: "aud-1", seq: 1, lease_id: "l", actor_ref: "system:worker", action: "revocation_verified", occurred_at: "2026-01-01T01:00:06.000Z", metadata: {} }],
  ...over,
});

export const reportData = (leases: LeaseDetail[] = [lease()], over: Partial<ReportData> = {}): ReportData => {
  const unknown = leases.filter((l) => l.state.toUpperCase() === "ISSUE_UNKNOWN").length;
  const unconfirmed = leases.filter((l) => l.state.toUpperCase() === "REVOCATION_UNCONFIRMED").length;
  return {
    schema_version: 1,
    generated_at: "2026-01-01T02:00:00.000Z",
    workspace: { id: "workspace-synthetic-0001", name: "Demo (synthetic)" },
    providers: [SYNTH],
    contains_synthetic: true,
    truncated: false,
    workspace_total: leases.length,
    summary: {
      total: leases.length,
      by_state: Object.fromEntries(Object.entries(Object.groupBy(leases, (l) => l.state.toLowerCase())).map(([k, v]) => [k, v?.length ?? 0])) as ReportData["summary"]["by_state"],
      unresolved: { issue_unknown: unknown, revocation_unconfirmed: unconfirmed },
      max_revocation_request_delay_seconds: 5,
    },
    leases,
    imports: [],
    ...over,
  };
};

export interface Captured {
  out: string[];
  err: string[];
  io: { out: (l: string) => void; err: (l: string) => void };
}

export function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

export const appError = (status: number, code: string, message = code) => new AppError(status, code, message);

/** A Ctx whose database is a close-spy; nothing else is reachable. */
export function fakeCtx() {
  const close = vi.fn(async () => undefined);
  return { ctx: { db: { close } } as unknown as Ctx, close };
}

/** Fake backend services. Every function is a spy so tests assert exactly what the CLI called. */
export function fakeServices(over: Partial<AccessLeaseServices> = {}) {
  const { ctx, close } = fakeCtx();
  const svc = {
    loadConfig: vi.fn(() => ({ host: "127.0.0.1", port: 8791 })),
    contextFromConfig: vi.fn(() => ctx),
    migrate: vi.fn(async () => ({ applied: [] as string[] })),
    bootstrapAdmin: vi.fn(async () => ({ workspaceId: "ws-1", userId: "u-1", created: { workspace: true, user: true } })),
    cliPrincipal: vi.fn(async (_c: Ctx, workspace?: string) => ({ actorRef: "cli:local", userId: null, email: null, workspaceId: workspace ?? "ws-1", workspaceName: "W", role: "admin", sessionId: null })),
    exportBundle: vi.fn(async () => ({ bytes: Buffer.from('{"bundle":true}'), bundle_hash: "h".repeat(64), lease_count: 2, file_count: 4 })),
    verifyBundle: vi.fn(() => ({ ok: true, code: null, message: null, bundle_hash: "h".repeat(64), schema_version: 1, file_count: 4, lease_count: 2 })),
    importBundle: vi.fn(async () => ({ import_id: "imp-1", bundle_hash: "h".repeat(64), already_imported: false, lease_count: 2, imported_at: "2026-01-01T00:00:00.000Z" })),
    pullEvents: vi.fn(async () => ({ items: [] as unknown[], next_cursor: "0" })),
    getReportData: vi.fn(async () => reportData()),
    unresolvedCount: vi.fn(async () => ({ issueUnknown: 0, revocationUnconfirmed: 0 })),
    runDoctor: vi.fn(async () => ({ ok: true, checks: [{ name: "database", status: "ok", message: "reachable" }], exitCode: 0 })),
    runDemo: vi.fn(),
    runWorkerOnce: vi.fn(async () => ({
      sweep: { expiredToRevoking: 0, overdueRecovered: 0, staleRequestsClosed: 0, jobsReclaimed: 0, at: "t" },
      jobsProcessed: 1,
      issued: 1,
      reconciled: 0,
      revokeAttempts: 0,
      verified: 0,
      unconfirmed: 0,
      unresolved: { issueUnknown: 0, revocationUnconfirmed: 0 },
    })),
    runWorker: vi.fn(async () => undefined),
    ...over,
  } as unknown as AccessLeaseServices;
  return { svc, ctx, close };
}
