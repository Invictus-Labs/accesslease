import type { Ctx } from "../context.js";
import { EventsQuerySchema } from "../domain/schemas.js";
import { type EventEnvelope, type EventType, LIST_MAX_LIMIT, type Principal } from "../domain/types.js";
import { unprocessable } from "../errors.js";
import { requireRole } from "./roles.js";

interface EventRow {
  seq: number;
  event_id: string;
  lease_id: string;
  event_type: EventType;
  occurred_at: Date;
  revision: number;
  evidence_ref: string;
  correlation_id: string | null;
}

export function toEnvelope(row: Omit<EventRow, "seq">): EventEnvelope {
  return {
    schema_version: 1,
    event_id: row.event_id,
    source: "accesslease",
    resource_id: row.lease_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at.toISOString(),
    revision: row.revision,
    evidence_ref: row.evidence_ref,
    ...(row.correlation_id ? { correlation_id: row.correlation_id } : {}),
  };
}

/**
 * `GET /events?after=<cursor>`: oldest first, at-least-once. The cursor is the last delivered per-workspace sequence
 * (start with "0"). Consumers dedupe `event_id`, reject unknown `schema_version`, keep `revision` ordering and never infer
 * the current lease state from an old event. No credentials appear in events.
 */
export async function pullEvents(ctx: Ctx, principal: Principal, query: { after?: string; limit?: number } = {}): Promise<{ items: EventEnvelope[]; next_cursor: string }> {
  requireRole(principal, "viewer");
  const parsed = EventsQuerySchema.safeParse(query);
  if (!parsed.success) throw unprocessable("validation_failed", "Invalid events query");
  const after = parsed.data.after ?? "0";
  if (!/^\d{1,15}$/.test(after)) throw unprocessable("validation_failed", "Invalid cursor");
  const limit = Math.min(parsed.data.limit ?? 50, LIST_MAX_LIMIT);
  const rows = (
    await ctx.db.query<EventRow>(
      `SELECT seq, event_id, lease_id, event_type, occurred_at, revision, evidence_ref, correlation_id
         FROM events WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [principal.workspaceId, after, limit],
    )
  ).rows;
  const last = rows[rows.length - 1];
  return { items: rows.map(toEnvelope), next_cursor: last ? String(last.seq) : after };
}
