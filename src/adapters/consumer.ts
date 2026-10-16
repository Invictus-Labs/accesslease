import { parseEnvelope, type EventEnvelope, type RejectReason } from "./envelope.js";
import { type ConsumerState, type ConsumerStore, type HistoryEntry, type ResourceView, MemoryStore } from "./store.js";

export type IngestResult =
  | { status: "accepted"; event_id: string; resource_id: string; revision: number }
  | { status: "duplicate"; event_id: string }
  | { status: "stale"; event_id: string; resource_id: string; revision: number; applied_revision: number }
  | { status: "rejected"; reason: RejectReason | "adapter_disabled"; detail: string };

export interface ConsumerOptions {
  /** Disabled by default (PRD: connections are optional and disabled by default). */
  enabled?: boolean;
  store?: ConsumerStore;
  /** Dedupe horizon: how many event ids are remembered. Older ids may be re-delivered and re-checked by revision. */
  maxSeen?: number;
  maxHistory?: number;
}

export const DEFAULT_MAX_SEEN = 50_000;
export const DEFAULT_MAX_HISTORY = 10_000;

/**
 * Reference consumer of the AccessLease event envelope. It
 *  - rejects unsupported major versions and credential-shaped values,
 *  - dedupes by event_id (delivery is at least once),
 *  - applies an event to a resource only when its revision is strictly newer than what was applied,
 *  - keeps ordering and version metadata for every event it accepted or judged stale,
 *  - never derives a current lease state: it only reports the last event it applied.
 */
export class EventConsumer {
  readonly enabled: boolean;
  private readonly store: ConsumerStore;
  private state: ConsumerState;
  private readonly seen: Set<string>;
  private readonly maxSeen: number;
  private readonly maxHistory: number;

  constructor(options: ConsumerOptions = {}) {
    this.enabled = options.enabled === true;
    this.store = options.store ?? new MemoryStore();
    this.maxSeen = options.maxSeen ?? DEFAULT_MAX_SEEN;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.state = this.store.load();
    this.seen = new Set(this.state.seen);
  }

  /** Process one event. A disabled consumer does nothing and says so. */
  ingest(raw: unknown): IngestResult {
    if (!this.enabled) return { status: "rejected", reason: "adapter_disabled", detail: "the ecosystem adapter is disabled (set ACCESSLEASE_ADAPTER_ENABLED=1 to enable)" };
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return { status: "rejected", reason: parsed.reason, detail: parsed.detail };
    const event = parsed.event;
    if (this.seen.has(event.event_id)) return { status: "duplicate", event_id: event.event_id };

    const current = this.state.resources[event.resource_id];
    this.remember(event.event_id);
    if (current !== undefined && event.revision <= current.revision) {
      this.appendHistory(event, false, `revision ${event.revision} is not newer than applied revision ${current.revision}`);
      this.persist();
      return { status: "stale", event_id: event.event_id, resource_id: event.resource_id, revision: event.revision, applied_revision: current.revision };
    }
    this.appendHistory(event, true);
    this.state.resources[event.resource_id] = {
      resource_id: event.resource_id,
      revision: event.revision,
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      evidence_ref: event.evidence_ref,
      source: event.source,
      schema_version: event.schema_version,
      ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    };
    this.persist();
    return { status: "accepted", event_id: event.event_id, resource_id: event.resource_id, revision: event.revision };
  }

  /** The last applied event for a resource. This is a report of what was last said, not the live state of the lease. */
  lastEvent(resourceId: string): ResourceView | undefined {
    return this.state.resources[resourceId];
  }

  resources(): ResourceView[] {
    return Object.values(this.state.resources).sort((a, b) => a.resource_id.localeCompare(b.resource_id));
  }

  history(): HistoryEntry[] {
    return [...this.state.history];
  }

  get cursor(): string | null {
    return this.state.cursor;
  }

  /** Persist the pull cursor after the page it belongs to was fully ingested. */
  setCursor(cursor: string | null): void {
    this.state.cursor = cursor;
    this.persist();
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    this.state.seen.push(eventId);
    while (this.state.seen.length > this.maxSeen) {
      const dropped = this.state.seen.shift() as string;
      this.seen.delete(dropped);
    }
  }

  private appendHistory(event: EventEnvelope, applied: boolean, note?: string): void {
    this.state.history.push({
      event_id: event.event_id,
      resource_id: event.resource_id,
      revision: event.revision,
      occurred_at: event.occurred_at,
      event_type: event.event_type,
      schema_version: event.schema_version,
      applied,
      ...(note ? { note } : {}),
    });
    if (this.state.history.length > this.maxHistory) this.state.history.splice(0, this.state.history.length - this.maxHistory);
  }

  private persist(): void {
    this.store.save(this.state);
  }
}
