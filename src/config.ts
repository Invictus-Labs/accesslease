import { buildProviders } from "./connectors/factory.js";
import { ProviderRegistry } from "./connectors/provider.js";
import { type Ctx, defaultSettings, type Settings, systemClock } from "./context.js";
import { ServerKey } from "./crypto.js";
import { openDatabase } from "./db/index.js";
import { parseAllowlist } from "./lib/egress.js";
import { createLogger } from "./lib/log.js";
import type { ProviderKind } from "./domain/types.js";
import { ABSOLUTE_MAX_TTL_SECONDS, PROVIDER_KINDS } from "./domain/types.js";

export interface ServerConfig {
  databaseUrl: string;
  secretKey: string;
  host: string;
  port: number;
  provider: ProviderKind;
  providerAdminUrl: string | null;
  /** Host shown to grantees in credential deliveries (default: host of the provider admin URL). */
  providerPublicHost: string | null;
  settings: Settings;
}

const isLoopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());

/** Same server = same host (loopback names are all one machine) and port. Used to keep provider and metadata clusters separate. */
export function sameCluster(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  const norm = (u: URL) => `${isLoopback(u.hostname) ? "loopback" : u.hostname.toLowerCase()}:${u.port || "5432"}`;
  return norm(left) === norm(right);
}

/** Read configuration from the environment. Missing or unsafe values stop startup with a diagnostic. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing = ["ACCESSLEASE_DATABASE_URL", "ACCESSLEASE_SECRET_KEY"].filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`missing required configuration: ${missing.join(", ")} (see .env.example)`);
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  let databaseUrl = env.ACCESSLEASE_DATABASE_URL as string;
  if (env.ACCESSLEASE_DATABASE_PASSWORD !== undefined) {
    const url = new URL(databaseUrl);
    url.password = encodeURIComponent(env.ACCESSLEASE_DATABASE_PASSWORD);
    databaseUrl = url.toString();
  }
  const publicUrl = env.ACCESSLEASE_PUBLIC_URL ?? "";
  if (publicUrl && !["http:", "https:"].includes(new URL(publicUrl).protocol)) throw new Error("ACCESSLEASE_PUBLIC_URL must use http or https");
  const provider = (env.ACCESSLEASE_PROVIDER ?? "synthetic") as ProviderKind;
  if (!PROVIDER_KINDS.includes(provider)) throw new Error(`ACCESSLEASE_PROVIDER must be one of ${PROVIDER_KINDS.join(", ")}`);
  const providerAdminUrl = env.ACCESSLEASE_PROVIDER_ADMIN_URL ? env.ACCESSLEASE_PROVIDER_ADMIN_URL : null;
  if (provider === "postgres-role") {
    if (!providerAdminUrl) throw new Error("ACCESSLEASE_PROVIDER_ADMIN_URL is required with ACCESSLEASE_PROVIDER=postgres-role");
    if (!/^postgres(ql)?:\/\//.test(providerAdminUrl)) throw new Error("ACCESSLEASE_PROVIDER_ADMIN_URL must start with postgres:// or postgresql://");
    if (sameCluster(databaseUrl, providerAdminUrl)) {
      throw new Error("ACCESSLEASE_PROVIDER_ADMIN_URL must point to a separate PostgreSQL cluster, never the metadata database");
    }
  }
  const maxTtl = integer("ACCESSLEASE_TTL_MAX_SECONDS", defaultSettings.initialPolicy.maxTtlSeconds, 1, ABSOLUTE_MAX_TTL_SECONDS);
  const minTtl = integer("ACCESSLEASE_TTL_MIN_SECONDS", defaultSettings.initialPolicy.minTtlSeconds, 1, maxTtl);
  const defaultTtl = integer("ACCESSLEASE_TTL_DEFAULT_SECONDS", Math.min(defaultSettings.initialPolicy.defaultTtlSeconds, maxTtl), minTtl, maxTtl);
  const settings: Settings = {
    ...defaultSettings,
    publicUrl: publicUrl || defaultSettings.publicUrl,
    // Secure cookies unless the operator explicitly serves plain http (local demo).
    secureCookies: !publicUrl.startsWith("http://"),
    workerPollMs: integer("ACCESSLEASE_WORKER_POLL_MS", defaultSettings.workerPollMs, 50, 60_000),
    egressAllowlist: parseAllowlist(env.ACCESSLEASE_EGRESS_ALLOWLIST ?? ""),
    initialPolicy: {
      defaultTtlSeconds: defaultTtl,
      maxTtlSeconds: maxTtl,
      minTtlSeconds: minTtl,
      retentionDays: integer("ACCESSLEASE_RETENTION_DAYS", defaultSettings.initialPolicy.retentionDays, 1, 3650),
    },
  };
  const host = env.ACCESSLEASE_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("ACCESSLEASE_HOST must not be empty");
  return {
    databaseUrl,
    secretKey: env.ACCESSLEASE_SECRET_KEY as string,
    host,
    port: integer("ACCESSLEASE_PORT", 8791, 1, 65535),
    provider,
    providerAdminUrl,
    providerPublicHost: env.ACCESSLEASE_PROVIDER_PUBLIC_HOST ? env.ACCESSLEASE_PROVIDER_PUBLIC_HOST : null,
    settings,
  };
}

export function contextFromConfig(config: ServerConfig): Ctx {
  const providers = new ProviderRegistry(buildProviders(config), config.provider);
  return {
    db: openDatabase(config.databaseUrl),
    key: ServerKey.fromBase64(config.secretKey),
    clock: systemClock,
    settings: config.settings,
    providers,
    log: createLogger(),
  };
}
