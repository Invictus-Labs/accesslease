import type { FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.js";
import { safeEqual } from "../crypto.js";
import type { Principal } from "../domain/types.js";
import { badRequest, fail, forbidden, tooManyRequests, unauthorized, unprocessable } from "../errors.js";
import { authenticateSession, csrfFor, RateLimiter, SESSION_COOKIE } from "../services/auth.js";
import type { LeaseReceipt } from "../services/contract.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export type Report = (req: FastifyRequest, event: string, level: "info" | "warn" | "error", code?: string) => void;

export interface ApiDeps {
  ctx: Ctx;
  report: Report;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      try {
        out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        throw badRequest("invalid_cookie", "Malformed cookie encoding");
      }
    }
  }
  return out;
}

export const header = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export const who = (req: FastifyRequest): Principal => req.principal as Principal;

/** JSON object body; an absent body is `{}`. Arrays and scalars are 422. */
export function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const value = req.body ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw unprocessable("invalid_body", "Body must be a JSON object");
  return value as Record<string, unknown>;
}

export const idParam = (req: FastifyRequest, name = "id"): string => (req.params as Record<string, string>)[name] as string;

export const idempotencyKeyOf = (req: FastifyRequest): string | undefined => header(req, "idempotency-key");

/** Send a file as a download, never as executable application content. */
export function download(reply: FastifyReply, filename: string, contentType: string, body: string | Buffer): FastifyReply {
  return reply
    .header("content-type", contentType)
    .header("content-disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 150) || "download"}"`)
    .header("content-security-policy", "sandbox; default-src 'none'")
    .header("cache-control", "private, no-store")
    .send(body);
}

export function sendReceipt(reply: FastifyReply, receipt: LeaseReceipt & { http_status: number }): FastifyReply {
  const { http_status, ...body } = receipt;
  if (receipt.replayed) reply.header("idempotent-replayed", "true");
  return reply.status(http_status).send(body);
}

export interface Limiters {
  account: RateLimiter;
  address: RateLimiter;
  session: RateLimiter;
}

export const createLimiters = (ctx: Ctx): Limiters => ({
  account: new RateLimiter(10, 60_000),
  address: new RateLimiter(100, 60_000),
  session: new RateLimiter(ctx.settings.sessionRequestsPerMinute, 60_000),
});

/**
 * Session authentication for every non-public route: cookie -> principal (revocable, expiring), per-session rate limit and,
 * for any method that is not GET/HEAD, a CSRF token bound to the session.
 */
export function sessionAuth(ctx: Ctx, limiters: Limiters) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const principal = await authenticateSession(ctx, token);
    if (!principal || !token) throw unauthorized();
    const retry = limiters.session.take(principal.sessionId as string, ctx.clock().getTime());
    if (retry !== null) throw tooManyRequests(retry);
    if (req.method !== "GET" && req.method !== "HEAD") {
      const csrf = header(req, "x-csrf-token");
      if (!csrf || !safeEqual(csrf, csrfFor(ctx, token))) throw fail("csrf_invalid", "Missing or invalid CSRF token");
    }
    req.principal = principal;
  };
}

export const forbiddenError = forbidden;
