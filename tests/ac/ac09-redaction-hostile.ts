import { randomBytes } from "node:crypto";
import pg from "pg";
import { reportModelFromData } from "../../src/report/from-data.js";
import { renderReport } from "../../src/report/render.js";
import { cliPrincipal, getReportData } from "../../src/services/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { isoPlus, waitFor } from "../helpers/clock.js";
import { HOSTILE_HTML, HOSTILE_TEXT, deepJson, oversizeString } from "../helpers/hostile.js";
import { PLANTED_VALUES, leakedSecrets, plantedCarrier, plantedPieces } from "../helpers/secrets.js";
import { providerAdminUrl, withDatabase, freshProviderTarget, type ProviderTarget } from "../helpers/db.js";
import { pauseProvider, unpauseProvider } from "../helpers/docker.js";
import { tableFingerprint, sql } from "../helpers/oracle.js";

/**
 * AC-09: size and schema are validated before processing; planted secrets never appear in logs or exported reports; malicious
 * HTML renders as text. The corpus checked is everything observable: logs, every API response, evidence bundle, report data and the
 * database itself.
 */
export function redactionAndHostileInput(): void {
  let h: Harness;
  let ws: TestWorkspace;
  let target: ProviderTarget;
  let resource: string;
  let adminPassword: string;
  const dynamicSecrets: string[] = [];
  const state = ["leases", "approvals", "provider_grants", "revocation_attempts", "audit_events", "jobs", "events"];

  beforeAll(async () => {
    target = await freshProviderTarget();
    resource = target.database;
    // The provider is reached through a dedicated superuser whose password is itself a secret AccessLease must never leak.
    adminPassword = randomBytes(18).toString("hex");
    const root = new pg.Client({ connectionString: providerAdminUrl() });
    await root.connect();
    await root.query(`CREATE ROLE ${target.rolePrefix}svc SUPERUSER LOGIN PASSWORD '${adminPassword}'`);
    await root.end();
    const url = new URL(withDatabase(providerAdminUrl(), "postgres"));
    url.username = `${target.rolePrefix}svc`;
    url.password = adminPassword;
    const svcTarget: ProviderTarget = { ...target, adminUrl: withDatabase(url.toString(), target.database) };
    dynamicSecrets.push(adminPassword);
    h = await createHarness({ provider: "postgres-role", fixedClock: false, target: svcTarget, settings: { retryBaseSeconds: 1, retryCapSeconds: 2 } });
    ws = await h.workspace("ac09");
  });
  afterAll(async () => {
    unpauseProvider();
    await h.close();
    await h.database.drop();
    await target.drop();
  });

  /** Everything an outsider could read: logs, all captured API responses, and every text value in the database. */
  async function corpus(): Promise<string> {
    const parts = [h.logLines.join("\n"), h.captured.join("\n")];
    const tables = await sql(h.database.url, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    for (const { tablename } of tables) parts.push(JSON.stringify(await sql(h.database.url, `SELECT t::text AS row FROM "${tablename}" t`)));
    return parts.join("\n");
  }

  it("planted secrets in free-text request fields never reach logs, API responses, evidence exports, report data or the database", async () => {
    const created = await h.client.post(ws.operator.session, "/leases", {
      task_ref: plantedPieces("task")[0],
      subject_ref: `contractor@example.invalid ${plantedPieces("subject")[1]}`,
      resource_ref: resource,
      scopes: ["pg:app.records:select"],
      expires_at: isoPlus(new Date(), 900),
    });
    expect(created.status).toBe(201);
    expect(leakedSecrets(created.raw, dynamicSecrets), "the create response").toEqual([]);
    for (const piece of [plantedPieces("extra-a")[2], plantedPieces("extra-b")[3]]) {
      const more = await h.client.post(ws.operator.session, "/leases", { task_ref: piece, subject_ref: "s@example.invalid", resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), 900) });
      expect(more.status).toBe(201);
      expect(leakedSecrets(more.raw, dynamicSecrets), "a create response").toEqual([]);
    }
    const id = created.body.id as string;
    await h.client.post(ws.operator.session, `/leases/${id}/approve`, { plan_hash: created.body.plan_hash });
    await waitFor("ACTIVE", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, id)).state === "active";
    }, 30_000, 200);
    const delivery = await h.client.post(ws.operator.session, `/leases/${id}/credential`);
    const secret = delivery.body.credential.secret as string;
    dynamicSecrets.push(secret);
    // The one-time delivery response is the single place the secret is allowed to appear; everything else is checked.
    h.captured.splice(h.captured.length - 2, 2);

    // Provoke provider errors with a real outage so raw driver messages exist to leak.
    pauseProvider();
    try {
      await h.client.post(ws.operator.session, `/leases/${id}/revoke`, { reason: plantedPieces("reason")[2] });
      await h.worker();
    } finally {
      unpauseProvider();
    }
    await waitFor("verified", async () => {
      await h.worker();
      return (await getLease(h, ws.operator.session, id)).state === "revoked_verified";
    }, 60_000, 500);

    for (const path of [`/leases/${id}`, `/leases/${id}/evidence`, "/leases", "/report", "/events?after=0&limit=100", "/jobs", "/policy", "/provider"]) {
      const res = await h.client.get(ws.operator.session, path);
      expect(res.status, path).toBe(200);
    }
    const exported = await h.client.get(ws.operator.session, "/evidence/export");
    expect(exported.status).toBe(200);
    expect(leakedSecrets(exported.raw, dynamicSecrets), "the evidence bundle").toEqual([]);
    const all = await corpus();
    expect(leakedSecrets(all, dynamicSecrets), "logs + responses + database").toEqual([]);
    expect(all).toContain("[REDACTED]");
    // The audit of intake is still useful: the lease exists with redacted references.
    const detail = await getLease(h, ws.operator.session, id);
    expect(detail.task_ref).toContain("[REDACTED]");
    expect(PLANTED_VALUES.some((v) => detail.task_ref.includes(v))).toBe(false);
  });

  it("login failures, malformed requests and provider errors never echo credentials, cookies or connection strings", async () => {
    const bad = await h.client.call(null, "POST", "/auth/login", { email: ws.operator.email, password: plantedCarrier("pw") });
    expect(bad.status).toBe(401);
    const malformed = await h.client.post(ws.operator.session, "/leases", undefined, { rawBody: `{"task_ref": ${plantedCarrier("broken")}`, contentType: "application/json" });
    expect([400, 422]).toContain(malformed.status);
    pauseProvider();
    let providerRes;
    try {
      providerRes = await h.client.get(ws.operator.session, "/provider");
    } finally {
      unpauseProvider();
    }
    expect(JSON.stringify(providerRes.body)).not.toMatch(/postgres(ql)?:\/\//);
    const all = await corpus();
    expect(leakedSecrets(all, dynamicSecrets)).toEqual([]);
    expect(all).not.toContain(adminPassword);
    expect(h.logLines.join("\n")).not.toMatch(/authorization|set-cookie|accesslease_session=[A-Za-z0-9]/i);
  });

  it("rejects oversize and schema-invalid input before any processing: nothing is stored and no provider is contacted", async () => {
    const before = await tableFingerprint(h.database.url, state);
    const ok = { task_ref: "TASK-SIZE", subject_ref: "s@example.invalid", resource_ref: resource, scopes: ["pg:app.records:select"] };
    const cases: { name: string; call: () => Promise<{ status: number }>; statuses: number[] }[] = [
      { name: "body over 64 KiB", statuses: [413], call: () => h.client.post(ws.operator.session, "/leases", { ...ok, task_ref: oversizeString(70 * 1024) }) },
      { name: "ref over the length limit", statuses: [422], call: () => h.client.post(ws.operator.session, "/leases", { ...ok, task_ref: oversizeString(5000) }) },
      { name: "too many scopes", statuses: [422], call: () => h.client.post(ws.operator.session, "/leases", { ...ok, scopes: Array.from({ length: 200 }, (_, i) => `pg:app.records${i}:select`) }) },
      { name: "NUL character", statuses: [400, 422], call: () => h.client.post(ws.operator.session, "/leases", { ...ok, task_ref: "bad\u0000ref" }) },
      { name: "unknown member", statuses: [422], call: () => h.client.post(ws.operator.session, "/leases", { ...ok, extra: 1 }) },
      { name: "wrong type", statuses: [422], call: () => h.client.post(ws.operator.session, "/leases", { ...ok, scopes: { a: 1 } }) },
      { name: "deeply nested JSON", statuses: [400, 413, 422], call: () => h.client.post(ws.operator.session, "/leases", undefined, { rawBody: deepJson(50_000) }) },
      { name: "wrong content type", statuses: [400, 415, 422], call: () => h.client.post(ws.operator.session, "/leases", undefined, { rawBody: JSON.stringify(ok), contentType: "text/plain" }) },
      { name: "empty body", statuses: [400, 422], call: () => h.client.post(ws.operator.session, "/leases", undefined, { rawBody: "" }) },
    ];
    for (const c of cases) {
      const res = await c.call();
      expect(c.statuses, `${c.name} -> ${res.status}`).toContain(res.status);
    }
    expect(await tableFingerprint(h.database.url, state)).toEqual(before);
  });

  it("an evidence import over the 25 MB metadata limit is refused with 413 before parsing, and a schema-invalid bundle with 422 before any write", async () => {
    const before = await tableFingerprint(h.database.url, [...state, "evidence_imports", "imported_leases"]);
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x20);
    huge.write('{"schema_version":1}', 0);
    const tooBig = await h.client.post(ws.admin.session, "/evidence/import", undefined, { rawBody: huge });
    expect(tooBig.status).toBe(413);
    const invalid = await h.client.post(ws.admin.session, "/evidence/import", { schema_version: 1, kind: "accesslease.evidence-bundle", files: "not-an-object" });
    expect(invalid.status).toBe(422);
    expect(await tableFingerprint(h.database.url, [...state, "evidence_imports", "imported_leases"])).toEqual(before);
  });

  it("malicious HTML in every user-controlled field is returned and stored as inert text", async () => {
    const created = await h.client.post(ws.operator.session, "/leases", { task_ref: HOSTILE_HTML[0], subject_ref: `${HOSTILE_HTML[1]}@example.invalid`, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), 900) });
    expect(created.status).toBe(201);
    const detail = await h.client.get(ws.viewer.session, `/leases/${created.body.id}`);
    expect(detail.headers["content-type"]).toMatch(/^application\/json/);
    expect(detail.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(detail.headers["content-security-policy"] ?? "")).toMatch(/default-src|script-src/);
    expect(detail.body.task_ref).toContain("<script>");
    // The server never produces HTML for user data: the same text comes back byte-for-byte as JSON data.
    const hostileRaw = JSON.stringify({ task_ref: detail.body.task_ref });
    expect(detail.raw).toContain(hostileRaw.slice(1, -1));
    for (const html of HOSTILE_HTML) expect(typeof html).toBe("string");
  });

  it("the static HTML report built from live data shows hostile markup and planted secrets as inert, redacted text", async () => {
    await h.client.post(ws.operator.session, "/leases", { task_ref: HOSTILE_HTML[4], subject_ref: `${HOSTILE_HTML[2]}@example.invalid`, resource_ref: resource, scopes: ["pg:app.records:select"], expires_at: isoPlus(new Date(), 900) });
    const principal = await cliPrincipal(h.ctx, "ac09");
    const html = renderReport(reportModelFromData(await getReportData(h.ctx, principal)));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<svg[^>]*onload/i);
    expect(html).toContain("&lt;iframe srcdoc=");
    expect(html).toContain("&lt;script&gt;window.__al_xss = 1&lt;/script&gt;");
    expect(leakedSecrets(html, dynamicSecrets)).toEqual([]);
  });
}
