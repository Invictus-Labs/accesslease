import type { Principal, Role } from "../domain/types.js";
import { forbidden } from "../errors.js";

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

/** Viewers read; operators run scoped workflows; admins manage policy, members and imports. */
export function requireRole(principal: Principal, minimum: Role): void {
  if (RANK[principal.role] < RANK[minimum]) throw forbidden();
}
