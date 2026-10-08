import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** The slice of a fetch Response the poller needs. */
export interface PinnedResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface PinnedRequest {
  url: URL;
  /** The validated address to connect to. The host name is never resolved again. */
  address: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export class ResponseTooLargeError extends Error {}

/**
 * GET with the connection pinned to an address that already passed the allowlist check. TLS still verifies the
 * certificate against the host name; redirects are not followed (a 3xx is returned as is and refused by the caller).
 */
export function pinnedGet(req: PinnedRequest): Promise<PinnedResponse> {
  const { url, address } = req;
  const transport = url.protocol === "https:" ? https : http;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        host: hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...req.headers, host: url.host },
        servername: isIP(hostname) ? undefined : hostname,
        // Node may ask for all addresses (`all: true`, happy eyeballs) or for one; answer both with the pinned address.
        lookup: (_host: string, opts: { all?: boolean }, callback: (err: Error | null, address: unknown, family?: number) => void) => {
          const family = isIP(address) === 6 ? 6 : 4;
          if (opts && opts.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      } as http.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            request.destroy();
            reject(new ResponseTooLargeError("response exceeds the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status, ok: status >= 200 && status < 300, text: async () => body });
        });
        res.on("error", reject);
      },
    );
    request.setTimeout(req.timeoutMs, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end();
  });
}
