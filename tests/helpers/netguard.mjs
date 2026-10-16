// Network guard preloaded with `node --import tests/helpers/netguard.mjs`. Every outbound socket, DNS lookup, fetch and http(s)
// request made by the process under test is logged to $QA_NET_LOG (one JSON object per line); anything not on the allow-list
// $QA_NET_ALLOW (comma separated host:port) is refused. The AC-08 tests then assert that the log contains nothing but the
// metadata database connection, proving the deterministic core makes no outbound network call and sends no telemetry.
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const allow = new Set((process.env.QA_NET_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const logPath = process.env.QA_NET_LOG;
const record = (kind, target, blocked) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ kind, target, blocked })}\n`);
};
const allowed = (host, port) => allow.has(`${host}:${port}`) || allow.has(`${host}:*`);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  let host = "localhost";
  let port;
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    host = first.host ?? "localhost";
    port = first.port;
    if (first.path) {
      record("connect", `unix:${first.path}`, true);
      return this.destroy(Object.assign(new Error("QA net guard: unix sockets are not allowed"), { code: "EACCES" }));
    }
  } else if (typeof first === "number") {
    port = first;
    if (typeof args[1] === "string") host = args[1];
  }
  const ok = allowed(host, port);
  record("connect", `${host}:${port}`, !ok);
  if (!ok) return this.destroy(Object.assign(new Error(`QA net guard: outbound connection to ${host}:${port} refused`), { code: "ECONNREFUSED" }));
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function patched(hostname, ...rest) {
  record("dns", String(hostname), !["localhost", "127.0.0.1"].includes(String(hostname)));
  return lookup.call(this, hostname, ...rest);
};

globalThis.fetch = async (input) => {
  record("fetch", String(input?.url ?? input), true);
  throw new Error("QA net guard: fetch is disabled");
};

for (const mod of [http, https]) {
  const request = mod.request;
  mod.request = function patched(...args) {
    record("http", String(args[0]?.href ?? args[0]?.host ?? args[0]), true);
    return request.apply(this, args);
  };
}
