import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterUnavailableError,
  adapterConfigFromEnv,
  checkEndpoint,
  classifyAddress,
  EndpointError,
  EventConsumer,
  FileStore,
  httpEventSource,
  majorVersion,
  MemoryStore,
  parseEnvelope,
  pollOnce,
} from "../../../src/adapters/index";

const event = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  event_id: "evt-1",
  source: "accesslease",
  resource_id: "lease-1",
  event_type: "lease.state_changed",
  occurred_at: "2026-01-01T00:00:00.000Z",
  revision: 1,
  evidence_ref: "evidence/lease-1/1",
  ...over,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "al-adapter-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("envelope validation", () => {
  it("accepts a v1 envelope and the optional correlation_id", () => {
    expect(parseEnvelope(event()).ok).toBe(true);
    const r = parseEnvelope(event({ correlation_id: "corr-1" }));
    expect(r.ok && r.event.correlation_id).toBe("corr-1");
  });

  it("rejects unsupported major versions, including a future v2 with a different shape", () => {
    for (const v of [2, "2", "2.1", 0, 3]) {
      const r = parseEnvelope({ schema_version: v, anything: "else" });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe("unsupported_version");
    }
    expect(parseEnvelope(event({ schema_version: "1.4" })).ok).toBe(false); // literal 1 only: minor strings are not v1 envelopes
  });

  it("reports missing version, non-objects and malformed fields without echoing values", () => {
    expect(parseEnvelope(null)).toMatchObject({ ok: false, reason: "not_an_object" });
    expect(parseEnvelope([event()])).toMatchObject({ ok: false, reason: "not_an_object" });
    const { schema_version: _unused, ...rest } = event();
    expect(parseEnvelope(rest)).toMatchObject({ ok: false, reason: "missing_version" });
    expect(parseEnvelope({ ...event(), schema_version: {} })).toMatchObject({ ok: false, reason: "unsupported_version" });
    const bad = parseEnvelope(event({ revision: -1 }));
    expect(bad).toMatchObject({ ok: false, reason: "invalid_envelope" });
    expect(parseEnvelope(event({ occurred_at: "yesterday" }))).toMatchObject({ ok: false, reason: "invalid_envelope" });
    expect(parseEnvelope(event({ unexpected: "field" }))).toMatchObject({ ok: false, reason: "invalid_envelope" });
    expect(parseEnvelope(event({ event_id: "" }))).toMatchObject({ ok: false, reason: "invalid_envelope" });
  });

  it("rejects events that carry a credential-shaped value", () => {
    for (const evidence of ["postgres://admin:planted-fake-pass@localhost/db", "password=planted-fake-pass", "Bearer planted-fake-token-1"]) {
      const r = parseEnvelope(event({ evidence_ref: evidence }));
      expect(r).toMatchObject({ ok: false, reason: "credential_in_event" });
      expect(JSON.stringify(r)).not.toContain("planted-fake");
    }
    expect(parseEnvelope(event({ nested: { list: ["token: planted-fake"] } }))).toMatchObject({ ok: false, reason: "credential_in_event" });
  });

  it("parses major versions", () => {
    expect(majorVersion(1)).toBe(1);
    expect(majorVersion("2.3.4")).toBe(2);
    expect(majorVersion("x")).toBeNull();
    expect(majorVersion(1.5)).toBeNull();
    expect(majorVersion(-1)).toBeNull();
    expect(majorVersion(undefined)).toBeNull();
  });
});

describe("event consumer", () => {
  it("is disabled by default and does nothing", () => {
    const c = new EventConsumer();
    expect(c.enabled).toBe(false);
    expect(c.ingest(event())).toMatchObject({ status: "rejected", reason: "adapter_disabled" });
    expect(c.resources()).toEqual([]);
  });

  it("dedupes by event_id and applies only strictly newer revisions", () => {
    const c = new EventConsumer({ enabled: true });
    expect(c.ingest(event())).toMatchObject({ status: "accepted", revision: 1 });
    expect(c.ingest(event())).toEqual({ status: "duplicate", event_id: "evt-1" });
    expect(c.ingest(event({ event_id: "evt-3", revision: 3, event_type: "lease.revocation_unconfirmed" }))).toMatchObject({ status: "accepted", revision: 3 });
    // an old event arriving late must not roll the view back
    const late = c.ingest(event({ event_id: "evt-2", revision: 2, event_type: "lease.revoked_verified" }));
    expect(late).toEqual({ status: "stale", event_id: "evt-2", resource_id: "lease-1", revision: 2, applied_revision: 3 });
    expect(c.lastEvent("lease-1")).toMatchObject({ revision: 3, event_type: "lease.revocation_unconfirmed", event_id: "evt-3" });
    // same revision, different event: not newer, not applied
    expect(c.ingest(event({ event_id: "evt-3b", revision: 3, event_type: "lease.revoked_verified" }))).toMatchObject({ status: "stale" });
    expect(c.lastEvent("lease-1")?.event_type).toBe("lease.revocation_unconfirmed");
  });

  it("keeps ordering and version metadata for applied and stale events", () => {
    const c = new EventConsumer({ enabled: true });
    c.ingest(event({ event_id: "a", revision: 5, occurred_at: "2026-01-01T00:05:00.000Z" }));
    c.ingest(event({ event_id: "b", revision: 4, occurred_at: "2026-01-01T00:04:00.000Z" }));
    const h = c.history();
    expect(h.map((x) => [x.event_id, x.revision, x.applied, x.schema_version])).toEqual([
      ["a", 5, true, 1],
      ["b", 4, false, 1],
    ]);
    expect(h[1]?.note).toContain("not newer");
    expect(c.lastEvent("lease-1")).toMatchObject({ schema_version: 1, occurred_at: "2026-01-01T00:05:00.000Z", evidence_ref: "evidence/lease-1/1" });
  });

  it("tracks resources independently and sorts them", () => {
    const c = new EventConsumer({ enabled: true });
    c.ingest(event({ event_id: "x", resource_id: "lease-b", correlation_id: "c1" }));
    c.ingest(event({ event_id: "y", resource_id: "lease-a" }));
    expect(c.resources().map((r) => r.resource_id)).toEqual(["lease-a", "lease-b"]);
    expect(c.lastEvent("lease-b")?.correlation_id).toBe("c1");
    expect(c.lastEvent("missing")).toBeUndefined();
  });

  it("bounds the dedupe set and history", () => {
    const c = new EventConsumer({ enabled: true, maxSeen: 2, maxHistory: 2 });
    for (let i = 1; i <= 4; i += 1) c.ingest(event({ event_id: `e${i}`, revision: i }));
    expect(c.history().length).toBe(2);
    // e1 fell out of the dedupe horizon; it is re-checked by revision and found stale
    expect(c.ingest(event({ event_id: "e1", revision: 1 }))).toMatchObject({ status: "stale" });
    expect(c.ingest(event({ event_id: "e4", revision: 4 }))).toEqual({ status: "duplicate", event_id: "e4" });
  });

  it("persists state across restarts through the file store with owner-only permissions", () => {
    const file = join(tmp(), "nested", "state.json");
    const first = new EventConsumer({ enabled: true, store: new FileStore(file) });
    first.ingest(event());
    first.setCursor("cursor-9");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = new EventConsumer({ enabled: true, store: new FileStore(file) });
    expect(second.ingest(event())).toEqual({ status: "duplicate", event_id: "evt-1" });
    expect(second.cursor).toBe("cursor-9");
    expect(second.lastEvent("lease-1")?.revision).toBe(1);
  });

  it("refuses a corrupt or malformed state file instead of starting empty", () => {
    const dir = tmp();
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{truncated");
    expect(() => new FileStore(corrupt).load()).toThrow(/unreadable or corrupt/);
    const odd = join(dir, "odd.json");
    writeFileSync(odd, JSON.stringify({ seen: "no" }));
    expect(() => new FileStore(odd).load()).toThrow(/unexpected shape/);
    writeFileSync(odd, "null");
    expect(() => new FileStore(odd).load()).toThrow(/unexpected shape/);
    expect(new FileStore(join(dir, "absent.json")).load().seen).toEqual([]);
    writeFileSync(odd, JSON.stringify({ seen: [], resources: {}, history: [] }));
    expect(new FileStore(odd).load().cursor).toBeNull();
  });

  it("never stores a raw credential: a credential-bearing event is rejected before storage", () => {
    const file = join(tmp(), "state.json");
    const c = new EventConsumer({ enabled: true, store: new FileStore(file) });
    expect(c.ingest(event({ evidence_ref: "password=planted-fake-pass" }))).toMatchObject({ status: "rejected", reason: "credential_in_event" });
    expect(c.history()).toEqual([]);
    c.setCursor(null);
    expect(readFileSync(file, "utf8")).not.toContain("planted-fake");
  });

  it("memory store returns copies", () => {
    const s = new MemoryStore();
    const a = s.load();
    a.seen.push("mutated");
    expect(s.load().seen).toEqual([]);
  });
});

describe("configuration", () => {
  it("is disabled by default, localhost only", () => {
    const c = adapterConfigFromEnv({});
    expect(c).toEqual({ enabled: false, baseUrl: null, stateFile: null, policy: { allowedHosts: ["localhost", "127.0.0.1"], allowPrivate: false } });
  });

  it("reads explicit settings", () => {
    const c = adapterConfigFromEnv({
      ACCESSLEASE_ADAPTER_ENABLED: "1",
      ACCESSLEASE_ADAPTER_BASE_URL: " http://localhost:8791 ",
      ACCESSLEASE_ADAPTER_STATE_FILE: "/data/adapter.json",
      ACCESSLEASE_ADAPTER_ALLOWED_HOSTS: "localhost, lease.internal.example",
      ACCESSLEASE_ADAPTER_ALLOW_PRIVATE: "true",
    });
    expect(c).toMatchObject({ enabled: true, baseUrl: "http://localhost:8791", stateFile: "/data/adapter.json", policy: { allowedHosts: ["localhost", "lease.internal.example"], allowPrivate: true } });
    expect(adapterConfigFromEnv({ ACCESSLEASE_ADAPTER_ENABLED: "0" }).enabled).toBe(false);
  });
});

describe("endpoint policy", () => {
  const policy = { allowedHosts: ["localhost", "lease.example.test"] };
  const resolveTo = (...addresses: string[]) => async () => addresses;

  it("classifies addresses", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("169.254.169.254")).toBe("link-local");
    expect(classifyAddress("fe80::1")).toBe("link-local");
    expect(classifyAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("::")).toBe("unspecified");
    expect(classifyAddress("10.1.2.3")).toBe("private");
    expect(classifyAddress("172.20.0.1")).toBe("private");
    expect(classifyAddress("192.168.1.1")).toBe("private");
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("fd00::1")).toBe("private");
    expect(classifyAddress("203.0.113.9")).toBe("public");
    expect(classifyAddress("2001:db8::1")).toBe("public");
    expect(classifyAddress("[::1]")).toBe("loopback");
  });

  it("accepts an allow-listed host that resolves to loopback or a public address", async () => {
    await expect(checkEndpoint("http://localhost:8791/api/v1/events", policy, resolveTo("127.0.0.1"))).resolves.toBeInstanceOf(URL);
    await expect(checkEndpoint("https://lease.example.test/", policy, resolveTo("203.0.113.9"))).resolves.toBeInstanceOf(URL);
    await expect(checkEndpoint("http://127.0.0.1:8791/", { allowedHosts: ["127.0.0.1"] }, resolveTo())).resolves.toBeInstanceOf(URL);
  });

  it("refuses bad schemes, embedded credentials, unlisted hosts and unparsable URLs", async () => {
    await expect(checkEndpoint("file:///etc/passwd", policy)).rejects.toThrow(EndpointError);
    await expect(checkEndpoint("http://user:pw@localhost/", policy)).rejects.toThrow(/credentials/);
    await expect(checkEndpoint("http://evil.example.test/", policy, resolveTo("203.0.113.9"))).rejects.toThrow(/allowlist/);
    await expect(checkEndpoint("not a url", policy)).rejects.toThrow(/valid URL/);
  });

  it("refuses allow-listed names that resolve to metadata, unspecified or (by default) private addresses", async () => {
    await expect(checkEndpoint("http://lease.example.test/", policy, resolveTo("169.254.169.254"))).rejects.toThrow(/link-local/);
    await expect(checkEndpoint("http://lease.example.test/", policy, resolveTo("203.0.113.9", "0.0.0.0"))).rejects.toThrow(/unspecified/);
    await expect(checkEndpoint("http://lease.example.test/", policy, resolveTo("10.0.0.5"))).rejects.toThrow(/private/);
    await expect(checkEndpoint("http://lease.example.test/", { ...policy, allowPrivate: true }, resolveTo("10.0.0.5"))).resolves.toBeInstanceOf(URL);
    await expect(checkEndpoint("http://lease.example.test/", policy, resolveTo())).rejects.toThrow(/did not resolve/);
  });
});

describe("pull poller", () => {
  const okFetch = (body: unknown, init: ResponseInit = {}) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init })) as unknown as typeof fetch;
  const source = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    httpEventSource({ baseUrl: "http://localhost:8791", policy: { allowedHosts: ["localhost"] }, resolve: async () => ["127.0.0.1"], fetchImpl, ...extra });

  it("ingests a page, reports every outcome and advances the cursor only after the page", async () => {
    const consumer = new EventConsumer({ enabled: true });
    const page = { items: [event(), event(), event({ event_id: "old", revision: 0 }), event({ event_id: "bad", schema_version: 9 }), event({ event_id: "ok2", resource_id: "lease-2" })], next_cursor: "c2" };
    const f = okFetch(page);
    const summary = await pollOnce(consumer, source(f));
    expect(summary).toEqual({ pulled: 5, accepted: 2, duplicates: 1, stale: 1, rejected: [{ reason: "unsupported_version", detail: expect.stringContaining("supported: 1") }], cursor: "c2" });
    const calledUrl = String((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]);
    expect(calledUrl).toBe("http://localhost:8791/api/v1/events");
    await pollOnce(consumer, source(f));
    expect(String((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]?.[0])).toBe("http://localhost:8791/api/v1/events?after=c2");
  });

  it("keeps the cursor when the source has nothing newer", async () => {
    const consumer = new EventConsumer({ enabled: true });
    consumer.setCursor("c5");
    const summary = await pollOnce(consumer, source(okFetch({ events: [], next_cursor: null })));
    expect(summary).toMatchObject({ pulled: 0, cursor: "c5" });
  });

  it("does nothing useful when disabled: every event is reported rejected", async () => {
    const consumer = new EventConsumer();
    const summary = await pollOnce(consumer, async () => ({ events: [event()], next_cursor: null }));
    expect(summary.rejected[0]?.reason).toBe("adapter_disabled");
  });

  it("fails explicitly when the source is unreachable, redirects, errors, is oversize or unreadable", async () => {
    const consumer = new EventConsumer({ enabled: true });
    const down = vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(pollOnce(consumer, source(down))).rejects.toThrow(AdapterUnavailableError);
    await expect(pollOnce(consumer, source(okFetch("", { status: 302, headers: { location: "http://evil.example.test/" } })))).rejects.toThrow(/redirect/);
    await expect(pollOnce(consumer, source(okFetch("{}", { status: 503 })))).rejects.toThrow(/HTTP 503/);
    await expect(pollOnce(consumer, source(okFetch({ items: [], pad: "x".repeat(50) }), { maxBytes: 10 }))).rejects.toThrow(/size limit/);
    await expect(pollOnce(consumer, source(okFetch("<html>")))).rejects.toThrow(/unreadable/);
    await expect(pollOnce(consumer, source(okFetch({ nothing: true })))).rejects.toThrow(/no event list/);
    expect(consumer.cursor).toBeNull();
  });

  it("refuses an endpoint that is not on the allowlist before sending any request", async () => {
    const f = okFetch({ items: [] });
    const bad = httpEventSource({ baseUrl: "http://other.example.test", policy: { allowedHosts: ["localhost"] }, fetchImpl: f, resolve: async () => ["203.0.113.9"] });
    await expect(bad(null)).rejects.toThrow(EndpointError);
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(0);
  });

  it("passes configured headers to the injected fetch with redirects set to manual", async () => {
    const f = okFetch({ items: [], next_cursor: null });
    await source(f, { headers: { "x-adapter-token": "placeholder" } })(null);
    const init = (f as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["x-adapter-token"]).toBe("placeholder");
    expect(init?.redirect).toBe("manual");
  });
});
