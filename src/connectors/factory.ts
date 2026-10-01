import type { ServerConfig } from "../config.js";
import { PostgresRoleProvider } from "./postgres-role.js";
import type { Provider } from "./provider.js";
import { SyntheticProvider } from "./synthetic.js";

/**
 * Providers for a deployment. Exactly the configured kind is registered: a production `postgres-role` deployment never
 * also exposes the simulator, and a synthetic deployment never claims to be live. Connecting is lazy: a disconnected live
 * provider fails explicitly when used (AC-08) instead of preventing startup.
 */
export function buildProviders(config: ServerConfig): Provider[] {
  if (config.provider === "synthetic") return [new SyntheticProvider()];
  if (!config.providerAdminUrl) throw new Error("ACCESSLEASE_PROVIDER_ADMIN_URL is required with ACCESSLEASE_PROVIDER=postgres-role");
  return [new PostgresRoleProvider({ adminUrl: config.providerAdminUrl, allowlist: config.settings.egressAllowlist, publicHost: config.providerPublicHost })];
}
