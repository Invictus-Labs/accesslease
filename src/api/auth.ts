import type { FastifyInstance } from "fastify";
import { LoginRequestSchema } from "../domain/schemas.js";
import { ROLES } from "../domain/types.js";
import { tooManyRequests, unprocessable } from "../errors.js";
import { addMember, csrfFor, listMembers, login, logout, SESSION_COOKIE } from "../services/auth.js";
import { type ApiDeps, bodyOf, header, type Limiters, parseCookies, who } from "./common.js";

const publicPrincipal = (p: ReturnType<typeof who>) => ({ id: p.userId, email: p.email, workspace_id: p.workspaceId, workspace_name: p.workspaceName, role: p.role });

export function registerPublicAuth(api: FastifyInstance, { ctx, report }: ApiDeps, limiters: Limiters): void {
  api.post("/auth/login", async (req, reply) => {
    const parsed = LoginRequestSchema.safeParse(bodyOf(req));
    if (!parsed.success) throw unprocessable("validation_failed", "email and password are required");
    const input = parsed.data;
    const now = ctx.clock().getTime();
    // Keyed identifiers keep raw emails and addresses out of the in-memory buckets.
    const retry = Math.max(
      limiters.address.take(ctx.key.mac("login-ip", req.ip), now) ?? 0,
      limiters.account.take(ctx.key.mac("login-account", input.email.trim().toLowerCase()), now) ?? 0,
    );
    if (retry > 0) throw tooManyRequests(retry);
    const result = await login(ctx, input.email, input.password, input.workspace_id);
    const cookie = [`${SESSION_COOKIE}=${result.token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${ctx.settings.sessionTtlSeconds}`, ctx.settings.secureCookies ? "Secure" : ""].filter(Boolean);
    reply.header("set-cookie", cookie.join("; "));
    report(req, "auth.login_succeeded", "info");
    return { user: publicPrincipal(result.principal), csrf_token: result.csrfToken };
  });
}

export function registerAuthed(api: FastifyInstance, { ctx }: ApiDeps): void {
  api.get("/auth/session", async (req) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] as string;
    return { user: publicPrincipal(who(req)), csrf_token: csrfFor(ctx, token) };
  });
  api.post("/auth/logout", async (req, reply) => {
    await logout(ctx, who(req));
    reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });
  api.get("/members", async (req) => ({ items: await listMembers(ctx, who(req)) }));
  api.post("/members", async (req, reply) => {
    const input = bodyOf(req);
    if (typeof input.email !== "string" || typeof input.password !== "string" || typeof input.role !== "string" || !(ROLES as readonly string[]).includes(input.role)) {
      throw unprocessable("validation_failed", "email, password and role (admin, operator or viewer) are required");
    }
    const member = await addMember(ctx, who(req), { email: input.email, password: input.password, role: input.role as (typeof ROLES)[number] });
    return reply.status(201).send(member);
  });
  void header;
}
