import type { Ctx } from "../context.js";

/** Leases whose state is not resolved: ISSUE_UNKNOWN and REVOCATION_UNCONFIRMED. A command that leaves any of them must not exit 0 (CLI exit code 4). */
export async function unresolvedCount(ctx: Ctx, workspaceId?: string): Promise<{ issueUnknown: number; revocationUnconfirmed: number }> {
  const result = await ctx.db.query<{ state: string; n: number }>(
    `SELECT state::text AS state, count(*)::int AS n FROM leases
      WHERE state IN ('ISSUE_UNKNOWN', 'REVOCATION_UNCONFIRMED') AND ($1::uuid IS NULL OR workspace_id = $1::uuid) GROUP BY state`,
    [workspaceId ?? null],
  );
  const get = (state: string) => result.rows.find((r) => r.state === state)?.n ?? 0;
  return { issueUnknown: get("ISSUE_UNKNOWN"), revocationUnconfirmed: get("REVOCATION_UNCONFIRMED") };
}
