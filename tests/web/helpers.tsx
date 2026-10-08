import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import type { Lease, User } from "../../src/web/api";

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  init: RequestInit;
}

type Reply = { status?: number; body?: unknown; raw?: string };
type Handler = Reply | ((call: Call) => Reply);

/** Route table keyed by "METHOD /path" (path without the /api/v1 prefix, query included). Render tests only; browser E2E uses the real API. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = String(input).replace(/^\/api\/v1/, "");
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, path, body, headers, init };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: `unmocked ${method} ${path}` } }), { status: 404 });
    const reply = typeof route === "function" ? route(call) : route;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export const users: Record<User["role"], User> = {
  admin: { id: "u1", email: "admin@example.test", workspace_id: "w1", workspace_name: "Demo", role: "admin" },
  operator: { id: "u2", email: "operator@example.test", workspace_id: "w1", workspace_name: "Demo", role: "operator" },
  viewer: { id: "u3", email: "viewer@example.test", workspace_id: "w1", workspace_name: "Demo", role: "viewer" },
};

export const SYNTHETIC = { kind: "synthetic", label: "SYNTHETIC", live: false } as const;
export const LIVE = { kind: "postgres-role", label: "LIVE_LOCAL_POSTGRES", live: true } as const;

export const makeLease = (over: Partial<Lease> = {}): Lease => ({
  id: "lease-synthetic-0001",
  workspace_id: "workspace-synthetic-0001",
  task_ref: "TASK-1",
  subject_ref: "contractor-a",
  resource_ref: "pg:reporting",
  scopes: ["pg:public.orders:select"],
  state: "ACTIVE",
  expires_at: "2026-01-01T01:00:00.000Z",
  version: 3,
  plan_hash: "a".repeat(64),
  policy_hash: "b".repeat(64),
  provider: LIVE,
  approval: null,
  issued_at: null,
  revoked_at: null,
  last_verified_at: null,
  revocation_status: "none",
  next_retry_at: null,
  close_reason: null,
  warning: null,
  credential_available: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  provider_grant: null,
  attempts: [],
  audit: [],
  ...over,
});

export const makePolicy = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  workspace_id: "workspace-synthetic-0001",
  default_ttl_seconds: 3600,
  max_ttl_seconds: 28800,
  min_ttl_seconds: 60,
  approval_ttl_seconds: 900,
  retention_days: 90,
  scope_allow_prefixes: [],
  scope_deny_prefixes: [],
  version: 2,
  policy_hash: "c".repeat(64),
  updated_at: "2026-01-01T00:00:00.000Z",
  updated_by: null,
  ...over,
});

export function renderAt(path: string, pattern: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
        <Route path="*" element={<p>navigated</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

export const apiError = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, request_id: "req-1" } } });
