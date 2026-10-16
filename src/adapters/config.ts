import { type EndpointPolicy } from "./endpoint.js";

export interface AdapterConfig {
  /** Off unless explicitly switched on. */
  enabled: boolean;
  /** AccessLease base URL to pull events from, for example http://localhost:8791. Null when not configured. */
  baseUrl: string | null;
  /** JSON state file (dedupe set, applied revisions, pull cursor). Null keeps state in memory only. */
  stateFile: string | null;
  policy: EndpointPolicy;
}

const truthy = (value: string | undefined): boolean => value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

/**
 * Read adapter settings from the environment. The adapter is disabled unless ACCESSLEASE_ADAPTER_ENABLED is set,
 * and by default may only contact localhost.
 */
export function adapterConfigFromEnv(env: NodeJS.ProcessEnv): AdapterConfig {
  const hosts = (env.ACCESSLEASE_ADAPTER_ALLOWED_HOSTS ?? "localhost,127.0.0.1")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    enabled: truthy(env.ACCESSLEASE_ADAPTER_ENABLED),
    baseUrl: env.ACCESSLEASE_ADAPTER_BASE_URL?.trim() || null,
    stateFile: env.ACCESSLEASE_ADAPTER_STATE_FILE?.trim() || null,
    policy: { allowedHosts: hosts, allowPrivate: truthy(env.ACCESSLEASE_ADAPTER_ALLOW_PRIVATE) },
  };
}
