import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { pinnedGet } from "../../src/adapters/pinned.js";
import { EndpointError, checkEndpoint, classifyAddress, type Resolver } from "../../src/adapters/endpoint.js";

/** Independent tests of the optional ecosystem adapter's outbound endpoint check (disabled by default; admin-configured allowlist). */
const resolverFor = (map: Record<string, string[]>): Resolver => async (host) => map[host] ?? [];
const refused = async (promise: Promise<unknown>): Promise<boolean> => {
  try {
    await promise;
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(EndpointError);
    return true;
  }
};

describe("adapter address classification", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["169.254.169.254", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fd00::1", "private"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["192.0.2.1", "public"],
    ["2001:db8::1", "public"],
  ])("%s is %s", (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });

  it("IPv4-mapped IPv6 addresses in hexadecimal are classified by the embedded IPv4 address (cloud metadata must stay unreachable)", () => {
    expect(classifyAddress("::ffff:a9fe:a9fe"), "169.254.169.254").toBe("link-local");
    expect(classifyAddress("::ffff:7f00:1"), "127.0.0.1").toBe("loopback");
    expect(classifyAddress("::ffff:a00:1"), "10.0.0.1").toBe("private");
    expect(classifyAddress("0:0:0:0:0:ffff:a9fe:a9fe"), "expanded 169.254.169.254").toBe("link-local");
  });
});

describe("adapter endpoint check", () => {
  const dns = resolverFor({ "events.example.test": ["192.0.2.20"], "meta.example.test": ["169.254.169.254"], "mapped-meta.example.test": ["::ffff:a9fe:a9fe"], "local.example.test": ["10.0.0.7"] });

  it("accepts an allowlisted public endpoint and refuses everything off-list, with credentials, or with another scheme", async () => {
    const url = await checkEndpoint("https://events.example.test/api/v1/events", { allowedHosts: ["events.example.test"] }, dns);
    expect(url.hostname).toBe("events.example.test");
    expect(await refused(checkEndpoint("https://other.example.test/", { allowedHosts: ["events.example.test"] }, dns))).toBe(true);
    expect(await refused(checkEndpoint("https://user:pw@events.example.test/", { allowedHosts: ["events.example.test"] }, dns))).toBe(true);
    expect(await refused(checkEndpoint("ftp://events.example.test/", { allowedHosts: ["events.example.test"] }, dns))).toBe(true);
    expect(await refused(checkEndpoint("not a url", { allowedHosts: ["events.example.test"] }, dns))).toBe(true);
  });

  it("refuses link-local and private resolutions of an allowlisted name, including the hex-mapped spelling of the metadata address", async () => {
    expect(await refused(checkEndpoint("http://meta.example.test/", { allowedHosts: ["meta.example.test"] }, dns))).toBe(true);
    expect(await refused(checkEndpoint("http://local.example.test/", { allowedHosts: ["local.example.test"] }, dns))).toBe(true);
    expect(await refused(checkEndpoint("http://mapped-meta.example.test/", { allowedHosts: ["mapped-meta.example.test"] }, dns))).toBe(true);
    expect((await checkEndpoint("http://local.example.test/", { allowedHosts: ["local.example.test"], allowPrivate: true }, dns)).hostname).toBe("local.example.test");
  });
});

describe("adapter connection pinning", () => {
  it("connects to the validated address and never resolves the host name again; the Host header still names the endpoint", async () => {
    let seenHost = "";
    const server = createServer((req, res) => {
      seenHost = String(req.headers.host);
      res.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // pin.example.test does not resolve anywhere: the request can only succeed if the pinned address is used.
      const response = await pinnedGet({ url: new URL(`http://pin.example.test:${port}/events`), address: "127.0.0.1", headers: {}, timeoutMs: 5000, maxBytes: 1000 });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("pinned");
      expect(seenHost).toBe(`pin.example.test:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
