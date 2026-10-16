import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Egress allowlist (PRD "Security and resource limits"). Outbound endpoints are configured by administrators and
 * checked against an allowlist that is re-applied to every redirect hop and to every DNS resolution result.
 *
 * Allowlist entries (ACCESSLEASE_EGRESS_ALLOWLIST, comma separated):
 *   `example.test`       host name (any port)
 *   `example.test:5432`  host name + port
 *   `*.example.test`     any subdomain of example.test (not example.test itself)
 *   `127.0.0.1`          IP literal (also admits a host name whose every address is covered by an IP/CIDR entry)
 *   `10.0.0.0/8`         CIDR range
 * Private, loopback, link-local and multicast addresses are refused unless an IP or CIDR entry covers them
 * explicitly (or the host is the literal `localhost` and an entry names it). A public host name never reaches a
 * private address by DNS trickery: every resolved address is checked.
 */

export class EgressDeniedError extends Error {
  constructor(
    readonly reason: "not_allowlisted" | "private_address" | "dns_failure" | "bad_url" | "too_many_redirects" | "response_too_large" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "EgressDeniedError";
  }
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const results = await dns.lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

const HOST_RE = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function parseAllowlist(raw: string): string[] {
  const entries = raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry === "*" || entry.includes("://") || entry.includes("/") && !isCidr(entry)) throw new Error(`invalid egress allowlist entry "${entry}"`);
    if (isCidr(entry)) continue;
    const bare = stripPort(entry).host;
    if (!net.isIP(bare) && !HOST_RE.test(bare)) throw new Error(`invalid egress allowlist entry "${entry}"`);
  }
  return entries;
}

function stripPort(entry: string): { host: string; port: number | null } {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracket) return { host: bracket[1] as string, port: bracket[2] ? Number(bracket[2]) : null };
  if (net.isIPv6(entry)) return { host: entry, port: null };
  const colon = entry.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) return { host: entry.slice(0, colon), port: Number(entry.slice(colon + 1)) };
  return { host: entry, port: null };
}

function isCidr(entry: string): boolean {
  const [address, bits] = entry.split("/");
  if (!address || bits === undefined || !/^\d{1,3}$/.test(bits)) return false;
  const family = net.isIP(address);
  return (family === 4 && Number(bits) <= 32) || (family === 6 && Number(bits) <= 128);
}

function toBigInt(ip: string): { value: bigint; bits: 32 | 128 } | null {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    return { value: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n), bits: 32 };
  }
  if (net.isIPv6(ip)) {
    let text = ip.toLowerCase();
    const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) {
      const v4 = toBigInt(mapped[2] as string);
      text = `${mapped[1]}${((v4?.value ?? 0n) >> 16n).toString(16)}:${((v4?.value ?? 0n) & 0xffffn).toString(16)}`;
    }
    const [head, tail] = text.split("::");
    const left = head ? head.split(":") : [];
    const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
    const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
    const groups = [...left, ...fill, ...right];
    return { value: groups.reduce((acc, g) => (acc << 16n) + BigInt(`0x${g || "0"}`), 0n), bits: 128 };
  }
  return null;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.includes("/") ? (cidr.split("/") as [string, string]) : [cidr, net.isIPv4(cidr) ? "32" : "128"];
  const a = toBigInt(ip);
  const b = toBigInt(base);
  if (!a || !b || a.bits !== b.bits) return false;
  const bits = Number(bitsText);
  const shift = BigInt(a.bits - bits);
  return a.value >> shift === b.value >> shift;
}

const PRIVATE_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

const dotted = (v4: bigint) => [24n, 16n, 8n, 0n].map((shift) => Number((v4 >> shift) & 0xffn)).join(".");

/**
 * Addresses that embed an IPv4 address are judged by the embedded address, in every spelling (dotted or hexadecimal):
 * IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96 (non-trivial), NAT64 64:ff9b::/96 and 6to4 2002::/16.
 */
function unmap(ip: string): string {
  const parsed = toBigInt(ip);
  if (!parsed || parsed.bits !== 128) return ip;
  const v = parsed.value;
  const low32 = v & 0xffffffffn;
  if (v >> 32n === 0xffffn) return dotted(low32);
  if (v >> 32n === 0n && low32 > 1n) return dotted(low32);
  if (v >> 32n === 0x64ff9bn << 64n) return dotted(low32);
  if (v >> 112n === 0x2002n) return dotted((v >> 80n) & 0xffffffffn);
  return ip;
}

export function isPrivateAddress(ip: string): boolean {
  const address = unmap(ip);
  return PRIVATE_RANGES.some((range) => inCidr(address, range));
}

export interface EgressTarget {
  host: string;
  port: number;
}

/**
 * Validate one endpoint and return the addresses it may be contacted on. Callers must connect to one of the returned
 * addresses (not re-resolve the name) so a DNS change after the check cannot redirect the connection.
 */
export async function checkEndpoint(target: EgressTarget, allowlist: readonly string[], resolver: Resolver = systemResolver): Promise<string[]> {
  const host = target.host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new EgressDeniedError("bad_url", "empty host");
  const entries = allowlist.map((entry) => (isCidr(entry) ? { kind: "cidr" as const, value: entry, port: null } : { kind: "host" as const, ...stripPort(entry) }));
  const portOk = (port: number | null) => port === null || port === target.port;

  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new EgressDeniedError("dns_failure", `cannot resolve ${host}`);
    }
    if (addresses.length === 0) throw new EgressDeniedError("dns_failure", `no addresses for ${host}`);
  }

  const covers = (address: string) =>
    entries.some((e) => (e.kind === "cidr" ? inCidr(address, e.value) : net.isIP(e.host) !== 0 && portOk(e.port) && inCidr(address, e.host)));
  const nameMatch = entries.some((e) => {
    if (e.kind !== "host" || net.isIP(e.host) || !portOk(e.port)) return false;
    return e.host.startsWith("*.") ? host.endsWith(e.host.slice(1)) && host.length > e.host.length - 1 : e.host === host;
  });
  const literalLocalhost = host === "localhost" && nameMatch;

  if (!nameMatch && !addresses.every(covers)) throw new EgressDeniedError("not_allowlisted", `${host} is not on the egress allowlist`);
  for (const address of addresses) {
    if (isPrivateAddress(address) && !covers(address) && !(literalLocalhost && inCidr(unmap(address), "127.0.0.0/8")) && !(literalLocalhost && address === "::1")) {
      throw new EgressDeniedError("private_address", `${host} resolves to a private address that is not explicitly allowed`);
    }
  }
  return addresses;
}

export interface GuardedRequestOptions {
  allowlist: readonly string[];
  resolver?: Resolver;
  method?: "GET" | "HEAD";
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface GuardedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
}

/**
 * HTTP(S) GET through the allowlist. Redirects are followed manually and every hop (scheme, host, port, DNS result)
 * is re-checked; the connection is pinned to the validated address; credentials in URLs are refused.
 */
export async function guardedRequest(rawUrl: string, options: GuardedRequestOptions): Promise<GuardedResponse> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new EgressDeniedError("bad_url", "invalid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new EgressDeniedError("bad_url", `scheme ${url.protocol} is not allowed`);
    if (url.username || url.password) throw new EgressDeniedError("bad_url", "credentials in URLs are not allowed");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const addresses = await checkEndpoint({ host: url.hostname, port }, options.allowlist, options.resolver);
    const pinned = addresses[0] as string;
    const response = await send(url, pinned, port, options);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      current = new URL(String(response.headers.location), url).toString();
      continue;
    }
    return { ...response, finalUrl: url.toString() };
  }
  throw new EgressDeniedError("too_many_redirects", "too many redirects");
}

function send(url: URL, address: string, port: number, options: GuardedRequestOptions): Promise<Omit<GuardedResponse, "finalUrl">> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: { ...options.headers, host: url.host },
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        // Pin the connection to the address that passed the allowlist check (no second resolution).
        lookup: (_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          const family = net.isIPv6(address) ? 6 : 4;
          if (lookupOptions?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      } as http.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            reject(new EgressDeniedError("response_too_large", "response exceeds the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    request.setTimeout(options.timeoutMs ?? 10_000, () => {
      request.destroy();
      reject(new EgressDeniedError("timeout", "request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}
