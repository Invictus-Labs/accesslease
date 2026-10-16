import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterUnavailableError, checkEndpoint, classifyAddress, EndpointError, httpEventSource, resolveEndpoint } from "../../../src/adapters/index";
import { embeddedIPv4, ipv6Groups } from "../../../src/adapters/endpoint";

describe("F-010: embedded IPv4 addresses are classified by the IPv4 they carry", () => {
  const cases: Array<[string, ReturnType<typeof classifyAddress>]> = [
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:a9fe:a9fe", "link-local"],
    ["0:0:0:0:0:ffff:a9fe:a9fe", "link-local"],
    ["0000:0000:0000:0000:0000:ffff:a9fe:a9fe", "link-local"],
    ["::FFFF:A9FE:A9FE", "link-local"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:a00:1", "private"],
    ["::ffff:c0a8:101", "private"],
    ["::ffff:0:0", "unspecified"],
    ["::a9fe:a9fe", "link-local"],
    ["::7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::808:808", "public"],
    ["::ffff:808:808", "public"],
    ["::", "unspecified"],
    ["0:0:0:0:0:0:0:0", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["[::1]", "loopback"],
    ["fe80::1%eth0", "link-local"],
    ["fd00::1", "private"],
    ["2001:db8::1", "public"],
    ["2606:4700::1111", "public"],
  ];
  it.each(cases)("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("parses IPv6 groups and rejects non-IPv6 text", () => {
    expect(ipv6Groups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(ipv6Groups("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ipv6Groups("1.2.3.4")).toBeNull();
    expect(ipv6Groups("nonsense")).toBeNull();
    expect(embeddedIPv4("2001:db8::1")).toBeNull();
    expect(embeddedIPv4("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIPv4("1.2.3.4")).toBeNull();
  });

  it("refuses an allow-listed name that resolves to a hex-mapped metadata or private address", async () => {
    const policy = { allowedHosts: ["mapped.example.test"] };
    const to = (...a: string[]) => async () => a;
    await expect(checkEndpoint("http://mapped.example.test/", policy, to("::ffff:a9fe:a9fe"))).rejects.toThrow(/link-local/);
    await expect(checkEndpoint("http://mapped.example.test/", policy, to("0:0:0:0:0:ffff:a9fe:a9fe"))).rejects.toThrow(/link-local/);
    await expect(checkEndpoint("http://mapped.example.test/", policy, to("::ffff:a00:1"))).rejects.toThrow(/private/);
    await expect(checkEndpoint("http://mapped.example.test/", policy, to("::ffff:7f00:1"))).resolves.toBeInstanceOf(URL);
    await expect(checkEndpoint("http://mapped.example.test/", policy, to("::ffff:808:808"))).resolves.toBeInstanceOf(URL);
  });
});

describe("F-011: the connection is pinned to the validated address", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });
  const serve = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as { port: number }).port;
  };
  const json = (body: unknown): http.RequestListener => (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  it("returns the validated addresses from resolveEndpoint", async () => {
    const r = await resolveEndpoint("http://pinned.example.test:81/x", { allowedHosts: ["pinned.example.test"] }, async () => ["127.0.0.1"]);
    expect(r.addresses).toEqual(["127.0.0.1"]);
    expect(r.url.port).toBe("81");
    await expect(resolveEndpoint("http://pinned.example.test/", { allowedHosts: ["pinned.example.test"] }, async () => [])).rejects.toThrow(EndpointError);
  });

  it("connects to the validated address and never resolves the name again", async () => {
    const seen: Array<{ host?: string; header?: string }> = [];
    const port = await serve((req, res) => {
      seen.push({ host: req.headers.host, header: String(req.headers["x-adapter-token"]) });
      json({ items: [], next_cursor: null })(req, res);
    });
    // this name does not exist in DNS: a second, system resolution would fail, so success proves pinning
    const source = httpEventSource({ baseUrl: `http://pinned.example.test:${port}`, policy: { allowedHosts: ["pinned.example.test"] }, resolve: async () => ["127.0.0.1"], headers: { "x-adapter-token": "placeholder" } });
    await expect(source("5")).resolves.toEqual({ events: [], next_cursor: null });
    expect(seen[0]).toEqual({ host: `pinned.example.test:${port}`, header: "placeholder" });
  });

  it("connects to the address the check returned even when a rebinding answer would differ", async () => {
    let calls = 0;
    const port = await serve(json({ items: [], next_cursor: null }));
    // first (and only) resolution returns loopback; a later one would return the metadata address
    const resolve = async () => (calls++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]);
    const source = httpEventSource({ baseUrl: `http://rebind.example.test:${port}`, policy: { allowedHosts: ["rebind.example.test"] }, resolve });
    await expect(source(null)).resolves.toMatchObject({ next_cursor: null });
    expect(calls).toBe(1);
  });

  it("refuses redirects, errors, oversize and unreadable bodies, slow servers and unreachable ports", async () => {
    const policy = { allowedHosts: ["pinned.example.test"] };
    const resolve = async () => ["127.0.0.1"];
    const at = (port: number, extra = {}) => httpEventSource({ baseUrl: `http://pinned.example.test:${port}`, policy, resolve, ...extra });
    const redirect = await serve((_q, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/");
      res.end();
    });
    await expect(at(redirect)(null)).rejects.toThrow(/redirect/);
    const broken = await serve((_q, res) => {
      res.statusCode = 503;
      res.end("{}");
    });
    await expect(at(broken)(null)).rejects.toThrow(/HTTP 503/);
    const big = await serve((_q, res) => res.end(JSON.stringify({ items: [], pad: "x".repeat(5000) })));
    await expect(at(big, { maxBytes: 100 })(null)).rejects.toThrow(/size limit/);
    const junk = await serve((_q, res) => res.end("<html>"));
    await expect(at(junk)(null)).rejects.toThrow(/unreadable/);
    const slow = await serve(() => undefined);
    await expect(at(slow, { timeoutMs: 100 })(null)).rejects.toThrow(AdapterUnavailableError);
    const closed = await serve(json({}));
    await new Promise<void>((r) => servers.pop()?.close(() => r()));
    await expect(at(closed)(null)).rejects.toThrow(/unreachable/);
  });
});
