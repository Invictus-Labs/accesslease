import type { FastifyInstance } from "fastify";
import { ProviderUnavailableError, labelOf } from "../connectors/provider.js";
import { fail, unavailable } from "../errors.js";
import { getImportedLease, listImports } from "../services/evidence.js";
import { pullEvents } from "../services/events.js";
import { listJobs } from "../services/jobs.js";
import { getPolicy, setPolicy } from "../services/policy.js";
import { getReportData } from "../services/report.js";
import { requireRole } from "../services/roles.js";
import { type ApiDeps, bodyOf, idParam, who } from "./common.js";

/** Policy, provider status, jobs, events, report and restored evidence (RBAC per route; see docs/contracts/api.md). */
export function registerAdminRoutes(api: FastifyInstance, { ctx }: ApiDeps): void {
  api.get("/policy", async (req) => getPolicy(ctx, who(req)));
  api.put("/policy", async (req) => setPolicy(ctx, who(req), bodyOf(req)));

  // Provider status: a disconnected live connector is reported explicitly (AC-08), never hidden.
  api.get("/provider", async (req) => {
    requireRole(who(req), "operator");
    const provider = ctx.providers.get(ctx.providers.defaultKind);
    if (!provider) throw unavailable("provider_unavailable", `provider ${ctx.providers.defaultKind} is not configured`);
    const capabilities = provider.capabilities();
    try {
      await provider.ping();
      return { provider: labelOf(capabilities), capabilities, connected: true, code: null };
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return { provider: labelOf(capabilities), capabilities, connected: false, code: error.code };
      throw fail("provider_unavailable", "provider check failed");
    }
  });

  api.get("/jobs", async (req) => ({ items: await listJobs(ctx, who(req)) }));
  api.get("/events", async (req) => pullEvents(ctx, who(req), req.query as Record<string, never>));
  api.get("/report", async (req) => getReportData(ctx, who(req)));
  api.get("/imports", async (req) => ({ items: await listImports(ctx, who(req)) }));
  api.get("/imports/:importId/leases/:leaseId", async (req) => getImportedLease(ctx, who(req), idParam(req, "importId"), idParam(req, "leaseId")));
}
