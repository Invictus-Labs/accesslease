import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "./api/admin.js";
import { registerAuthed, registerPublicAuth } from "./api/auth.js";
import { type ApiDeps, createLimiters, sessionAuth } from "./api/common.js";
import { registerExportRoute, registerRawEvidenceRoutes } from "./api/evidence.js";
import { registerLeaseRoutes } from "./api/leases.js";
import type { Ctx } from "./context.js";
import { InvalidTransitionError } from "./domain/state-machine.js";
import { AppError, badRequest } from "./errors.js";
import { migrationStatus } from "./db/migrate.js";
import { runWorker } from "./workers/index.js";

export interface AppOptions {
  /** Directory with the built web UI; served with SPA fallback when present. */
  webRoot?: string;
  /** Log one redacted line per response (request id, route template, status). Off by default. */
  logRequests?: boolean;
}

const ERROR_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Build the Fastify app (no listening). Public: /health/*, POST /auth/login. Everything else requires a session cookie,
 * CSRF for non-GET, and a role check in the service layer. All responses are JSON with the PRD error envelope.
 */
export async function buildApp(ctx: Ctx, options: AppOptions = {}): Promise<FastifyInstance> {
  const report: ApiDeps["report"] = (req, event, level, code) =>
    ctx.log({ level, event, request_id: String(req.id), operation: req.routeOptions?.url ?? "unmatched", ...(code ? { code } : {}) });
  const app = Fastify({ logger: false, bodyLimit: ctx.settings.maxBodyBytes, genReqId: () => randomUUID() });
  const limiters = createLimiters(ctx);
  const deps: ApiDeps = { ctx, report };
  if (options.logRequests) app.addHook("onResponse", async (req, reply) => report(req, "http.response", "info", String(reply.statusCode)));

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = body as string;
    if (text.length === 0) return done(null, undefined);
    // PostgreSQL text cannot hold NUL; refuse it at the boundary instead of failing deep inside a write.
    if (/\\u0000/i.test(text)) return done(badRequest("bad_request", "Text must not contain NUL characters"), undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(badRequest("malformed_json", "Body is not valid JSON"), undefined);
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, req, reply) => {
    const requestId = String(req.id);
    const send = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
      reply.status(status).headers({ ...ERROR_HEADERS, ...headers }).send({ error: { code, message, request_id: requestId } });
    if (error instanceof AppError) {
      if (error.status === 401 || error.status === 403 || error.status === 429) report(req, error.status === 429 ? "auth.throttled" : "auth.denied", "warn", String(error.status));
      return send(error.status, error.code, error.message, error.headers);
    }
    if (error instanceof InvalidTransitionError) return send(409, "invalid_transition", error.message);
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" || error.statusCode === 413) return send(413, "payload_too_large", "Payload exceeds the size limit");
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) return send(400, "bad_request", "Request could not be processed");
    // Never echo raw errors: they can contain SQL, paths or secrets.
    report(req, "api.unhandled_error", "error", "internal");
    return send(500, "internal", "Internal error");
  });

  await app.register(
    async (api) => {
      api.get("/health/live", async () => ({ status: "ok" }));
      // Readiness: the database answers and every shipped migration is applied unmodified. A failed migration stops readiness.
      api.get("/health/ready", async (req, reply) => {
        try {
          const status = await migrationStatus(ctx.db);
          if (!status.ok) throw new Error(status.problem ?? "migrations not applied");
          return { status: "ready" };
        } catch {
          report(req, "api.not_ready", "error", "not_ready");
          return reply.status(503).send({ error: { code: "not_ready", message: "Database or schema unavailable", request_id: String(req.id) } });
        }
      });
      registerPublicAuth(api, deps, limiters);

      await api.register(async (authed) => {
        authed.addHook("preHandler", sessionAuth(ctx, limiters));
        registerAuthed(authed, deps);
        registerLeaseRoutes(authed, deps);
        registerAdminRoutes(authed, deps);
        registerExportRoute(authed, deps);
        // raw-body routes live in their own encapsulated scope (own content-type parser and size limit)
        await authed.register(async (rawScope) => {
          registerRawEvidenceRoutes(rawScope, deps);
        });
      });
    },
    { prefix: "/api/v1" },
  );

  const notFound = (req: FastifyRequest, reply: FastifyReply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Not found", request_id: String(req.id) } });
  if (options.webRoot && existsSync(join(options.webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? notFound(req, reply) : reply.type("text/html").sendFile("index.html")));
  } else {
    app.setNotFoundHandler(notFound);
  }

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    if (!reply.hasHeader("content-security-policy")) {
      reply.header(
        "content-security-policy",
        req.url.startsWith("/api/") ? "default-src 'none'; frame-ancestors 'none'" : "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
      );
    }
    return payload;
  });
  return app;
}

export interface StartOptions extends AppOptions {
  host: string;
  port: number;
  /** Also run the worker loop in this process (single-process deployments and demos). */
  worker?: boolean;
}

/** Listen on the configured address. The default bind is 127.0.0.1; 0.0.0.0 exposes the API to every network interface of the host. */
export async function startServer(ctx: Ctx, options: StartOptions): Promise<{ address: string; close(): Promise<void> }> {
  const app = await buildApp(ctx, options);
  const abort = new AbortController();
  await app.listen({ host: options.host, port: options.port });
  const addr = app.server.address();
  const address = typeof addr === "object" && addr ? `http://${addr.family === "IPv6" ? `[${addr.address}]` : addr.address}:${addr.port}` : String(addr);
  const loop = options.worker ? runWorker(ctx, { signal: abort.signal }) : Promise.resolve();
  return {
    address,
    async close() {
      abort.abort();
      await app.close();
      await loop;
    },
  };
}
