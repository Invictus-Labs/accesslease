import type { Ctx } from "../context.js";
import { addSeconds } from "../context.js";
import { contentHash } from "../crypto.js";
import type { Queryable } from "../db/index.js";
import { IDEMPOTENCY_RETENTION_DAYS, type Principal } from "../domain/types.js";
import { conflict, unprocessable } from "../errors.js";

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface Mutated<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Run a mutation in one transaction with Idempotency-Key semantics: scope = workspace + actor + route; the same key
 * with the same canonical body replays the stored receipt; a changed body is 409. Failures roll back, so a failed
 * request does not consume its key. Without a key the mutation just runs transactionally.
 */
export async function mutate<T>(
  ctx: Ctx,
  principal: Principal,
  route: string,
  key: string | undefined,
  body: unknown,
  status: number,
  fn: (tx: Queryable) => Promise<T>,
): Promise<Mutated<T>> {
  if (key !== undefined && !KEY_RE.test(key)) throw unprocessable("validation_failed", "Idempotency-Key must be 8-128 characters of [A-Za-z0-9_.:-]");
  const bodyHash = contentHash(body ?? null);
  return ctx.db.transaction(async (tx) => {
    if (key !== undefined) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${principal.workspaceId}|${principal.actorRef}|${route}|${key}`]);
      const existing = await tx.query<{ body_hash: string; status: number; response: T }>(
        "SELECT body_hash, status, response FROM idempotency_keys WHERE workspace_id = $1 AND actor_ref = $2 AND route = $3 AND key = $4",
        [principal.workspaceId, principal.actorRef, route, key],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.body_hash !== bodyHash) throw conflict("idempotency_conflict", "Idempotency-Key was already used with a different request body");
        return { status: row.status, body: row.response, replayed: true };
      }
    }
    const result = await fn(tx);
    if (key !== undefined) {
      await tx.query(
        "INSERT INTO idempotency_keys (workspace_id, actor_ref, route, key, body_hash, status, response, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [principal.workspaceId, principal.actorRef, route, key, bodyHash, status, JSON.stringify(result), ctx.clock()],
      );
    }
    return { status, body: result, replayed: false };
  });
}

/** Keys are retained at least 7 days; the worker purges after 8. Returns rows deleted. */
export async function purgeIdempotencyKeys(db: Queryable, now: Date): Promise<number> {
  const result = await db.query("DELETE FROM idempotency_keys WHERE created_at < $1", [addSeconds(now, -(IDEMPOTENCY_RETENTION_DAYS + 1) * 86_400)]);
  return result.rowCount;
}
