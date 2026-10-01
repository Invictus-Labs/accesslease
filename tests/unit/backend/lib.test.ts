import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextFromConfig, loadConfig, sameCluster } from "../../../src/config.js";
import { ProviderRegistry, ProviderUnavailableError, labelOf } from "../../../src/connectors/provider.js";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { SyntheticProvider } from "../../../src/connectors/synthetic.js";
import { fixedClock } from "../../../src/context.js";
import { ServerKey, hashPassword, safeEqual, verifyPassword } from "../../../src/crypto.js";
import { canonicalJson, contentHash } from "../../../src/domain/canonical.js";
import { LEASE_STATES } from "../../../src/domain/types.js";
import { TRANSITIONS, assertTransition, canTransition, InvalidTransitionError, isTerminal, isUnresolved, revocationStatusFor, warningFor } from "../../../src/domain/state-machine.js";
import { AppError, fail } from "../../../src/errors.js";
import { EgressDeniedError, checkEndpoint, guardedRequest, inCidr, isPrivateAddress, parseAllowlist } from "../../../src/lib/egress.js";
import { createLogger, memoryLogger, silentLogger } from "../../../src/lib/log.js";
import { REDACTED, auditMetadata, clearRegisteredSecrets, containsSecret, redactDeep, redactText, registerSecret } from "../../../src/lib/redact.js";
import { migrate, migrationStatus } from "../../../src/db/migrate.js";
import { openDatabase } from "../../../src/db/index.js";
import { freshDatabase } from "./helpers.js";

describe("provider call deadline (R-004)", () => {
  it("resolves fast calls, rejects silent ones with provider_timeout and clears its timer", async () => {
    const { withDeadline } = await import("../../../src/workers/deadline.js");
    await expect(withDeadline(1000, async () => "ok")).resolves.toBe("ok");
    await expect(withDeadline(30, () => new Promise<never>(() => undefined))).rejects.toMatchObject({ code: "provider_timeout", definite: false });
    await expect(withDeadline(1000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});

describe("canonical JSON", () => {
  it("sorts keys, omits undefined, encodes dates in UTC and is order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, undefined] } })).toBe('{"a":{"c":[3,null]},"b":1}');
    expect(canonicalJson(new Date("2026-01-01T00:00:00Z"))).toBe('"2026-01-01T00:00:00.000Z"');
    expect(contentHash({ x: 1, y: 2 })).toBe(contentHash({ y: 2, x: 1 }));
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(null)).toBe("null");
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(10n)).toThrow();
  });
});

describe("state machine", () => {
  it("allows exactly the PRD transitions", () => {
    const allowed = new Set(
      Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)),
    );
    expect([...allowed].sort()).toEqual(
      [
        "REQUESTED->APPROVED",
        "REQUESTED->REVOKING",
        "APPROVED->ISSUING",
        "APPROVED->REVOKING",
        "ISSUING->ACTIVE",
        "ISSUING->ISSUE_UNKNOWN",
        "ISSUING->REVOKING",
        "ACTIVE->REVOKING",
        "ISSUE_UNKNOWN->ACTIVE",
        "ISSUE_UNKNOWN->REVOKING",
        "ISSUE_UNKNOWN->ISSUE_UNKNOWN",
        "REVOKING->REVOKED_VERIFIED",
        "REVOKING->REVOCATION_UNCONFIRMED",
        "REVOCATION_UNCONFIRMED->REVOKED_VERIFIED",
        "REVOCATION_UNCONFIRMED->REVOCATION_UNCONFIRMED",
      ].sort(),
    );
    for (const from of LEASE_STATES) for (const to of LEASE_STATES) expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
    expect(() => assertTransition("ACTIVE", "REVOKED_VERIFIED")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("ACTIVE", "REVOKING")).not.toThrow();
  });

  it("never reports revoked/verified except for REVOKED_VERIFIED and always warns on unresolved states", () => {
    for (const state of LEASE_STATES) {
      expect(revocationStatusFor(state) === "verified").toBe(state === "REVOKED_VERIFIED");
      expect(isTerminal(state)).toBe(state === "REVOKED_VERIFIED");
      const warning = warningFor(state, "expired", new Date("2026-01-01T00:00:00Z"));
      if (isUnresolved(state) || state === "REVOKING") expect(warning).toBeTruthy();
      else expect(warning).toBeNull();
    }
    expect(warningFor("REVOCATION_UNCONFIRMED", "task_closed", null)).toContain("Revocation was requested");
    expect(warningFor("REVOCATION_UNCONFIRMED", "expired", null)).toContain("has expired");
  });
});

describe("redaction (AC-09)", () => {
  const planted = [
    "sk-live-FAKEFAKEFAKEFAKEFAKE1234",
    "AKIAFAKEFAKEFAKE1234",
    "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE12",
    "xoxb-1234567890-FAKEFAKEFAKE",
    "Bearer abcdef.ghijkl-mnopqr",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKESIGNATURE",
    "PLANTED_SECRET_TOKEN_9f3a1c",
    "CANARY-secret-7781",
    "MY_SERVICE_API_KEY_abc123",
    "-----BEGIN PRIVATE KEY-----\nMIIFAKE\n-----END PRIVATE KEY-----",
  ];
  it.each(planted)("masks %j inside free text", (token) => {
    const out = redactText(`please use ${token} for the task`);
    expect(out).not.toContain(token.split("\n")[1] ?? token);
    expect(out).toContain(REDACTED);
    expect(containsSecret(`x ${token}`)).toBe(true);
  });

  it("redacts the WHOLE value of an assignment, including &, ;, comma and quote characters (F-007)", () => {
    expect(redactText("slack password=Tr0ub4dor&3-example tail")).toBe(`slack password=${REDACTED} tail`);
    expect(redactText("secret=a;b,c'd\"e next")).toBe(`secret=${REDACTED} next`);
    expect(redactText('password="two words&more" after')).toBe(`password=${REDACTED} after`);
    expect(redactText("token='x y&z' after")).toBe(`token=${REDACTED} after`);
    for (const text of ["password=Tr0ub4dor&3-example", 'api_key: "ab&cd;ef"', "client_secret=ab&cd"]) expect(redactText(text)).not.toMatch(/Tr0ub|3-example|ab&|cd;|&cd/);
  });

  it("masks key=value assignments, URL userinfo and personal fields only when asked", () => {
    expect(redactText("password=hunter2 and api_key: abcd1234")).toBe(`password=${REDACTED} and api_key: ${REDACTED}`);
    expect(redactText('{"token": "abcdef"}')).toContain(REDACTED);
    expect(redactText("postgres://app:s3cret@localhost:5432/db")).toBe(`postgres://app:${REDACTED}@localhost:5432/db`);
    expect(redactText("mail me at person@example.test")).toContain("person@example.test");
    expect(redactText("mail me at person@example.test", { personal: true })).toContain("[REDACTED_EMAIL]");
    expect(redactText("plain text stays")).toBe("plain text stays");
  });

  it("masks registered exact secrets and per-call secrets", () => {
    registerSecret("this-is-an-issued-credential");
    registerSecret("short");
    expect(redactText("copy this-is-an-issued-credential now")).toBe(`copy ${REDACTED} now`);
    expect(redactText("short stays")).toBe("short stays");
    expect(redactText("also per-call-secret-value here", { secrets: ["per-call-secret-value"] })).toBe(`also ${REDACTED} here`);
    clearRegisteredSecrets();
    expect(redactText("this-is-an-issued-credential")).toBe("this-is-an-issued-credential");
  });

  it("redacts deep structures by key and by value; metadata allow-list drops secret keys and objects", () => {
    const out = redactDeep({ password: "x", nested: { Authorization: "Bearer abcdefghij", note: "AKIAFAKEFAKEFAKE1234" }, list: ["ok", "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE12"], flag: true, n: 3, date: new Date(0) }) as Record<string, any>;
    expect(out.password).toBe(REDACTED);
    expect(out.nested.Authorization).toBe(REDACTED);
    expect(out.nested.note).toBe(REDACTED);
    expect(out.list).toEqual(["ok", REDACTED]);
    expect(out.flag).toBe(true);
    expect(out.n).toBe(3);
    expect(out.date).toEqual(new Date(0));
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) deep = { a: deep };
    expect(JSON.stringify(redactDeep(deep))).toContain(REDACTED);
    expect(auditMetadata({ token: "x", from: "ACTIVE", n: 1, ok: true, nothing: null, obj: { a: 1 }, list: ["a", "b"], bad: [1], long: "x".repeat(500), secretNote: "dropped", note: "PLANTED_SECRET_TOKEN_1" })).toEqual({
      from: "ACTIVE",
      n: 1,
      ok: true,
      nothing: null,
      list: ["a", "b"],
      long: "x".repeat(300),
      note: REDACTED,
    });
  });

  it("the logger redacts every field and never throws", () => {
    const { log, lines } = memoryLogger();
    log({ level: "info", event: "test", detail: "token=abcdef123 person@example.test", authorization: "Bearer zzzzzzzzzz", nested: { cookie: "a=b" } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("abcdef123");
    expect(lines[0]).not.toContain("person@example.test");
    expect(lines[0]).not.toContain("zzzzzzzzzz");
    const written: string[] = [];
    createLogger((line) => written.push(line))({ level: "warn", event: "x" });
    expect(JSON.parse(written[0] as string)).toMatchObject({ level: "warn", event: "x" });
    silentLogger({ level: "info", event: "none" });
  });
});

describe("egress allowlist (redirects and DNS)", () => {
  const resolverFor = (map: Record<string, string[]>) => async (host: string) => {
    const found = map[host];
    if (!found) throw new Error("NXDOMAIN");
    return found;
  };

  it("parses and validates allowlist entries", () => {
    expect(parseAllowlist("Example.test, 10.0.0.0/8 127.0.0.1:5432,*.corp.test")).toEqual(["example.test", "10.0.0.0/8", "127.0.0.1:5432", "*.corp.test"]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("[::1]:5432")).toEqual(["[::1]:5432"]);
    for (const bad of ["*", "http://example.test", "bad_host!", "example.test/path", "10.0.0.0/99"]) expect(() => parseAllowlist(bad)).toThrow();
  });

  it("classifies private addresses and CIDR membership for IPv4, IPv6 and mapped addresses", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::1", "::7f00:1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.0.9", "172.20.0.1", "100.64.0.1", "::1", "fe80::1", "fd00::5", "::ffff:127.0.0.1", "0.0.0.0", "224.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(inCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(inCidr("::1", "::1/128")).toBe(true);
    expect(inCidr("::1", "127.0.0.0/8")).toBe(false);
    expect(inCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(inCidr("1.2.3.4", "1.2.3.4")).toBe(true);
  });

  it("denies hosts that are not allowlisted, private resolutions and DNS failures", async () => {
    const resolver = resolverFor({ "api.example.test": ["93.184.216.34"], "rebind.example.test": ["127.0.0.1"], "mixed.example.test": ["93.184.216.34", "10.0.0.5"], localhost: ["127.0.0.1", "::1"] });
    await expect(checkEndpoint({ host: "api.example.test", port: 443 }, ["api.example.test"], resolver)).resolves.toEqual(["93.184.216.34"]);
    await expect(checkEndpoint({ host: "api.example.test", port: 443 }, [], resolver)).rejects.toMatchObject({ reason: "not_allowlisted" });
    await expect(checkEndpoint({ host: "api.example.test", port: 8443 }, ["api.example.test:443"], resolver)).rejects.toMatchObject({ reason: "not_allowlisted" });
    await expect(checkEndpoint({ host: "api.example.test", port: 443 }, ["*.example.test"], resolver)).resolves.toHaveLength(1);
    await expect(checkEndpoint({ host: "example.test", port: 443 }, ["*.example.test"], resolverFor({ "example.test": ["93.184.216.34"] }))).rejects.toMatchObject({ reason: "not_allowlisted" });
    await expect(checkEndpoint({ host: "rebind.example.test", port: 443 }, ["rebind.example.test"], resolver)).rejects.toMatchObject({ reason: "private_address" });
    await expect(checkEndpoint({ host: "mixed.example.test", port: 443 }, ["mixed.example.test"], resolver)).rejects.toMatchObject({ reason: "private_address" });
    await expect(checkEndpoint({ host: "mixed.example.test", port: 443 }, ["mixed.example.test", "10.0.0.0/8"], resolver)).resolves.toHaveLength(2);
    await expect(checkEndpoint({ host: "nxdomain.test", port: 1 }, ["nxdomain.test"], resolver)).rejects.toMatchObject({ reason: "dns_failure" });
    await expect(checkEndpoint({ host: "empty.test", port: 1 }, ["empty.test"], resolverFor({ "empty.test": [] }))).rejects.toMatchObject({ reason: "dns_failure" });
    await expect(checkEndpoint({ host: "", port: 1 }, [], resolver)).rejects.toMatchObject({ reason: "bad_url" });
    // loopback only when explicitly allowed: literal localhost entry or an IP/CIDR entry
    await expect(checkEndpoint({ host: "localhost", port: 5432 }, ["localhost"], resolver)).resolves.toEqual(["127.0.0.1", "::1"]);
    await expect(checkEndpoint({ host: "127.0.0.1", port: 5432 }, [], resolver)).rejects.toMatchObject({ reason: "not_allowlisted" });
    await expect(checkEndpoint({ host: "127.0.0.1", port: 5432 }, ["127.0.0.1"], resolver)).resolves.toEqual(["127.0.0.1"]);
    await expect(checkEndpoint({ host: "127.0.0.1", port: 5432 }, ["127.0.0.0/8"], resolver)).resolves.toEqual(["127.0.0.1"]);
    await expect(checkEndpoint({ host: "127.0.0.1", port: 5432 }, ["127.0.0.1:9999"], resolver)).rejects.toMatchObject({ reason: "not_allowlisted" });
    await expect(checkEndpoint({ host: "[::1]", port: 5432 }, ["::1"], resolver)).resolves.toEqual(["::1"]);
    await expect(checkEndpoint({ host: "10.0.0.7", port: 5432 }, ["example.test"], resolver)).rejects.toMatchObject({ reason: "not_allowlisted" });
    expect(new EgressDeniedError("timeout", "x").name).toBe("EgressDeniedError");
  });

  describe("guardedRequest", () => {
    let server: http.Server;
    let base: string;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/ok") return void res.end("hello");
        if (req.url === "/to-evil") return void res.writeHead(302, { location: "http://evil.test:1/x" }).end();
        if (req.url === "/to-other-ip") return void res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as AddressInfo).port}/ok` }).end();
        if (req.url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
        if (req.url === "/rel") return void res.writeHead(301, { location: "/ok" }).end();
        if (req.url === "/big") return void res.end("x".repeat(5000));
        if (req.url === "/slow") return;
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const allow = ["127.0.0.1"];

    it("fetches allowlisted endpoints and follows same-host relative redirects", async () => {
      const res = await guardedRequest(`${base}/ok`, { allowlist: allow });
      expect([res.status, res.body.toString()]).toEqual([200, "hello"]);
      const rel = await guardedRequest(`${base}/rel`, { allowlist: allow });
      expect(rel.body.toString()).toBe("hello");
      expect(rel.finalUrl).toBe(`${base}/ok`);
      const head = await guardedRequest(`${base}/ok`, { allowlist: allow, method: "HEAD" });
      expect(head.status).toBe(200);
    });

    it("re-checks every redirect hop and refuses disallowed targets", async () => {
      await expect(guardedRequest(`${base}/to-evil`, { allowlist: allow, resolver: resolverFor({ "evil.test": ["93.184.216.34"] }) })).rejects.toMatchObject({ reason: "not_allowlisted" });
      await expect(guardedRequest(`${base}/to-other-ip`, { allowlist: allow })).rejects.toMatchObject({ reason: "not_allowlisted" });
      await expect(guardedRequest(`${base}/loop`, { allowlist: allow, maxRedirects: 2 })).rejects.toMatchObject({ reason: "too_many_redirects" });
    });

    it("refuses bad schemes, credentials, private resolutions, oversized and slow responses", async () => {
      await expect(guardedRequest("ftp://127.0.0.1/x", { allowlist: allow })).rejects.toMatchObject({ reason: "bad_url" });
      await expect(guardedRequest("not a url", { allowlist: allow })).rejects.toMatchObject({ reason: "bad_url" });
      await expect(guardedRequest(`http://user:pw@127.0.0.1:${new URL(base).port}/ok`, { allowlist: allow })).rejects.toMatchObject({ reason: "bad_url" });
      await expect(guardedRequest(`${base}/ok`, { allowlist: ["example.test"] })).rejects.toMatchObject({ reason: "not_allowlisted" });
      await expect(guardedRequest(`${base}/big`, { allowlist: allow, maxBytes: 100 })).rejects.toMatchObject({ reason: "response_too_large" });
      await expect(guardedRequest(`${base}/slow`, { allowlist: allow, timeoutMs: 100 })).rejects.toMatchObject({ reason: "timeout" });
      await expect(guardedRequest(`http://pinned.test:${new URL(base).port}/ok`, { allowlist: ["pinned.test", "127.0.0.1"], resolver: resolverFor({ "pinned.test": ["127.0.0.1"] }) })).resolves.toMatchObject({ status: 200 });
    });
  });
});

describe("crypto", () => {
  it("encrypts with authenticated purpose binding and derives deterministic secrets", () => {
    const key = ServerKey.generate();
    const token = key.encrypt("credential:1", "s3cret-value");
    expect(token).not.toContain("s3cret");
    expect(key.decrypt("credential:1", token)).toBe("s3cret-value");
    expect(() => key.decrypt("credential:2", token)).toThrow();
    const flipped = `${token.slice(0, -3)}${token.at(-3) === "A" ? "B" : "A"}${token.slice(-2)}`;
    expect(() => key.decrypt("credential:1", flipped)).toThrow();
    expect(() => key.decrypt("credential:1", "garbage")).toThrow("malformed ciphertext");
    expect(key.derive("credential", "lease-1")).toBe(key.derive("credential", "lease-1"));
    expect(key.derive("credential", "lease-1")).not.toBe(key.derive("credential", "lease-2"));
    expect(key.derive("credential", "lease-1", 40)).toHaveLength(40);
    expect(key.mac("csrf", "a")).not.toBe(key.mac("csrf", "b"));
    expect(() => new ServerKey(Buffer.alloc(5))).toThrow("32 bytes");
    expect(() => ServerKey.fromBase64(undefined)).toThrow("required");
    expect(ServerKey.fromBase64(Buffer.alloc(32, 1).toString("base64"))).toBeInstanceOf(ServerKey);
  });

  it("hashes and verifies passwords; safeEqual is length safe", async () => {
    const hash = await hashPassword("a-long-synthetic-password");
    expect(await verifyPassword("a-long-synthetic-password", hash)).toBe(true);
    expect(await verifyPassword("wrong-password-value", hash)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("configuration", () => {
  const base = { ACCESSLEASE_DATABASE_URL: "postgres://u:p@db.example.test:5432/accesslease", ACCESSLEASE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") };

  it("requires the database URL and secret key, and applies safe defaults", () => {
    expect(() => loadConfig({})).toThrow("missing required configuration: ACCESSLEASE_DATABASE_URL, ACCESSLEASE_SECRET_KEY");
    const config = loadConfig(base);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8791, provider: "synthetic", providerAdminUrl: null });
    expect(config.settings.initialPolicy).toEqual({ defaultTtlSeconds: 3600, maxTtlSeconds: 28800, minTtlSeconds: 60, retentionDays: 90 });
    expect(config.settings.secureCookies).toBe(true);
    expect(loadConfig({ ...base, ACCESSLEASE_PUBLIC_URL: "http://localhost:8791" }).settings.secureCookies).toBe(false);
  });

  it("validates numbers, URLs, providers and the separate-cluster rule", () => {
    expect(() => loadConfig({ ...base, ACCESSLEASE_PORT: "99999" })).toThrow("ACCESSLEASE_PORT");
    expect(() => loadConfig({ ...base, ACCESSLEASE_PUBLIC_URL: "ftp://x" })).toThrow("http or https");
    expect(() => loadConfig({ ...base, ACCESSLEASE_PROVIDER: "other" })).toThrow("ACCESSLEASE_PROVIDER");
    expect(() => loadConfig({ ...base, ACCESSLEASE_HOST: " " })).toThrow("must not be empty");
    expect(() => loadConfig({ ...base, ACCESSLEASE_PROVIDER: "postgres-role" })).toThrow("ACCESSLEASE_PROVIDER_ADMIN_URL is required");
    expect(() => loadConfig({ ...base, ACCESSLEASE_PROVIDER: "postgres-role", ACCESSLEASE_PROVIDER_ADMIN_URL: "mysql://x" })).toThrow("must start with postgres");
    expect(() => loadConfig({ ...base, ACCESSLEASE_PROVIDER: "postgres-role", ACCESSLEASE_PROVIDER_ADMIN_URL: "postgres://root@db.example.test:5432/other" })).toThrow("separate PostgreSQL cluster");
    const ok = loadConfig({ ...base, ACCESSLEASE_PROVIDER: "postgres-role", ACCESSLEASE_PROVIDER_ADMIN_URL: "postgres://root@sandbox.example.test:5432/postgres", ACCESSLEASE_PROVIDER_PUBLIC_HOST: "sandbox.example.test", ACCESSLEASE_EGRESS_ALLOWLIST: "sandbox.example.test" });
    expect(ok.providerAdminUrl).toContain("sandbox.example.test");
    expect(ok.providerPublicHost).toBe("sandbox.example.test");
    expect(ok.settings.egressAllowlist).toEqual(["sandbox.example.test"]);
    expect(loadConfig({ ...base, ACCESSLEASE_TTL_MAX_SECONDS: "7200", ACCESSLEASE_TTL_DEFAULT_SECONDS: "1800", ACCESSLEASE_RETENTION_DAYS: "30", ACCESSLEASE_TTL_MIN_SECONDS: "10", ACCESSLEASE_WORKER_POLL_MS: "100" }).settings).toMatchObject({
      initialPolicy: { defaultTtlSeconds: 1800, maxTtlSeconds: 7200, minTtlSeconds: 10, retentionDays: 30 },
      workerPollMs: 100,
    });
    expect(() => loadConfig({ ...base, ACCESSLEASE_TTL_MAX_SECONDS: "999999" })).toThrow("ACCESSLEASE_TTL_MAX_SECONDS");
    expect(loadConfig({ ...base, ACCESSLEASE_DATABASE_PASSWORD: "p@ss word" }).databaseUrl).toContain("p%40ss%20word");
  });

  it("treats loopback names as one machine when comparing clusters", () => {
    expect(sameCluster("postgres://a@localhost:5432/x", "postgres://b@127.0.0.1/y")).toBe(true);
    expect(sameCluster("postgres://a@localhost:5432/x", "postgres://b@127.0.0.1:5433/y")).toBe(false);
    expect(sameCluster("postgres://a@one.example.test/x", "postgres://a@two.example.test/x")).toBe(false);
  });

  it("builds a context with only the configured provider registered", async () => {
    const ctx = contextFromConfig(loadConfig(base));
    expect(ctx.providers.kinds()).toEqual(["synthetic"]);
    expect(ctx.providers.defaultKind).toBe("synthetic");
    await ctx.db.close();
  });
});

describe("providers: registry, errors and synthetic fault injection", () => {
  it("reports explicit disconnection for unknown providers and labels", async () => {
    const registry = new ProviderRegistry([]);
    expect(() => registry.require("postgres-role")).toThrow(ProviderUnavailableError);
    const synthetic = new SyntheticProvider();
    registry.register(synthetic);
    expect(registry.require("synthetic")).toBe(synthetic);
    expect(registry.get("postgres-role")).toBeUndefined();
    expect(labelOf(synthetic.capabilities())).toEqual({ kind: "synthetic", label: "SYNTHETIC", live: false });
    expect(synthetic.capabilities()).toMatchObject({ nativeTtl: true, deniedUseProbe: true, introspection: true, revocation: true, maxResidualAccessSeconds: 30 });
    await registry.closeAll();
  });

  it("models native TTL at login only, idempotent issue by lease, partial/stale faults and test hooks", async () => {
    const clock = fixedClock("2026-03-01T12:00:00Z");
    const p = new SyntheticProvider({ clock });
    const req = { leaseId: "lease-a", resource: "sandbox", attempt: 1, subject: "s", scopes: ["synthetic:sandbox:read"], expiresAt: new Date("2026-03-01T12:10:00Z"), credentialSecret: "secret-secret-1" };
    const first = await p.issue(req);
    const again = await p.issue({ ...req, attempt: 2 });
    expect([first.alreadyExisted, again.alreadyExisted, first.providerRef === again.providerRef, p.grantCount()]).toEqual([false, true, true, 1]);
    expect(p.openSession("lease-a", "wrong")).toBe(false);
    expect(p.openSession("lease-a", "secret-secret-1")).toBe(true);
    expect(await p.probeUse({ leaseId: "lease-a", resource: "sandbox", credentialSecret: "secret-secret-1" })).toBe("allowed");
    clock.advance(601);
    expect(await p.probeUse({ leaseId: "lease-a", resource: "sandbox", credentialSecret: "secret-secret-1" })).toBe("denied");
    const looked = await p.lookup({ leaseId: "lease-a", resource: "sandbox" });
    expect(looked).toMatchObject({ state: "present", loginAllowed: false, activeSessions: 1 });
    p.faults.next("revoke", "partial_revoke");
    const partial = await p.revoke({ leaseId: "lease-a", resource: "sandbox" });
    expect(partial.steps.some((s) => !s.ok)).toBe(true);
    expect((await p.lookup({ leaseId: "lease-a", resource: "sandbox" })).state).toBe("present");
    const done = await p.revoke({ leaseId: "lease-a", resource: "sandbox" });
    expect(done.sessionsTerminated).toBe(1);
    expect((await p.revoke({ leaseId: "lease-a", resource: "sandbox" })).steps[0]?.step).toBe("grant_absent");
    p.faults.next("lookup", "stale_introspection");
    expect((await p.lookup({ leaseId: "lease-a", resource: "sandbox" })).detail).toMatchObject({ stale: true });
    expect((await p.lookup({ leaseId: "lease-a", resource: "sandbox" })).state).toBe("absent");
    // fault queue helpers
    p.faults.always("ping", "outage");
    await expect(p.ping()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.ping()).rejects.toBeInstanceOf(ProviderUnavailableError);
    p.faults.clear("ping");
    await expect(p.ping()).resolves.toBeUndefined();
    p.faults.next("issue", "outage", 2);
    await expect(p.issue(req)).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(p.issue(req)).rejects.toMatchObject({ code: "provider_unavailable" });
    p.faults.next("issue", "reject");
    await expect(p.issue(req)).rejects.toMatchObject({ definite: true });
    await expect(p.issue({ ...req, resource: "BAD RESOURCE" })).rejects.toMatchObject({ code: "invalid_resource" });
    await expect(p.issue({ ...req, scopes: ["pg:public.t:select"] })).rejects.toMatchObject({ code: "invalid_scope" });
    p.faults.clear();
    expect(p.validateScope("synthetic:x:read")).toEqual({ ok: true });
    expect(p.validateScope("x")).toMatchObject({ ok: false });
    const pg = new PostgresRoleProvider({ adminUrl: "postgres://u:p@localhost:5432/postgres", allowlist: [] });
    for (const schema of ["pg_catalog", "information_schema", "pg_toast", "pg_temp_1"]) {
      for (const privilege of ["select", "update", "insert"]) expect(pg.validateScope(`pg:${schema}.pg_authid:${privilege}`), `${schema}:${privilege}`).toMatchObject({ ok: false, code: "scope_forbidden" });
    }
    expect(pg.validateScope("pg:app.pg_authid_copy:select")).toEqual({ ok: true });
    expect(pg.validateScope("pg:public.orders:select")).toEqual({ ok: true });
    expect(p.validateResource("ok")).toEqual({ ok: true });
    expect(p.validateResource("Not OK")).toMatchObject({ ok: false });
    p.seedGrant(req);
    expect(p.hasGrant("lease-a")).toBe(true);
    expect(p.sessionCount("missing")).toBe(0);
    for (const op of ["lookup", "revoke", "probe"] as const) {
      p.faults.next(op, "timeout");
    }
    await expect(p.lookup({ leaseId: "lease-a", resource: "sandbox" })).rejects.toMatchObject({ code: "provider_timeout" });
    await expect(p.revoke({ leaseId: "lease-a", resource: "sandbox" })).rejects.toMatchObject({ code: "provider_timeout" });
    expect(await p.probeUse({ leaseId: "lease-a", resource: "sandbox", credentialSecret: "secret-secret-1" })).toBe("unknown");
  });

  it("AppError helpers carry the frozen status table", () => {
    const error = fail("rate_limited", "slow down", { "retry-after": "3" });
    expect(error).toBeInstanceOf(AppError);
    expect([error.status, error.code, error.headers["retry-after"]]).toEqual([429, "rate_limited", "3"]);
  });
});

describe("migrations", () => {
  it("apply once, detect missing/modified/unknown migrations and stop readiness", async () => {
    const fresh = await freshDatabase("al_mig");
    try {
      expect(await migrationStatus(fresh.db)).toMatchObject({ ok: false, problem: "schema_migrations table is missing" });
      const first = await migrate(fresh.db);
      expect(first.applied).toEqual(["001_initial.sql"]);
      expect((await migrate(fresh.db)).applied).toEqual([]);
      expect(await migrationStatus(fresh.db)).toMatchObject({ ok: true, pending: [], problem: null });
      await fresh.db.query("UPDATE schema_migrations SET checksum = 'tampered'");
      expect(await migrationStatus(fresh.db)).toMatchObject({ ok: false, problem: expect.stringContaining("modified") });
      await expect(migrate(fresh.db)).rejects.toThrow("was modified");
      await fresh.db.query("DELETE FROM schema_migrations");
      await fresh.db.query("INSERT INTO schema_migrations VALUES ('999_future.sql', 'x', now())");
      expect(await migrationStatus(fresh.db)).toMatchObject({ ok: false, problem: expect.stringContaining("unknown to this build") });
      await expect(migrate(fresh.db)).rejects.toThrow("unknown to this build");
    } finally {
      await fresh.drop();
    }
  });

  it("a failing migration stops with a diagnostic and leaves readiness false", async () => {
    const fresh = await freshDatabase("al_mig");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "al-mig-"));
    try {
      writeFileSync(join(dir, "001_initial.sql"), "CREATE TABLE ok_table (id int);");
      writeFileSync(join(dir, "002_broken.sql"), "CREATE TABLE half (id int); SELECT * FROM does_not_exist;");
      await expect(migrate(fresh.db, dir)).rejects.toThrow("migration 002_broken.sql failed");
      expect(await migrationStatus(fresh.db, dir)).toMatchObject({ ok: false, pending: ["002_broken.sql"] });
      const half = await fresh.db.query("SELECT to_regclass('half') AS t");
      expect((half.rows[0] as { t: string | null }).t).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("rejects non-PostgreSQL URLs and invalid schema names", () => {
    expect(() => openDatabase("mysql://x")).toThrow("must start with postgres");
    expect(() => openDatabase("postgres://x@localhost/db", { schema: "Bad-Schema" })).toThrow("invalid schema name");
  });
});
