import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressDeniedError, checkEndpoint, guardedRequest, inCidr, isPrivateAddress, parseAllowlist, type Resolver } from "../../src/lib/egress.js";

/**
 * Independent black-box tests of the outbound allowlist (PRD "Security and resource limits": endpoints are admin-configured and checked
 * against an allowlist including redirects and DNS resolution; no private-address surprises). Pure and offline: only loopback sockets.
 */
const resolverFor = (map: Record<string, string[]>): Resolver => async (host) => {
  const found = map[host];
  if (!found) throw new Error("NXDOMAIN");
  return found;
};

const denied = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressDeniedError);
    return (error as EgressDeniedError).reason;
  }
  throw new Error("expected the endpoint to be denied");
};

describe("private address classification", () => {
  const privateAddresses = ["127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"];
  const publicAddresses = ["192.0.2.1", "198.51.100.7", "203.0.113.9", "2001:db8::1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "11.0.0.1"];

  it.each(privateAddresses)("%s is private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
  it.each(publicAddresses)("%s is not private", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("IPv4-mapped IPv6 addresses written in hexadecimal are judged by the embedded IPv4 address", () => {
    // ::ffff:7f00:1 IS 127.0.0.1 on a dual-stack socket; every spelling of a private mapped address must be private.
    expect(isPrivateAddress("::ffff:7f00:1"), "::ffff:7f00:1 (127.0.0.1)").toBe(true);
    expect(isPrivateAddress("::ffff:a00:1"), "::ffff:a00:1 (10.0.0.1)").toBe(true);
    expect(isPrivateAddress("::ffff:c0a8:1"), "::ffff:c0a8:1 (192.168.0.1)").toBe(true);
    expect(isPrivateAddress("::ffff:a9fe:a9fe"), "::ffff:a9fe:a9fe (169.254.169.254)").toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:ffff:7f00:1"), "fully expanded mapped loopback").toBe(true);
  });

  it("CIDR membership is exact at the boundaries", () => {
    expect(inCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    expect(inCidr("11.0.0.0", "10.0.0.0/8")).toBe(false);
    expect(inCidr("192.0.2.1", "192.0.2.0/24")).toBe(true);
    expect(inCidr("192.0.3.0", "192.0.2.0/24")).toBe(false);
    expect(inCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(inCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
  });
});

describe("allowlist parsing", () => {
  it("accepts host names, ports, wildcards, IPs and CIDRs and rejects everything that could mean 'allow all'", () => {
    expect(parseAllowlist("example.test, db.example.test:5432 *.example.test 192.0.2.10 192.0.2.0/24 [2001:db8::1]:5432")).toHaveLength(6);
    for (const bad of ["*", "http://example.test", "example.test/path", "-bad.test", "0.0.0.0/0x"]) expect(() => parseAllowlist(bad), bad).toThrow();
  });
});

describe("endpoint checks", () => {
  const dns = resolverFor({
    "db.example.test": ["192.0.2.10"],
    "mixed.example.test": ["192.0.2.10", "10.0.0.5"],
    "rebind.example.test": ["127.0.0.1"],
    "mapped.example.test": ["::ffff:7f00:1"],
    "evilexample.test": ["192.0.2.66"],
  });

  it("allows an allowlisted name that resolves to a public address and returns the validated addresses to connect to", async () => {
    expect(await checkEndpoint({ host: "db.example.test", port: 5432 }, ["db.example.test"], dns)).toEqual(["192.0.2.10"]);
  });

  it("refuses names that are not on the list, including look-alike names and the bare domain of a wildcard", async () => {
    expect(await denied(checkEndpoint({ host: "db.example.test", port: 5432 }, ["other.example.test"], dns))).toBe("not_allowlisted");
    expect(await denied(checkEndpoint({ host: "evilexample.test", port: 5432 }, ["*.example.test"], dns))).toBe("not_allowlisted");
    expect(await denied(checkEndpoint({ host: "example.test", port: 5432 }, ["*.example.test"], resolverFor({ "example.test": ["192.0.2.1"] })))).toBe("not_allowlisted");
    expect(await checkEndpoint({ host: "db.example.test", port: 5432 }, ["*.example.test"], dns)).toEqual(["192.0.2.10"]);
  });

  it("is case-insensitive and honors a port-specific entry", async () => {
    expect(await checkEndpoint({ host: "DB.Example.Test", port: 5432 }, ["db.example.test:5432"], dns)).toEqual(["192.0.2.10"]);
    expect(await denied(checkEndpoint({ host: "db.example.test", port: 5433 }, ["db.example.test:5432"], dns))).toBe("not_allowlisted");
  });

  it("refuses an allowlisted name that resolves (even partly) to a private address", async () => {
    expect(await denied(checkEndpoint({ host: "rebind.example.test", port: 80 }, ["rebind.example.test"], dns))).toBe("private_address");
    expect(await denied(checkEndpoint({ host: "mixed.example.test", port: 80 }, ["mixed.example.test"], dns))).toBe("private_address");
  });

  it("refuses an allowlisted name that resolves to an IPv4-mapped IPv6 spelling of a private address", async () => {
    expect(await denied(checkEndpoint({ host: "mapped.example.test", port: 80 }, ["mapped.example.test"], dns))).toBe("private_address");
  });

  it("admits a private address only when an IP or CIDR entry names it explicitly, and the literal localhost only by name", async () => {
    expect(await checkEndpoint({ host: "127.0.0.1", port: 5432 }, ["127.0.0.1"], dns)).toEqual(["127.0.0.1"]);
    expect(await checkEndpoint({ host: "10.1.2.3", port: 5432 }, ["10.0.0.0/8"], dns)).toEqual(["10.1.2.3"]);
    expect(await denied(checkEndpoint({ host: "10.1.2.3", port: 5432 }, ["192.168.0.0/16"], dns))).toBe("not_allowlisted");
    expect(await checkEndpoint({ host: "localhost", port: 5432 }, ["localhost"], resolverFor({ localhost: ["127.0.0.1"] }))).toEqual(["127.0.0.1"]);
    expect(await denied(checkEndpoint({ host: "localhost", port: 5432 }, ["192.0.2.0/24"], resolverFor({ localhost: ["127.0.0.1"] })))).toBe("not_allowlisted");
  });

  it("an empty allowlist denies every endpoint, and a failed or empty DNS answer is a denial, not an allow", async () => {
    expect(await denied(checkEndpoint({ host: "db.example.test", port: 5432 }, [], dns))).toBe("not_allowlisted");
    expect(await denied(checkEndpoint({ host: "nxdomain.example.test", port: 5432 }, ["nxdomain.example.test"], dns))).toBe("dns_failure");
    expect(await denied(checkEndpoint({ host: "empty.example.test", port: 5432 }, ["empty.example.test"], resolverFor({ "empty.example.test": [] })))).toBe("dns_failure");
  });
});

describe("guarded HTTP requests (redirects, pinning, limits)", () => {
  let server: Server;
  let base: string;
  let port: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/ok") return void res.end("fine");
      if (req.url === "/to-private") return void res.writeHead(302, { location: "http://10.0.0.1/secret" }).end();
      if (req.url === "/to-other-host") return void res.writeHead(302, { location: "http://elsewhere.example.test:1/x" }).end();
      if (req.url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/to-ok") return void res.writeHead(302, { location: "/ok" }).end();
      if (req.url === "/big") return void res.end(Buffer.alloc(200_000, 0x61));
      if (req.url === "/slow") return; // never answers
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const allow = ["127.0.0.1"];

  it("fetches an allowlisted loopback endpoint, follows an in-policy redirect and reports the final URL", async () => {
    const direct = await guardedRequest(`${base}/ok`, { allowlist: allow });
    expect(direct.status).toBe(200);
    expect(direct.body.toString()).toBe("fine");
    const redirected = await guardedRequest(`${base}/to-ok`, { allowlist: allow });
    expect(redirected.finalUrl).toBe(`${base}/ok`);
  });

  it("re-checks every redirect hop: a redirect to a private or non-allowlisted target is refused before any connection", async () => {
    const before = hits.length;
    expect(await denied(guardedRequest(`${base}/to-private`, { allowlist: allow }))).toBe("not_allowlisted");
    expect(await denied(guardedRequest(`${base}/to-other-host`, { allowlist: allow, resolver: resolverFor({ "elsewhere.example.test": ["10.0.0.9"] }) }))).toBe("not_allowlisted");
    expect(hits.length - before).toBe(2); // only the two initial requests reached the server; neither redirect target was contacted
    expect(await denied(guardedRequest(`${base}/loop`, { allowlist: allow, maxRedirects: 2 }))).toBe("too_many_redirects");
  });

  it("refuses non-HTTP schemes, URLs with credentials and unparsable URLs", async () => {
    expect(await denied(guardedRequest("file:///etc/passwd", { allowlist: allow }))).toBe("bad_url");
    expect(await denied(guardedRequest("ftp://127.0.0.1/x", { allowlist: allow }))).toBe("bad_url");
    expect(await denied(guardedRequest(`http://user:pass@127.0.0.1:${port}/ok`, { allowlist: allow }))).toBe("bad_url");
    expect(await denied(guardedRequest("not a url", { allowlist: allow }))).toBe("bad_url");
  });

  it("alternative IPv4 spellings are normalized before the check, so they cannot dodge it", async () => {
    // 2130706433 and 0x7f.1 both mean 127.0.0.1; with an empty allowlist they must be denied like the dotted form.
    for (const spelling of [`http://2130706433:${port}/ok`, `http://0x7f.1:${port}/ok`, `http://127.1:${port}/ok`, `http://[::ffff:7f00:1]:${port}/ok`]) {
      expect(await denied(guardedRequest(spelling, { allowlist: [] })), spelling).toBe("not_allowlisted");
    }
  });

  it("pins the connection to the validated address: a second DNS answer is never used", async () => {
    let calls = 0;
    const flipping: Resolver = async () => {
      calls += 1;
      return calls === 1 ? ["127.0.0.1"] : ["10.0.0.5"];
    };
    const response = await guardedRequest(`http://pin.example.test:${port}/ok`, { allowlist: ["pin.example.test", "127.0.0.1"], resolver: flipping });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("enforces response size and time limits", async () => {
    expect(await denied(guardedRequest(`${base}/big`, { allowlist: allow, maxBytes: 1000 }))).toBe("response_too_large");
    expect(await denied(guardedRequest(`${base}/slow`, { allowlist: allow, timeoutMs: 300 }))).toBe("timeout");
  });
});
