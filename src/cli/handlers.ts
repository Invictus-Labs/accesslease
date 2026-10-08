import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { adapterConfigFromEnv, AdapterUnavailableError, EventConsumer, FileStore, httpEventSource, pollOnce, type EventPage, type EventSource, type PollSummary } from "../adapters/index.js";
import { assetPath } from "../report/assets.js";
import { parseReportData } from "../report/data-schema.js";
import { reportModelFromData, unresolvedInReport } from "../report/from-data.js";
import { renderReport } from "../report/render.js";
import { redactedReportJson } from "../report/redact.js";
import type { ReportData } from "../services/contract.js";
import { boolFlag, intFlag, stringFlag, type FlagValues } from "./args.js";
import { CliError, EXIT, finalExitCode, UsageError } from "./exit.js";
import { assertWritable, prepareOutputDir, readBoundedFile, writeOwnerOnlyFile } from "./fs.js";
import { type CommandDeps, type Io, loadServices, openRuntime, type Outcome, principalFor, withRuntime } from "./runtime.js";

export interface HandlerInput {
  flags: FlagValues;
  positionals: string[];
  env: NodeJS.ProcessEnv;
  io: Io;
  deps: CommandDeps;
}

const METADATA_LIMIT = 25 * 1024 * 1024;
const LARGE_LIMIT = 250 * 1024 * 1024;
const DEFAULT_DEMO_START = "2026-01-01T00:00:00.000Z";

const ids = (value: string | undefined): string[] | undefined => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const total = (u: { issueUnknown: number; revocationUnconfirmed: number }): number => u.issueUnknown + u.revocationUnconfirmed;

/** Explain exit 4 so nobody reads an unresolved result as success. */
function warnUnresolved(io: Io, u: { issueUnknown: number; revocationUnconfirmed: number }): void {
  if (total(u) === 0) return;
  io.err(`WARNING: ${u.issueUnknown} lease(s) in ISSUE_UNKNOWN and ${u.revocationUnconfirmed} in REVOCATION_UNCONFIRMED. Access may still exist. Exiting with code 4: this is not success.`);
}

// ---- migrate ------------------------------------------------------------------------------------

export async function migrate({ env, io, deps }: HandlerInput): Promise<Outcome> {
  return withRuntime(env, deps, async ({ svc, ctx }) => {
    const { applied } = await svc.migrate(ctx);
    io.out(applied.length ? `applied migrations: ${applied.join(", ")}` : "schema up to date");
    return EXIT.OK;
  });
}

// ---- bootstrap-admin ----------------------------------------------------------------------------

const MIN_PASSWORD = 12;

/** Resolve the administrator password. There is never a default: it is supplied, or generated and shown once. */
function resolvePassword(flags: FlagValues, env: NodeJS.ProcessEnv, deps: CommandDeps): { password: string; generated: boolean } {
  const file = stringFlag(flags, "password-file");
  if (file) {
    const stat = (() => {
      try {
        return statSync(resolve(file));
      } catch {
        throw new UsageError(`cannot read ${file}`);
      }
    })();
    if (!stat.isFile()) throw new UsageError(`${file} is not a regular file`);
    if ((stat.mode & 0o077) !== 0) throw new UsageError(`${file} must be readable only by you (chmod 600)`);
    const password = readBoundedFile(file, 4096).toString("utf8").replace(/\r?\n$/, "");
    if (password.length < MIN_PASSWORD) throw new UsageError(`the password must be at least ${MIN_PASSWORD} characters`);
    return { password, generated: false };
  }
  const fromEnv = env.ACCESSLEASE_BOOTSTRAP_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < MIN_PASSWORD) throw new UsageError(`ACCESSLEASE_BOOTSTRAP_PASSWORD must be at least ${MIN_PASSWORD} characters`);
    return { password: fromEnv, generated: false };
  }
  return { password: (deps.randomPassword ?? (() => randomBytes(24).toString("base64url")))(), generated: true };
}

export async function bootstrapAdmin({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const workspaceName = stringFlag(flags, "workspace") as string;
  const email = stringFlag(flags, "email") as string;
  const out = stringFlag(flags, "password-out");
  const { password, generated } = resolvePassword(flags, env, deps);
  if (out && !generated) throw new UsageError("--password-out only applies when the password is generated");
  if (out) assertWritable(out, false);
  return withRuntime(env, deps, async ({ svc, ctx }) => {
    await svc.migrate(ctx);
    const result = await svc.bootstrapAdmin(ctx, { email, password, workspaceName });
    io.out(`workspace ${result.workspaceId}${result.created.workspace ? " (created)" : " (already existed)"}`);
    io.out(`administrator ${email}${result.created.user ? " (created)" : " (already existed)"}`);
    if (!result.created.user) {
      io.out("No change: the administrator already exists, so no password was set or shown.");
      return EXIT.OK;
    }
    if (!generated) {
      io.out("The password you supplied is set. It is not stored anywhere readable.");
    } else if (out) {
      writeOwnerOnlyFile(out, `${password}\n`);
      io.out(`generated password written to ${out} (mode 0600). Delete the file after first sign-in.`);
    } else {
      io.out(`generated password (shown once, copy it now): ${password}`);
    }
    return EXIT.OK;
  });
}

// ---- demo ---------------------------------------------------------------------------------------

/** The demo database URL: the flag, else the environment. A separate password variable is applied like the server does, so the URL need not embed it. */
function demoDatabaseUrl(flags: FlagValues, env: NodeJS.ProcessEnv): string {
  const raw = stringFlag(flags, "database-url") ?? env.ACCESSLEASE_DATABASE_URL;
  if (!raw) throw new UsageError("demo needs a PostgreSQL URL: pass --database-url or set ACCESSLEASE_DATABASE_URL");
  if (env.ACCESSLEASE_DATABASE_PASSWORD === undefined) return raw;
  try {
    const url = new URL(raw);
    url.password = encodeURIComponent(env.ACCESSLEASE_DATABASE_PASSWORD);
    return url.toString();
  } catch {
    throw new UsageError("the database URL is not a valid URL");
  }
}

export async function demo({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const outDir = stringFlag(flags, "out") as string;
  const databaseUrl = demoDatabaseUrl(flags, env);
  const startAt = stringFlag(flags, "start-at") ?? DEFAULT_DEMO_START;
  if (Number.isNaN(Date.parse(startAt)) || !/Z$/.test(startAt)) throw new UsageError("--start-at must be a UTC instant such as 2026-01-01T00:00:00.000Z");
  const dir = prepareOutputDir(outDir, boolFlag(flags, "force"));
  const svc = await loadServices(deps);
  io.out("Running the SYNTHETIC demo: no live provider, no network, fixed clock.");
  const result = await svc.runDemo({ databaseUrl, outDir: dir, startAt });
  const recounted = unresolvedInReport(result.reportData);
  const reportPath = writeOwnerOnlyFile(join(dir, "report.html"), renderReport(reportModelFromData(result.reportData)));
  io.out(`provider: ${result.provider.label} (live: ${result.provider.live})`);
  io.out(`evidence bundle: ${result.files.bundle ?? "(not written)"} (hash ${result.bundle.bundle_hash}, ${result.bundle.lease_count} leases)`);
  if (result.files.reportData) io.out(`report data: ${result.files.reportData}`);
  io.out(`static report: ${reportPath}`);
  warnUnresolved(io, result.unresolved);
  if (total(result.unresolved) > 0) io.err("The demo deliberately leaves uncertain leases to show how unresolved states look. Open the report to see them.");
  if (result.reportData.truncated) io.err(`WARNING: the demo report is INCOMPLETE: it lists ${result.reportData.leases.length} of ${result.reportData.workspace_total} leases. Exiting with code 4: this is not success.`);
  return finalExitCode(EXIT.OK, Math.max(total(result.unresolved), recounted) + (result.reportData.truncated ? 1 : 0));
}

// ---- export / import / verify-bundle ------------------------------------------------------------

export async function exportBundle({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const out = stringFlag(flags, "out") as string;
  assertWritable(out, boolFlag(flags, "force"));
  return withRuntime(env, deps, async (rt) => {
    const principal = await principalFor(rt, stringFlag(flags, "workspace"));
    const result = await rt.svc.exportBundle(rt.ctx, principal, { leaseIds: ids(stringFlag(flags, "lease-ids")) });
    const path = writeOwnerOnlyFile(out, result.bytes);
    io.out(`exported ${result.lease_count} lease(s), ${result.file_count} file(s) to ${path} (mode 0600)`);
    io.out(`bundle_hash ${result.bundle_hash}`);
    const unresolved = await rt.svc.unresolvedCount(rt.ctx, principal.workspaceId);
    warnUnresolved(io, unresolved);
    return finalExitCode(EXIT.OK, total(unresolved));
  });
}

function readBundle(file: string, allowLarge: boolean): Buffer {
  return readBoundedFile(file, allowLarge ? LARGE_LIMIT : METADATA_LIMIT);
}

export async function importBundle({ flags, positionals, env, io, deps }: HandlerInput): Promise<Outcome> {
  const bytes = readBundle(positionals[0] as string, boolFlag(flags, "allow-large"));
  return withRuntime(env, deps, async (rt) => {
    const principal = await principalFor(rt, stringFlag(flags, "workspace"));
    const receipt = await rt.svc.importBundle(rt.ctx, principal, bytes, { allowLarge: boolFlag(flags, "allow-large") });
    io.out(receipt.already_imported ? `already imported: ${receipt.import_id} (no change)` : `imported ${receipt.lease_count} lease(s) as read-only evidence: ${receipt.import_id}`);
    io.out(`bundle_hash ${receipt.bundle_hash}`);
    return EXIT.OK;
  });
}

export async function verifyBundle({ flags, positionals, io, deps }: HandlerInput): Promise<Outcome> {
  const bytes = readBundle(positionals[0] as string, boolFlag(flags, "allow-large"));
  const svc = await loadServices(deps);
  const result = svc.verifyBundle(bytes, { allowLarge: boolFlag(flags, "allow-large") });
  if (boolFlag(flags, "json")) io.out(JSON.stringify(result));
  else if (result.ok) io.out(`bundle verified: hash ${result.bundle_hash}, ${result.lease_count} lease(s), ${result.file_count} file(s), schema_version ${result.schema_version}`);
  else io.err(`bundle REJECTED (${result.code}): ${result.message ?? "verification failed"}. Nothing was imported or accepted.`);
  return result.ok ? EXIT.OK : EXIT.INVALID;
}

// ---- report -------------------------------------------------------------------------------------

export async function report({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const format = stringFlag(flags, "format") ?? "html";
  if (format !== "html" && format !== "json") throw new UsageError("--format must be html or json");
  const out = stringFlag(flags, "out");
  if (out) assertWritable(out, boolFlag(flags, "force"));
  const from = stringFlag(flags, "from-data");

  const emit = (data: ReportData): Outcome => {
    // Count from the leases first: a report that disagrees with itself is refused before anything is written.
    const unresolved = unresolvedInReport(data);
    const body = format === "json" ? `${redactedReportJson(data)}\n` : renderReport(reportModelFromData(data));
    if (out) {
      const path = writeOwnerOnlyFile(out, body);
      io.out(`report written to ${path} (mode 0600)`);
    } else {
      io.out(body.replace(/\n$/, ""));
    }
    if (unresolved > 0) io.err(`WARNING: ${unresolved} lease(s) are in an unresolved state. Exiting with code 4: this is not success.`);
    if (data.truncated) io.err(`WARNING: the report is INCOMPLETE: it lists ${data.leases.length} of ${data.workspace_total} leases, so unresolved leases may be hidden. Exiting with code 4: this is not success.`);
    return finalExitCode(EXIT.OK, unresolved + (data.truncated ? 1 : 0));
  };

  if (from) return emit(parseReportData(readBoundedFile(from, METADATA_LIMIT).toString("utf8")));
  return withRuntime(env, deps, async (rt) => {
    const principal = await principalFor(rt, stringFlag(flags, "workspace"));
    return emit(await rt.svc.getReportData(rt.ctx, principal, { leaseIds: ids(stringFlag(flags, "lease-ids")) }));
  });
}

// ---- doctor -------------------------------------------------------------------------------------

const DOCTOR_LABEL = { ok: "ok", warn: "WARN", fail: "FAIL", unavailable: "UNAVAILABLE" } as const;

export async function doctor({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  let result;
  try {
    result = await withRuntime(env, deps, ({ svc, ctx }) => svc.runDoctor(ctx));
  } catch (error) {
    if (error instanceof CliError && error.code === "config_invalid") {
      const message = error.message.replace(/^configuration problem: /, "");
      io.out(boolFlag(flags, "json") ? JSON.stringify({ ok: false, checks: [{ name: "configuration", status: "fail", message }], exitCode: 1 }) : `[FAIL] configuration: ${message}\n       next step: copy .env.example to .env, fill the placeholders and export it, then run doctor again`);
      return EXIT.RUNTIME;
    }
    throw error;
  }
  if (boolFlag(flags, "json")) {
    io.out(JSON.stringify(result));
  } else {
    for (const c of result.checks) {
      io.out(`[${DOCTOR_LABEL[c.status]}] ${c.name}: ${c.message}${c.hint ? `\n       next step: ${c.hint}` : ""}`);
    }
    io.out(result.ok ? "doctor: all checks passed" : `doctor: problems found (exit ${result.exitCode})`);
  }
  return result.exitCode;
}

// ---- events -------------------------------------------------------------------------------------

const MAX_CONSUME_PAGES = 1000;

export async function events({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const limit = intFlag(flags, "limit", { min: 1, max: 100 }, 100);
  const after = stringFlag(flags, "after") ?? "0";
  const consume = boolFlag(flags, "consume");
  const remote = boolFlag(flags, "remote");
  if (remote && !consume) throw new UsageError("--remote needs --consume (the reference consumer pulls and ingests)");

  if (!consume) {
    return withRuntime(env, deps, async (rt) => {
      const principal = await principalFor(rt, stringFlag(flags, "workspace"));
      const page = await rt.svc.pullEvents(rt.ctx, principal, { after, limit });
      for (const e of page.items) io.out(JSON.stringify(e));
      io.err(`next_cursor=${page.next_cursor}`);
      return EXIT.OK;
    });
  }

  const config = adapterConfigFromEnv(env);
  if (!config.enabled) throw new CliError("the ecosystem adapter is disabled. Set ACCESSLEASE_ADAPTER_ENABLED=1 to enable it (it is off by default).", EXIT.INVALID, "adapter_disabled");
  const consumer = new EventConsumer({ enabled: true, ...(config.stateFile ? { store: new FileStore(config.stateFile) } : {}) });

  const run = async (source: EventSource): Promise<Outcome> => {
    const totals: PollSummary = { pulled: 0, accepted: 0, duplicates: 0, stale: 0, rejected: [], cursor: consumer.cursor };
    if (consumer.cursor === null) consumer.setCursor(after);
    for (let page = 0; page < MAX_CONSUME_PAGES; page += 1) {
      const before = consumer.cursor;
      const s = await pollOnce(consumer, source);
      totals.pulled += s.pulled;
      totals.accepted += s.accepted;
      totals.duplicates += s.duplicates;
      totals.stale += s.stale;
      totals.rejected.push(...s.rejected);
      totals.cursor = s.cursor;
      if (s.pulled === 0 || s.cursor === before) break;
    }
    io.out(`consumed ${totals.pulled} event(s): ${totals.accepted} applied, ${totals.duplicates} duplicate, ${totals.stale} stale (older revision, not applied), ${totals.rejected.length} rejected; cursor ${totals.cursor}`);
    for (const r of totals.rejected) io.err(`rejected event (${r.reason}): ${r.detail}`);
    return totals.rejected.length > 0 ? EXIT.INVALID : EXIT.OK;
  };

  if (remote) {
    if (!config.baseUrl) throw new UsageError("--remote needs ACCESSLEASE_ADAPTER_BASE_URL");
    const cookie = env.ACCESSLEASE_ADAPTER_SESSION_COOKIE;
    try {
      return await run(httpEventSource({ baseUrl: config.baseUrl, policy: config.policy, ...(cookie ? { headers: { cookie } } : {}) }));
    } catch (error) {
      if (error instanceof AdapterUnavailableError) throw new CliError(error.message, EXIT.UNAVAILABLE, "adapter_unavailable");
      throw error;
    }
  }
  return withRuntime(env, deps, async (rt) => {
    const principal = await principalFor(rt, stringFlag(flags, "workspace"));
    const source: EventSource = async (cursor): Promise<EventPage> => {
      const page = await rt.svc.pullEvents(rt.ctx, principal, { after: cursor ?? after, limit });
      return { events: page.items, next_cursor: page.next_cursor };
    };
    return run(source);
  });
}

// ---- worker / serve -----------------------------------------------------------------------------

export async function worker({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const pollMs = flags["poll-ms"] === undefined ? undefined : intFlag(flags, "poll-ms", { min: 50, max: 60_000 }, 5000);
  if (boolFlag(flags, "once")) {
    return withRuntime(env, deps, async ({ svc, ctx }) => {
      await svc.migrate(ctx);
      const pass = await svc.runWorkerOnce(ctx);
      io.out(`worker pass: ${pass.jobsProcessed} job(s), ${pass.issued} issued, ${pass.verified} verified, ${pass.unconfirmed} unconfirmed, ${pass.sweep.expiredToRevoking} expired -> revoking`);
      warnUnresolved(io, pass.unresolved);
      return finalExitCode(EXIT.OK, total(pass.unresolved));
    });
  }
  const rt = await openRuntime(env, deps);
  await rt.svc.migrate(rt.ctx);
  const controller = new AbortController();
  io.out("accesslease worker running (stop with Ctrl-C or SIGTERM)");
  const loop = rt.svc.runWorker(rt.ctx, {
    signal: controller.signal,
    ...(pollMs ? { pollMs } : {}),
    onPass: (p) => {
      if (p.jobsProcessed > 0 || p.sweep.expiredToRevoking > 0) io.out(`pass: ${p.jobsProcessed} job(s), ${p.issued} issued, ${p.verified} verified, ${p.unconfirmed} unconfirmed`);
    },
  });
  return async () => {
    controller.abort();
    await loop.catch(() => undefined);
    await rt.close().catch(() => undefined);
  };
}

export async function serve({ flags, env, io, deps }: HandlerInput): Promise<Outcome> {
  const rt = await openRuntime(env, deps);
  try {
    await rt.svc.migrate(rt.ctx);
    const startServer = deps.startServer ?? (await import("../server.js")).startServer;
    const hostFlag = stringFlag(flags, "host");
    const portFlag = flags.port === undefined ? undefined : intFlag(flags, "port", { min: 1, max: 65535 }, 8791);
    const config = rt.svc.loadConfig(env);
    const webRoot = assetPath("dist", "web");
    if (!existsSync(webRoot) || !lstatSync(webRoot).isDirectory()) io.err(`note: ${webRoot} does not exist, so the web UI will not be served. Run \`npm run build\` first.`);
    const server = await startServer(rt.ctx, { host: hostFlag ?? config.host, port: portFlag ?? config.port, webRoot, worker: !boolFlag(flags, "no-worker") });
    io.out(`accesslease listening on ${server.address}`);
    if ((hostFlag ?? config.host) === "0.0.0.0" || (hostFlag ?? config.host) === "::") io.err("note: this address accepts connections from other computers. Put it behind a TLS reverse proxy and a firewall.");
    return async () => {
      await server.close();
      await rt.close().catch(() => undefined);
    };
  } catch (error) {
    await rt.close().catch(() => undefined);
    throw error;
  }
}
