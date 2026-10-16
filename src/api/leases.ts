import type { FastifyInstance } from "fastify";
import { approveLease, closeLease, getLease, listLeases, requestLease, retrieveCredential, revokeLease } from "../services/leases.js";
import { getLeaseEvidence } from "../services/evidence.js";
import { type ApiDeps, bodyOf, idempotencyKeyOf, idParam, sendReceipt, who } from "./common.js";

/** Lease routes (AC-01..AC-04, AC-12). Every handler delegates to the service layer, which enforces role and workspace. */
export function registerLeaseRoutes(api: FastifyInstance, { ctx }: ApiDeps): void {
  api.post("/leases", async (req, reply) => sendReceipt(reply, await requestLease(ctx, who(req), bodyOf(req), { idempotencyKey: idempotencyKeyOf(req) })));
  api.get("/leases", async (req) => listLeases(ctx, who(req), req.query as Record<string, never>));
  api.get("/leases/:id", async (req) => getLease(ctx, who(req), idParam(req)));
  api.post("/leases/:id/approve", async (req, reply) => sendReceipt(reply, await approveLease(ctx, who(req), idParam(req), bodyOf(req), { idempotencyKey: idempotencyKeyOf(req) })));
  api.post("/leases/:id/revoke", async (req, reply) => sendReceipt(reply, await revokeLease(ctx, who(req), idParam(req), bodyOf(req), { idempotencyKey: idempotencyKeyOf(req) })));
  api.post("/leases/:id/close", async (req, reply) => sendReceipt(reply, await closeLease(ctx, who(req), idParam(req), bodyOf(req), { idempotencyKey: idempotencyKeyOf(req) })));
  // One-time credential retrieval: authenticated, CSRF protected (POST), never cached, never in a URL or log.
  api.post("/leases/:id/credential", async (req, reply) => {
    const delivery = await retrieveCredential(ctx, who(req), idParam(req));
    return reply.header("cache-control", "no-store").header("pragma", "no-cache").send(delivery);
  });
  api.get("/leases/:id/evidence", async (req) => getLeaseEvidence(ctx, who(req), idParam(req)));
}
