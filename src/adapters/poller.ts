import { type EventConsumer } from "./consumer.js";
import { type EndpointPolicy, type Resolver, resolveEndpoint, systemResolver } from "./endpoint.js";
import { pinnedGet, ResponseTooLargeError } from "./pinned.js";

/** One page of events. `next_cursor` is where the next pull resumes; null means the source has nothing newer. */
export interface EventPage {
  events: unknown[];
  next_cursor: string | null;
}

export type EventSource = (cursor: string | null) => Promise<EventPage>;

/** The source could not be reached or answered with an error. Maps to CLI exit code 3. */
export class AdapterUnavailableError extends Error {
  readonly code = "adapter_unavailable";
}

export interface PollSummary {
  pulled: number;
  accepted: number;
  duplicates: number;
  stale: number;
  rejected: Array<{ reason: string; detail: string }>;
  cursor: string | null;
}

/**
 * Pull one page and ingest every event. The cursor advances only after the whole page was processed,
 * so a crash re-delivers the page (the consumer dedupes). Rejected events are reported, never dropped silently.
 */
export async function pollOnce(consumer: EventConsumer, source: EventSource): Promise<PollSummary> {
  const page = await source(consumer.cursor);
  const summary: PollSummary = { pulled: page.events.length, accepted: 0, duplicates: 0, stale: 0, rejected: [], cursor: consumer.cursor };
  for (const raw of page.events) {
    const result = consumer.ingest(raw);
    if (result.status === "accepted") summary.accepted += 1;
    else if (result.status === "duplicate") summary.duplicates += 1;
    else if (result.status === "stale") summary.stale += 1;
    else summary.rejected.push({ reason: result.reason, detail: result.detail });
  }
  if (page.next_cursor !== null) consumer.setCursor(page.next_cursor);
  summary.cursor = consumer.cursor;
  return summary;
}

export interface HttpSourceOptions {
  baseUrl: string;
  policy: EndpointPolicy;
  /** Extra request headers, for example a session cookie or token issued to the adapter. Never logged. */
  headers?: Record<string, string>;
  /**
   * Test seam. Without it the request is made with the connection pinned to the address that passed the allowlist
   * check (no second DNS lookup, so rebinding cannot redirect it). With it, the caller owns resolution.
   */
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  /** Response size cap in bytes (default 5 MiB). */
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Pull-based event source against `GET /api/v1/events?after=<cursor>`. The endpoint is checked against the
 * allowlist (including DNS results) before every request, the connection is pinned to the validated address, and
 * redirects are refused so one cannot leave the allowlist.
 */
export function httpEventSource(options: HttpSourceOptions): EventSource {
  const resolve = options.resolve ?? systemResolver;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return async (cursor) => {
    const base = new URL(options.baseUrl);
    const target = new URL("/api/v1/events", base);
    if (cursor !== null) target.searchParams.set("after", cursor);
    const checked = await resolveEndpoint(target.toString(), options.policy, resolve);
    const headers = { accept: "application/json", ...(options.headers ?? {}) };
    const timeoutMs = options.timeoutMs ?? 10_000;
    let response: { status: number; ok: boolean; text(): Promise<string> };
    try {
      response = options.fetchImpl
        ? await options.fetchImpl(target, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(timeoutMs) })
        : await pinnedGet({ url: checked.url, address: checked.addresses[0] as string, headers, timeoutMs, maxBytes });
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new AdapterUnavailableError("the events response exceeds the size limit");
      throw new AdapterUnavailableError("the AccessLease events endpoint is unreachable");
    }
    if (response.status >= 300 && response.status < 400) throw new AdapterUnavailableError("the events endpoint answered with a redirect, which is refused");
    if (!response.ok) throw new AdapterUnavailableError(`the events endpoint answered HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > maxBytes) throw new AdapterUnavailableError("the events response exceeds the size limit");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AdapterUnavailableError("the events endpoint returned an unreadable response");
    }
    const parsed = body as { items?: unknown; events?: unknown; next_cursor?: unknown } | null;
    const events = parsed?.items ?? parsed?.events;
    if (!Array.isArray(events)) throw new AdapterUnavailableError("the events response has no event list");
    const next = typeof parsed?.next_cursor === "string" ? parsed.next_cursor : null;
    return { events, next_cursor: next };
  };
}
