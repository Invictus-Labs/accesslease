import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { ProviderRegistry } from "../../../src/connectors/provider.js";
import { CredentialDeliverySchema, ErrorSchema, EventPageSchema, LeaseDetailSchema, LeasePageSchema, LeaseViewSchema } from "../../../src/domain/schemas.js";
import { buildApp, startServer } from "../../../src/server.js";
import { runWorkerOnce } from "../../../src/workers/index.js";
import { credentialSecretFor } from "../../../src/workers/issue.js";
import { drive, type Env, goodRequest, iso, makeEnv } from "./helpers.js";

const PASSWORD = "synthetic-password-123";
const PLANTED = "PLANTED_SECRET_TOKEN_api_77c1";
let env: Env;
let app: FastifyInstance;

interface Session {
  cookie: string;
  csrf: string;
}

async function login(application: FastifyInstance, email: string, password = PASSWORD): Promise<Session> {
  const res = await application.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = String(res.headers["set-cookie"]).split(";")[0] as string;
  return { cookie, csrf: res.json().csrf_token };
}

const call = async (application: FastifyInstance, session: Session | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) =>
  application.inject({
    method,
    url: `/api/v1${url}`,
    payload: payload as object,
    headers: { ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}), ...extraHeaders },
  });

let admin: Session;
let operator: Session;
let viewer: Session;
let otherOperator: Session;
let otherViewer: Session;

beforeAll(async () => {
  env = await makeEnv({ settings: { sessionRequestsPerMinute: 100_000 } });
  app = await buildApp(env.ctx);
  admin = await login(app, "admin-main@example.test");
  operator = await login(app, "operator-main@example.test");
  viewer = await login(app, "viewer-main@example.test");
  otherOperator = await login(app, "operator-other@example.test");
  otherViewer = await login(app, "viewer-other@example.test");
});
afterAll(async () => {
  await app.close();
  await env.drop();
});

const futureISO = (seconds: number) => iso(env.clock, seconds);

describe("health, errors and hostile input", () => {
  it("serves liveness and readiness, and a failed migration stops readiness (AC-13)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/health/live" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/api/v1/health/ready" })).json()).toEqual({ status: "ready" });
    const broken = await makeEnv();
    try {
      const brokenApp = await buildApp(broken.ctx);
      await broken.ctx.db.query("UPDATE schema_migrations SET checksum = 'tampered'");
      const res = await brokenApp.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("not_ready");
      expect((await brokenApp.inject({ method: "GET", url: "/api/v1/health/live" })).statusCode).toBe(200);
      await brokenApp.close();
    } finally {
      await broken.drop();
    }
  });

  it("answers with the PRD error envelope, a request id and security headers; unknown routes are 404 JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(ErrorSchema.parse(res.json()).error.code).toBe("not_found");
    expect(res.json().error.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "GET", url: "/elsewhere" })).statusCode).toBe(404);
  });

  it("requires a session for every protected route (401) and CSRF for every mutation (403)", async () => {
    const protectedRoutes: [("GET" | "POST" | "PUT"), string][] = [
      ["GET", "/auth/session"],
      ["POST", "/auth/logout"],
      ["GET", "/members"],
      ["POST", "/members"],
      ["GET", "/policy"],
      ["PUT", "/policy"],
      ["GET", "/provider"],
      ["POST", "/leases"],
      ["GET", "/leases"],
      ["GET", `/leases/${env.workspaceId}`],
      ["POST", `/leases/${env.workspaceId}/approve`],
      ["POST", `/leases/${env.workspaceId}/revoke`],
      ["POST", `/leases/${env.workspaceId}/close`],
      ["POST", `/leases/${env.workspaceId}/credential`],
      ["GET", `/leases/${env.workspaceId}/evidence`],
      ["GET", "/evidence/export"],
      ["POST", "/evidence/verify"],
      ["POST", "/evidence/import"],
      ["GET", "/imports"],
      ["GET", `/imports/${env.workspaceId}/leases/${env.workspaceId}`],
      ["GET", "/jobs"],
      ["GET", "/events"],
      ["GET", "/report"],
    ];
    for (const [method, url] of protectedRoutes) {
      const res = await call(app, null, method, url, method === "GET" ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
    for (const [method, url] of protectedRoutes.filter(([m]) => m !== "GET")) {
      const noCsrf = await app.inject({ method, url: `/api/v1${url}`, payload: {}, headers: { cookie: operator.cookie } });
      expect(noCsrf.statusCode, `${method} ${url}`).toBe(403);
      expect(noCsrf.json().error.code).toBe("csrf_invalid");
      const wrong = await app.inject({ method, url: `/api/v1${url}`, payload: {}, headers: { cookie: operator.cookie, "x-csrf-token": "nope" } });
      expect(wrong.statusCode).toBe(403);
    }
    // a CSRF token from another session does not work either
    const crossed = await app.inject({ method: "POST", url: "/api/v1/leases", payload: goodRequest(), headers: { cookie: operator.cookie, "x-csrf-token": viewer.csrf } });
    expect(crossed.statusCode).toBe(403);
  });

  it("validates size, JSON, content type and shape before processing", async () => {
    const raw = (payload: string, type = "application/json") => app.inject({ method: "POST", url: "/api/v1/leases", payload, headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf, "content-type": type } });
    expect((await raw("{not json")).json().error.code).toBe("malformed_json");
    expect((await raw('{"task_ref":"a\\u0000b"}')).statusCode).toBe(400);
    expect((await raw("[1,2]")).json().error.code).toBe("invalid_body");
    expect((await raw('"text"')).json().error.code).toBe("invalid_body");
    expect((await raw("x".repeat(70 * 1024))).statusCode).toBe(413);
    const big = await raw(JSON.stringify({ ...goodRequest(), task_ref: "y".repeat(80 * 1024) }));
    expect([big.statusCode, big.json().error.code]).toEqual([413, "payload_too_large"]);
    expect((await raw("hello", "text/plain")).statusCode).toBe(422);
    expect((await raw("hello", "application/xml")).statusCode).toBe(400);
    const unknown = await call(app, operator, "POST", "/leases", { ...goodRequest(), surprise: true });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([422, "validation_failed"]);
    const empty = await app.inject({ method: "POST", url: "/api/v1/leases", headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf } });
    expect(empty.statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: "accesslease_session=%E0%A4%A" } })).json().error.code).toBe("invalid_cookie");
    expect((await call(app, viewer, "GET", "/leases?limit=abc")).statusCode).toBe(422);
    expect((await call(app, viewer, "GET", "/leases?surprise=1")).statusCode).toBe(422);
    expect((await call(app, viewer, "GET", "/events?after=zz")).statusCode).toBe(422);
  });

  it("does not leak internals on unexpected failures", async () => {
    const original = env.ctx.db.query;
    env.ctx.db.query = async () => {
      throw new Error("SELECT secret FROM somewhere password=hunter2 /home/someone/path");
    };
    try {
      const res = await call(app, viewer, "GET", "/events");
      expect(res.statusCode).toBe(500); // the session lookup itself failed: closed, generic, no detail
      expect(res.body).not.toContain("hunter2");
      expect(res.body).not.toContain("somewhere");
    } finally {
      env.ctx.db.query = original;
    }
    const logsBefore = env.logs.length;
    const original2 = env.ctx.db.transaction;
    env.ctx.db.transaction = async () => {
      throw new Error("boom password=hunter2 /home/someone/path");
    };
    try {
      const res = await call(app, operator, "POST", "/leases", goodRequest());
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatchObject({ code: "internal", message: "Internal error" });
      expect(res.body).not.toContain("hunter2");
      expect(env.logs.slice(logsBefore).join("\n")).not.toContain("hunter2");
      expect(env.logs.slice(logsBefore).join("\n")).toContain("api.unhandled_error");
    } finally {
      env.ctx.db.transaction = original2;
    }
  });
});

describe("authentication", () => {
  it("rejects wrong credentials identically, throttles, and issues HttpOnly SameSite cookies", async () => {
    const wrong = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "operator-main@example.test", password: "wrong-password-xx" } });
    const unknown = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody@example.test", password: "wrong-password-xx" } });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "x" } })).statusCode).toBe(422);
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "viewer-main@example.test", password: PASSWORD } });
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/^accesslease_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(ok.json()).toMatchObject({ user: { email: "viewer-main@example.test", role: "viewer", workspace_name: "main" } });
    const secure = await makeEnv({ settings: { secureCookies: true } });
    try {
      const secureApp = await buildApp(secure.ctx);
      const res = await secureApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "viewer-main@example.test", password: PASSWORD } });
      expect(String(res.headers["set-cookie"])).toContain("; Secure");
      await secureApp.close();
    } finally {
      await secure.drop();
    }
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "throttle@example.test", password: "wrong-password-xx" } });
      last = res.statusCode;
      if (last === 429) {
        expect(res.headers["retry-after"]).toBeDefined();
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("sessions are revocable (logout), expire, and die with the membership", async () => {
    const s = await login(app, "viewer-main@example.test");
    expect((await call(app, s, "GET", "/auth/session")).json().csrf_token).toBe(s.csrf);
    expect((await call(app, s, "POST", "/auth/logout")).json()).toEqual({ ok: true });
    expect((await call(app, s, "GET", "/auth/session")).statusCode).toBe(401);
    const expiring = await login(app, "viewer-main@example.test");
    env.clock.advance(13 * 3600);
    expect((await call(app, expiring, "GET", "/leases")).statusCode).toBe(401);
    const removed = await login(app, "viewer-main@example.test");
    await env.ctx.db.query("DELETE FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = 'viewer-main@example.test') AND workspace_id = $1", [env.workspaceId]);
    expect((await call(app, removed, "GET", "/leases")).statusCode).toBe(401);
    // restore the shared sessions for the remaining tests
    await env.ctx.db.query("INSERT INTO memberships (workspace_id, user_id, role) SELECT $1, id, 'viewer' FROM users WHERE email = 'viewer-main@example.test'", [env.workspaceId]);
    admin = await login(app, "admin-main@example.test");
    operator = await login(app, "operator-main@example.test");
    viewer = await login(app, "viewer-main@example.test");
    otherOperator = await login(app, "operator-other@example.test");
    otherViewer = await login(app, "viewer-other@example.test");
  });

  it("admins add members with a chosen password (no default password); weak passwords and duplicates are refused", async () => {
    const created = await call(app, admin, "POST", "/members", { email: "New.Person@example.test", password: "a-brand-new-password", role: "operator" });
    expect(created.statusCode).toBe(201);
    const session = await login(app, "new.person@example.test", "a-brand-new-password");
    expect((await call(app, session, "GET", "/leases")).statusCode).toBe(200);
    expect((await call(app, admin, "POST", "/members", { email: "new.person@example.test", password: "a-brand-new-password", role: "viewer" })).statusCode).toBe(409);
    expect((await call(app, admin, "POST", "/members", { email: "weak@example.test", password: "short", role: "viewer" })).statusCode).toBe(422);
    expect((await call(app, admin, "POST", "/members", { email: "w2@example.test", password: "long-enough-password", role: "root" })).statusCode).toBe(422);
    const members = (await call(app, admin, "GET", "/members")).json().items;
    expect(members.map((m: { email: string }) => m.email)).toContain("new.person@example.test");
    expect((await call(app, operator, "GET", "/members")).statusCode).toBe(403);
    expect((await call(app, operator, "POST", "/members", { email: "x@example.test", password: "long-enough-password", role: "viewer" })).statusCode).toBe(403);
  });
});

describe("leases over HTTP (AC-01..AC-04, AC-12)", () => {
  it("runs the full lifecycle with schema-valid responses and a one-time credential", async () => {
    const created = await call(app, operator, "POST", "/leases", goodRequest({ task_ref: `http-flow ${PLANTED}`, expires_at: futureISO(600) }), { "idempotency-key": "http-flow-key-1" });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    LeaseViewSchema.parse(body.lease);
    expect(body).toMatchObject({ state: "requested", replayed: false });
    expect(body.lease.task_ref).toBe("http-flow [REDACTED]");
    const id = body.id as string;

    const replay = await call(app, operator, "POST", "/leases", goodRequest({ task_ref: `http-flow ${PLANTED}`, expires_at: futureISO(600) }), { "idempotency-key": "http-flow-key-1" });
    expect([replay.statusCode, replay.headers["idempotent-replayed"], replay.json().id]).toEqual([201, "true", id]);
    const conflict = await call(app, operator, "POST", "/leases", goodRequest({ task_ref: "different", expires_at: futureISO(600) }), { "idempotency-key": "http-flow-key-1" });
    expect([conflict.statusCode, conflict.json().error.code]).toEqual([409, "idempotency_conflict"]);
    expect((await call(app, operator, "POST", "/leases", goodRequest(), { "idempotency-key": "x" })).statusCode).toBe(422);

    const wrongHash = await call(app, operator, "POST", `/leases/${id}/approve`, { plan_hash: "a".repeat(64) });
    expect([wrongHash.statusCode, wrongHash.json().error.code]).toEqual([409, "plan_hash_mismatch"]);
    const approved = await call(app, operator, "POST", `/leases/${id}/approve`, { plan_hash: body.plan_hash });
    expect([approved.statusCode, approved.json().state]).toEqual([202, "approved"]);
    await drive(env);

    const detail = await call(app, viewer, "GET", `/leases/${id}`);
    const parsed = LeaseDetailSchema.parse(detail.json());
    expect(parsed.state).toBe("active");
    expect(detail.body).not.toContain(PLANTED);
    expect(detail.body).not.toContain(credentialSecretFor(env.ctx, id));

    const credential = await call(app, operator, "POST", `/leases/${id}/credential`);
    expect(credential.statusCode).toBe(200);
    expect(credential.headers["cache-control"]).toBe("no-store");
    const delivery = CredentialDeliverySchema.parse(credential.json());
    expect(delivery.credential.secret).toBe(credentialSecretFor(env.ctx, id));
    expect((await call(app, operator, "POST", `/leases/${id}/credential`)).json().error.code).toBe("credential_already_retrieved");
    expect((await call(app, viewer, "POST", `/leases/${id}/credential`)).statusCode).toBe(403);
    expect(env.logs.join("\n")).not.toContain(delivery.credential.secret);

    const evidence = await call(app, viewer, "GET", `/leases/${id}/evidence`);
    expect(evidence.statusCode).toBe(200);
    expect(evidence.body).not.toContain(delivery.credential.secret);

    const revoked = await call(app, operator, "POST", `/leases/${id}/revoke`, { reason: "http revoke" });
    expect([revoked.statusCode, revoked.json().state]).toEqual([202, "revoking"]);
    await drive(env);
    expect((await call(app, viewer, "GET", `/leases/${id}`)).json()).toMatchObject({ state: "revoked_verified", revocation_status: "verified", warning: null });
    const closeTwice = await call(app, operator, "POST", `/leases/${id}/close`, {});
    expect([closeTwice.statusCode, closeTwice.json().state]).toEqual([202, "revoked_verified"]);
  });

  it("enforces AC-01 policy over HTTP: wildcard/admin scopes and long TTLs are 422 and create nothing", async () => {
    const before = (await call(app, viewer, "GET", "/leases?limit=100")).json().items.length;
    for (const [payload, code] of [
      [goodRequest({ scopes: ["*"] }), "scope_wildcard"],
      [goodRequest({ scopes: ["synthetic:admin:read"] }), "scope_forbidden"],
      [goodRequest({ expires_at: futureISO(9 * 3600) }), "ttl_exceeds_max"],
      [goodRequest({ expires_at: futureISO(1) }), "ttl_below_min"],
    ] as const) {
      const res = await call(app, operator, "POST", "/leases", payload);
      expect([res.statusCode, res.json().error.code]).toEqual([422, code]);
    }
    expect((await call(app, viewer, "GET", "/leases?limit=100")).json().items.length).toBe(before);
    expect((await call(app, operator, "PUT", "/policy", { max_ttl_seconds: 3600 })).statusCode).toBe(403);
    const policy = (await call(app, viewer, "GET", "/policy")).json();
    expect(policy).toMatchObject({ default_ttl_seconds: 3600, max_ttl_seconds: 28800 });
    const updated = await call(app, admin, "PUT", "/policy", { max_ttl_seconds: 7200, expected_version: policy.version });
    expect(updated.json().max_ttl_seconds).toBe(7200);
    expect((await call(app, operator, "POST", "/leases", goodRequest({ expires_at: futureISO(7201) }))).json().error.code).toBe("ttl_exceeds_max");
    await call(app, admin, "PUT", "/policy", { max_ttl_seconds: 28800 });
  });

  it("paginates with cursors, capped at 100", async () => {
    for (let i = 0; i < 3; i += 1) await call(app, operator, "POST", "/leases", goodRequest({ task_ref: `page-${i}`, expires_at: futureISO(900) }));
    const page = await call(app, viewer, "GET", "/leases?limit=1");
    const parsed = LeasePageSchema.parse(page.json());
    expect(parsed.items).toHaveLength(1);
    expect(parsed.next_cursor).not.toBeNull();
    const next = await call(app, viewer, "GET", `/leases?limit=1&cursor=${encodeURIComponent(parsed.next_cursor as string)}`);
    expect(next.json().items[0].id).not.toBe(parsed.items[0]?.id);
    expect((await call(app, viewer, "GET", "/leases?limit=100000")).json().items.length).toBeLessThanOrEqual(100);
    expect((await call(app, viewer, "GET", "/leases?cursor=garbage")).statusCode).toBe(422);
    expect((await call(app, viewer, "GET", "/leases?state=ACTIVE")).json().items.every((l: { state: string }) => l.state === "active")).toBe(true);
  });

  it("AC-12: RBAC on reads, writes, jobs and exports; cross-workspace ids are 404 with no state change", async () => {
    const created = (await call(app, operator, "POST", "/leases", goodRequest({ task_ref: "isolation", expires_at: futureISO(900) }))).json();
    const id = created.id as string;
    await call(app, operator, "POST", `/leases/${id}/approve`, { plan_hash: created.plan_hash });
    await drive(env);
    const stateBefore = (await call(app, viewer, "GET", `/leases/${id}`)).json();
    expect(stateBefore.state).toBe("active");

    const foreignRoutes: [("GET" | "POST"), string, unknown?][] = [
      ["GET", `/leases/${id}`],
      ["POST", `/leases/${id}/approve`, { plan_hash: created.plan_hash }],
      ["POST", `/leases/${id}/revoke`, { reason: "attack" }],
      ["POST", `/leases/${id}/close`, {}],
      ["POST", `/leases/${id}/credential`],
      ["GET", `/leases/${id}/evidence`],
    ];
    const bodies = new Set<string>();
    for (const [method, url, payload] of foreignRoutes) {
      const res = await call(app, otherOperator, method, url, payload ?? (method === "POST" ? {} : undefined));
      expect([res.statusCode, res.json().error.code], `${method} ${url}`).toEqual([404, "not_found"]);
      bodies.add(res.json().error.message);
    }
    const missing = await call(app, otherOperator, "GET", `/leases/${env.workspaceId}`);
    expect(missing.statusCode).toBe(404);
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(missing.json().error.message);
    expect((await call(app, viewer, "GET", `/leases/${id}`)).json()).toEqual(stateBefore);
    expect((await call(app, otherViewer, "GET", "/leases")).json().items).toEqual([]);
    expect((await call(app, otherViewer, "GET", "/events")).json().items).toEqual([]);
    expect((await call(app, otherOperator, "GET", "/jobs")).json().items).toEqual([]);
    expect((await call(app, otherViewer, "GET", "/report")).json().summary.total).toBe(0);
    expect((await call(app, otherOperator, "GET", `/evidence/export?lease_ids=${id}`)).statusCode).toBe(404);

    const roleChecks: [Session, ("GET" | "POST" | "PUT"), string, number][] = [
      [viewer, "POST", "/leases", 403],
      [viewer, "POST", `/leases/${id}/revoke`, 403],
      [viewer, "POST", `/leases/${id}/credential`, 403],
      [viewer, "GET", "/jobs", 403],
      [viewer, "GET", "/provider", 403],
      [viewer, "GET", "/evidence/export", 403],
      [viewer, "POST", "/evidence/verify", 403],
      [viewer, "POST", "/evidence/import", 403],
      [viewer, "PUT", "/policy", 403],
      [viewer, "GET", "/members", 403],
      [operator, "POST", "/evidence/import", 403],
      [operator, "PUT", "/policy", 403],
      [operator, "GET", "/members", 403],
      [viewer, "GET", "/leases", 200],
      [viewer, "GET", "/policy", 200],
      [viewer, "GET", "/events", 200],
      [viewer, "GET", "/report", 200],
      [viewer, "GET", "/imports", 200],
      [operator, "GET", "/jobs", 200],
      [operator, "GET", "/provider", 200],
      [operator, "GET", "/evidence/export", 200],
      [admin, "GET", "/jobs", 200],
      [admin, "GET", "/members", 200],
    ];
    for (const [session, method, url, status] of roleChecks) {
      const payload = method === "GET" ? undefined : url.endsWith("/revoke") ? { reason: "x" } : {};
      const res = await call(app, session, method, url, payload);
      expect(res.statusCode, `${method} ${url} as ${session === viewer ? "viewer" : session === operator ? "operator" : "admin"}`).toBe(status);
    }
    await call(app, operator, "POST", `/leases/${id}/revoke`, { reason: "cleanup" });
    await drive(env);
  });

  it("AC-09 over HTTP: planted secrets and hostile markup stay data in every read path", async () => {
    const hostile = `<img src=x onerror=alert(1)> ${PLANTED} authorization=Bearer abcdefghijk0123456789`;
    const created = await call(app, operator, "POST", "/leases", goodRequest({ task_ref: hostile, subject_ref: "contractor <b>bold</b>", expires_at: futureISO(900) }));
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    for (const url of ["/leases", `/leases/${id}`, `/leases/${id}/evidence`, "/report", "/events", `/evidence/export?lease_ids=${id}`]) {
      const res = await call(app, viewer.csrf ? operator : viewer, "GET", url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(PLANTED);
      expect(res.body, url).not.toContain("abcdefghijk0123456789");
      expect(String(res.headers["content-type"]), url).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
    }
    const detail = (await call(app, viewer, "GET", `/leases/${id}`)).json();
    expect(detail.task_ref).toContain("<img src=x onerror=alert(1)>");
    expect(detail.subject_ref).toBe("contractor <b>bold</b>");
    expect(env.logs.join("\n")).not.toContain(PLANTED);
    await call(app, operator, "POST", `/leases/${id}/revoke`, { reason: "cleanup" });
    await drive(env);
  });

  it("events are pulled with the versioned envelope", async () => {
    const page = await call(app, viewer, "GET", "/events?limit=5");
    const parsed = EventPageSchema.parse(page.json());
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.every((e) => e.schema_version === 1 && e.source === "accesslease")).toBe(true);
    const more = await call(app, viewer, "GET", `/events?after=${parsed.next_cursor}&limit=5`);
    expect(more.json().items[0]?.event_id).not.toBe(parsed.items[0]?.event_id);
  });
});

describe("provider, jobs, report and evidence routes", () => {
  it("reports provider connection explicitly (synthetic connected; unreachable live provider is connected:false)", async () => {
    const res = await call(app, operator, "GET", "/provider");
    expect(res.json()).toMatchObject({ provider: { kind: "synthetic", label: "SYNTHETIC", live: false }, connected: true });
    const dead = await makeEnv({ providers: [new PostgresRoleProvider({ adminUrl: "postgres://postgres:x@127.0.0.1:1/postgres", allowlist: ["127.0.0.1"], connectTimeoutMs: 300 })] });
    try {
      const deadApp = await buildApp(dead.ctx);
      const session = await login(deadApp, "operator-main@example.test");
      const status = (await call(deadApp, session, "GET", "/provider")).json();
      expect(status).toMatchObject({ provider: { kind: "postgres-role", live: true }, connected: false, code: "provider_unavailable" });
      const unconfigured = await makeEnv({ providers: [] });
      const flaky = await makeEnv();
      flaky.provider.ping = async () => {
        throw new Error("unexpected provider failure");
      };
      const flakyApp = await buildApp(flaky.ctx);
      const flakySession = await login(flakyApp, "operator-main@example.test");
      expect((await call(flakyApp, flakySession, "GET", "/provider")).json().error.code).toBe("provider_unavailable");
      await flakyApp.close();
      await flaky.drop();
      const bareApp = await buildApp(unconfigured.ctx);
      const bare = await login(bareApp, "operator-main@example.test");
      expect((await call(bareApp, bare, "GET", "/provider")).statusCode).toBe(503);
      expect((await call(bareApp, bare, "POST", "/leases", goodRequest())).statusCode).toBe(503);
      await bareApp.close();
      await unconfigured.drop();
      await deadApp.close();
    } finally {
      await dead.drop();
    }
  });

  it("exports, verifies and imports evidence bundles through the API (AC-10)", async () => {
    const exported = await call(app, operator, "GET", "/evidence/export");
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toMatch(/^attachment; filename="accesslease-evidence-[0-9a-f]{12}\.json"$/);
    expect(exported.headers["content-security-policy"]).toContain("sandbox");
    const bytes = exported.rawPayload;
    const verified = await app.inject({ method: "POST", url: "/api/v1/evidence/verify", payload: bytes, headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf, "content-type": "application/json" } });
    expect(verified.json()).toMatchObject({ ok: true, schema_version: 1 });
    const truncated = await app.inject({ method: "POST", url: "/api/v1/evidence/verify", payload: bytes.subarray(0, bytes.length - 20), headers: { cookie: operator.cookie, "x-csrf-token": operator.csrf, "content-type": "application/json" } });
    expect(truncated.json()).toMatchObject({ ok: false, code: "bundle_truncated" });

    const clean = await makeEnv({ settings: { sessionRequestsPerMinute: 100_000 } });
    try {
      const cleanApp = await buildApp(clean.ctx);
      const cleanAdmin = await login(cleanApp, "admin-main@example.test");
      const cleanOperator = await login(cleanApp, "operator-main@example.test");
      const post = (session: Session, payload: Buffer) => cleanApp.inject({ method: "POST", url: "/api/v1/evidence/import", payload, headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" } });
      expect((await post(cleanOperator, bytes)).statusCode).toBe(403);
      const first = await post(cleanAdmin, bytes);
      expect([first.statusCode, first.json().already_imported]).toEqual([201, false]);
      const second = await post(cleanAdmin, bytes);
      expect([second.statusCode, second.json().already_imported, second.json().import_id]).toEqual([200, true, first.json().import_id]);
      const bad = await post(cleanAdmin, bytes.subarray(0, 100));
      expect([bad.statusCode, bad.json().error.code]).toEqual([422, "bundle_truncated"]);
      const imports = await call(cleanApp, cleanAdmin, "GET", "/imports");
      expect(imports.json().items).toHaveLength(1);
      const firstLease = JSON.parse(bytes.toString("utf8")).files["summary.json"].lease_ids[0] as string;
      const restored = await call(cleanApp, cleanAdmin, "GET", `/imports/${first.json().import_id}/leases/${firstLease}`);
      expect(restored.json()).toMatchObject({ hash_verified: true, lease_id: firstLease });
      expect((await cleanApp.inject({ method: "POST", url: "/api/v1/evidence/import", payload: { not: "a bundle" }, headers: { cookie: cleanAdmin.cookie, "x-csrf-token": cleanAdmin.csrf } })).json().error.code).toBe("bundle_malformed");
      expect((await cleanApp.inject({ method: "POST", url: "/api/v1/evidence/import", payload: "x", headers: { cookie: cleanAdmin.cookie, "x-csrf-token": cleanAdmin.csrf, "content-type": "text/plain" } })).statusCode).toBe(400);
      const bodyless = await cleanApp.inject({ method: "POST", url: "/api/v1/evidence/verify", headers: { cookie: cleanOperator.cookie, "x-csrf-token": cleanOperator.csrf } });
      expect([bodyless.statusCode, bodyless.json().error.code]).toEqual([422, "invalid_body"]);
      await cleanApp.close();
    } finally {
      await clean.drop();
    }
    const tight = await makeEnv({ settings: { importMaxMetadataBytes: 1000 } });
    try {
      const tightApp = await buildApp(tight.ctx);
      const tightAdmin = await login(tightApp, "admin-main@example.test");
      const res = await tightApp.inject({ method: "POST", url: "/api/v1/evidence/import", payload: bytes, headers: { cookie: tightAdmin.cookie, "x-csrf-token": tightAdmin.csrf, "content-type": "application/json" } });
      expect([res.statusCode, res.json().error.code]).toEqual([413, "payload_too_large"]);
      await tightApp.close();
    } finally {
      await tight.drop();
    }
  });

  it("lists jobs with actionable status and serves the report", async () => {
    const jobs = (await call(app, operator, "GET", "/jobs")).json().items;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]).toHaveProperty("status");
    const report = (await call(app, viewer, "GET", "/report")).json();
    expect(report).toMatchObject({ schema_version: 1, contains_synthetic: true });
    expect(report.summary.total).toBeGreaterThan(0);
  });
});

describe("server wiring", () => {
  it("serves the web UI with SPA fallback and keeps /api 404s as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-web-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title><div id=root></div>");
      const webApp = await buildApp(env.ctx, { webRoot: dir, logRequests: true });
      const home = await webApp.inject({ method: "GET", url: "/leases/anything" });
      expect(home.statusCode).toBe(200);
      expect(home.headers["content-type"]).toContain("text/html");
      expect(home.headers["content-security-policy"]).toContain("script-src 'self'");
      expect((await webApp.inject({ method: "GET", url: "/api/v1/missing" })).json().error.code).toBe("not_found");
      expect(env.logs.some((l) => l.includes("http.response"))).toBe(true);
      await webApp.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listens on the configured address and can run the worker in-process", async () => {
    const solo = await makeEnv();
    try {
      solo.ctx.settings.workerPollMs = 50;
      const server = await startServer(solo.ctx, { host: "127.0.0.1", port: 0, worker: true });
      expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${server.address}/api/v1/health/live`);
      expect((await res.json()) as unknown).toEqual({ status: "ok" });
      await server.close();
      const noWorker = await startServer(solo.ctx, { host: "127.0.0.1", port: 0 });
      await noWorker.close();
      expect((await runWorkerOnce(solo.ctx)).jobsProcessed).toBe(0);
      void ProviderRegistry;
    } finally {
      await solo.drop();
    }
  });
});
