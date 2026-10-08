import type { FastifyInstance } from "fastify";
import { unprocessable } from "../errors.js";
import { exportBundle, importBundle, verifyBundle } from "../services/evidence.js";
import { requireRole } from "../services/roles.js";
import { type ApiDeps, download, who } from "./common.js";

/**
 * Evidence bundle routes. Export is a download; verify and import receive the raw JSON bytes (so a truncated bundle is
 * reported as `bundle_truncated`, not as a generic JSON error) with the import size limit instead of the 64 KiB body limit.
 */
export function registerExportRoute(api: FastifyInstance, { ctx }: ApiDeps): void {
  api.get("/evidence/export", async (req, reply) => {
    const query = req.query as { lease_ids?: string };
    const leaseIds = typeof query.lease_ids === "string" && query.lease_ids ? query.lease_ids.split(",").slice(0, 1000) : undefined;
    const result = await exportBundle(ctx, who(req), { leaseIds });
    return download(reply, `accesslease-evidence-${result.bundle_hash.slice(0, 12)}.json`, "application/json; charset=utf-8", result.bytes);
  });
}

export function registerRawEvidenceRoutes(api: FastifyInstance, { ctx }: ApiDeps): void {
  const limit = ctx.settings.importBlobCapBytes > 0 ? ctx.settings.importBlobCapBytes : ctx.settings.importMaxMetadataBytes;
  api.removeAllContentTypeParsers();
  api.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: limit }, (_req, body, done) => done(null, body));
  const raw = (req: { body: unknown }): Buffer => {
    if (!Buffer.isBuffer(req.body)) throw unprocessable("invalid_body", "Send the evidence bundle as application/json");
    return req.body;
  };
  api.post("/evidence/verify", { bodyLimit: limit }, async (req) => {
    requireRole(who(req), "operator");
    return verifyBundle(raw(req), { maxBytes: ctx.settings.importMaxMetadataBytes, maxFiles: ctx.settings.importMaxFiles, allowLarge: ctx.settings.importBlobCapBytes > 0 });
  });
  api.post("/evidence/import", { bodyLimit: limit }, async (req, reply) => {
    const receipt = await importBundle(ctx, who(req), raw(req));
    return reply.status(receipt.already_imported ? 200 : 201).send(receipt);
  });
}
