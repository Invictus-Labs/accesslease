import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** What the consumer remembers about a resource. It is the last reported event, never an inferred current state. */
export interface ResourceView {
  resource_id: string;
  /** Highest revision applied so far. */
  revision: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  evidence_ref: string;
  source: string;
  schema_version: number;
  correlation_id?: string;
}

/** Ordering and version metadata is kept for every accepted or stale event (history is append-only). */
export interface HistoryEntry {
  event_id: string;
  resource_id: string;
  revision: number;
  occurred_at: string;
  event_type: string;
  schema_version: number;
  applied: boolean;
  note?: string;
}

export interface ConsumerState {
  /** Insertion-ordered event ids, bounded by `maxSeen` (the documented dedupe horizon). */
  seen: string[];
  resources: Record<string, ResourceView>;
  history: HistoryEntry[];
  cursor: string | null;
}

export const emptyState = (): ConsumerState => ({ seen: [], resources: {}, history: [], cursor: null });

export interface ConsumerStore {
  load(): ConsumerState;
  save(state: ConsumerState): void;
}

export class MemoryStore implements ConsumerStore {
  private state: ConsumerState = emptyState();
  load(): ConsumerState {
    return structuredClone(this.state);
  }
  save(state: ConsumerState): void {
    this.state = structuredClone(state);
  }
}

/** JSON file store: written atomically (temp file + rename) with owner-only permissions. */
export class FileStore implements ConsumerStore {
  constructor(private readonly path: string) {}

  load(): ConsumerState {
    if (!existsSync(this.path)) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("adapter state file is unreadable or corrupt; refusing to continue (move it aside to start fresh)");
    }
    const s = parsed as Partial<ConsumerState> | null;
    if (!s || !Array.isArray(s.seen) || typeof s.resources !== "object" || !s.resources || !Array.isArray(s.history)) {
      throw new Error("adapter state file has an unexpected shape; refusing to continue (move it aside to start fresh)");
    }
    return { seen: s.seen, resources: s.resources, history: s.history, cursor: typeof s.cursor === "string" ? s.cursor : null };
  }

  save(state: ConsumerState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
