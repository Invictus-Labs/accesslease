/**
 * Browser API client for the AccessLease API (`/api/v1`). The session is an HttpOnly cookie managed by the
 * browser; the only token this module holds is the CSRF token, in memory. Nothing here writes to
 * localStorage, sessionStorage, IndexedDB or cookies, and issued credentials are never cached.
 */

import type { CredentialDelivery, LeaseDetail, LeaseRequestInput, LeaseState, LeaseView, Page, Policy, Role } from "../domain/types";

export type { CredentialDelivery, LeaseDetail, LeaseView, Page, Policy, Role };

/** The signed-in user as returned by `GET /auth/session`. */
export interface User {
  id: string;
  email: string;
  workspace_id: string;
  workspace_name: string;
  role: Role;
}

/** List rows carry the lease without attempts and audit. */
/**
 * The API sends lowercase wire states. `api()` normalises them once to the UPPER_SNAKE form used by every
 * label, badge and comparison in the UI (see `normaliseLeaseStates`), so client lease types carry `LeaseState`.
 */
type WithClientState<T extends { state: unknown }> = Omit<T, "state"> & { state: LeaseState };
export type LeaseListItem = WithClientState<LeaseView>;
export type LeasePage = { items: LeaseListItem[]; next_cursor: string | null };
export type Lease = WithClientState<LeaseDetail>;
export type PolicyUpdate = Partial<Pick<Policy, "default_ttl_seconds" | "max_ttl_seconds" | "min_ttl_seconds" | "approval_ttl_seconds" | "retention_days" | "scope_allow_prefixes" | "scope_deny_prefixes">> & { expected_version?: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(requestId ? `${message} (reference ${requestId})` : message);
  }
}

let csrfToken: string | null = null;

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: { error?: { code?: string; message?: string; request_id?: string } } | null;
  try {
    data = text ? (JSON.parse(text) as typeof data) : null;
  } catch {
    throw new ApiError(response.status, "invalid_response", "The server returned an unreadable response");
  }
  if (!response.ok) throw new ApiError(response.status, data?.error?.code ?? "error", data?.error?.message ?? `HTTP ${response.status}`, data?.error?.request_id);
  return data as T;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Credential-bearing responses must not be stored by any cache. */
  noStore?: boolean;
}

export async function api<T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: "same-origin",
      cache: options.noStore ? "no-store" : "default",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network_error", "AccessLease is unreachable; check your connection and retry");
  }
  return normaliseLeaseStates(path, await parse<T>(response));
}

/**
 * Lease states are UPPER_SNAKE in the UI whichever case the wire uses. Applied only to lease routes, to the lease
 * itself or to each item of a lease page; other objects (jobs, members, policy) are left exactly as received.
 */
export function normaliseLeaseStates<T>(path: string, data: T): T {
  if (!/^\/leases(\/|\?|$)/.test(path) || !data || typeof data !== "object") return data;
  const fix = (o: unknown) => {
    if (o && typeof o === "object" && typeof (o as { state?: unknown }).state === "string") (o as { state: string }).state = (o as { state: string }).state.toUpperCase();
  };
  const page = data as { items?: unknown };
  if (Array.isArray(page.items)) page.items.forEach(fix);
  else fix(data);
  return data;
}

export async function loadSession(): Promise<User | null> {
  try {
    const session = await api<{ user: User; csrf_token: string }>("GET", "/auth/session");
    csrfToken = session.csrf_token;
    return session.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      csrfToken = null;
      return null;
    }
    throw error;
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  const result = await api<{ user: User; csrf_token: string }>("POST", "/auth/login", { email, password });
  csrfToken = result.csrf_token;
  return result.user;
}

export async function signOut(): Promise<void> {
  await api("POST", "/auth/logout");
  csrfToken = null;
}

export const newIdempotencyKey = (): string => crypto.randomUUID();
export const canOperate = (user: User): boolean => user.role === "admin" || user.role === "operator";
export const isAdmin = (user: User): boolean => user.role === "admin";
export const formatTime = (value: string | null | undefined): string => (value ? value : "—");

/** True when the CSRF token is currently held (tests and the shell use this to tell "signed in" from "no session"). */
export const hasCsrfToken = (): boolean => csrfToken !== null;

export type NewLease = LeaseRequestInput;

export const createLease = (lease: NewLease, key: string) => api<{ id: string; state: string; plan_hash: string }>("POST", "/leases", lease, { headers: { "idempotency-key": key } });
export const approveLease = (id: string, planHash: string, expectedVersion: number, key: string) =>
  api<unknown>("POST", `/leases/${encodeURIComponent(id)}/approve`, { plan_hash: planHash, expected_version: expectedVersion }, { headers: { "idempotency-key": key } });
export const revokeLease = (id: string, reason: string, key: string) => api<unknown>("POST", `/leases/${encodeURIComponent(id)}/revoke`, { reason }, { headers: { "idempotency-key": key } });
export const closeLease = (id: string, key: string) => api<unknown>("POST", `/leases/${encodeURIComponent(id)}/close`, {}, { headers: { "idempotency-key": key } });
export const savePolicy = (update: PolicyUpdate) => api<Policy>("PUT", "/policy", update);

/** One-time credential retrieval. The result lives only in component state; it is never persisted anywhere. */
export const retrieveCredential = (id: string) => api<CredentialDelivery>("POST", `/leases/${encodeURIComponent(id)}/credential`, {}, { noStore: true });
