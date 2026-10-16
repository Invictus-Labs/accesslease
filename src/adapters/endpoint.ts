import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolve a hostname to all of its addresses. Injectable so tests need no DNS. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true })).map((r) => r.address);

export class EndpointError extends Error {
  readonly code = "endpoint_refused";
}

export interface EndpointPolicy {
  /** Exact, case-insensitive host names that may be contacted. */
  allowedHosts: string[];
  /** Permit RFC 1918 / unique-local targets for allow-listed hosts. Loopback is always permitted for allow-listed hosts. */
  allowPrivate?: boolean;
}

const lower = (s: string) => s.toLowerCase();

/** Expand an IPv6 literal (compressed, expanded, with a dotted IPv4 tail) into eight 16-bit groups, or null. */
export function ipv6Groups(address: string): number[] | null {
  let text = address.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const o = (dotted[2] as string).split(".").map(Number);
    text = `${dotted[1]}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length > 1 && halves[1] ? (halves[1] as string).split(":") : [];
  const fill = halves.length > 1 ? Array(8 - head.length - tail.length).fill("0") : [];
  const groups = [...head, ...fill, ...tail].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address embedded in an IPv6 address that merely carries one: IPv4-mapped (::ffff:0:0/96), IPv4-compatible
 * (::/96, except :: and ::1) and NAT64 (64:ff9b::/96). Dotted or hex, compressed or expanded. Null for anything else.
 */
export function embeddedIPv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g) return null;
  const v4 = `${(g[6] as number) >> 8}.${(g[6] as number) & 0xff}.${(g[7] as number) >> 8}.${(g[7] as number) & 0xff}`;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4;
  if (zeros(0, 6) && !(g[6] === 0 && (g[7] === 0 || g[7] === 1))) return v4;
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4;
  return null;
}

/** Classify an IP literal. Link-local (cloud metadata) and unspecified addresses are never allowed. */
export function classifyAddress(address: string): "loopback" | "private" | "link-local" | "unspecified" | "public" {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  const embedded = embeddedIPv4(a);
  if (embedded) return classifyAddress(embedded);
  if (isIP(a) === 4) {
    const [o1 = 0, o2 = 0] = a.split(".").map(Number);
    if (o1 === 0) return "unspecified";
    if (o1 === 127) return "loopback";
    if (o1 === 169 && o2 === 254) return "link-local";
    if (o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 100 && o2 >= 64 && o2 <= 127)) return "private";
    return "public";
  }
  const g = ipv6Groups(a);
  if (g && g.every((x) => x === 0)) return "unspecified";
  if (g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if (/^fe[89ab]/.test(a)) return "link-local";
  if (/^f[cd]/.test(a)) return "private";
  return "public";
}

export interface CheckedEndpoint {
  url: URL;
  /** Addresses that passed the check. A request must connect to one of these, not resolve the name again. */
  addresses: string[];
}

/**
 * Check an outbound endpoint before any request: http(s) only, no embedded credentials, host on the admin allowlist,
 * and every resolved address acceptable (no link-local or unspecified targets; private only if explicitly allowed).
 * Returns the validated addresses so the connection can be pinned to them. Redirects are refused by the caller.
 */
export async function resolveEndpoint(rawUrl: string, policy: EndpointPolicy, resolve: Resolver = systemResolver): Promise<CheckedEndpoint> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EndpointError("endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new EndpointError("endpoint must use http or https");
  if (url.username || url.password) throw new EndpointError("endpoint must not embed credentials");
  const host = lower(url.hostname.replace(/^\[|\]$/g, ""));
  if (!policy.allowedHosts.map(lower).includes(host)) throw new EndpointError("endpoint host is not on the adapter allowlist");
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0) throw new EndpointError("endpoint host did not resolve");
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === "link-local" || kind === "unspecified") throw new EndpointError("endpoint resolves to a link-local or unspecified address");
    if (kind === "private" && !policy.allowPrivate) throw new EndpointError("endpoint resolves to a private address; set the allow-private option to permit it");
  }
  return { url, addresses };
}

/** Same check, returning only the URL. */
export async function checkEndpoint(rawUrl: string, policy: EndpointPolicy, resolve: Resolver = systemResolver): Promise<URL> {
  return (await resolveEndpoint(rawUrl, policy, resolve)).url;
}
