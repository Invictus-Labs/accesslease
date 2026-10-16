import type { CommandSpec } from "./args.js";

/** Command table. Every command is documented here once; `accesslease help <command>` prints from it. */
export const COMMAND_SPECS: Record<string, CommandSpec> = {
  serve: {
    name: "serve",
    summary: "Run the API, the worker and the web UI. Binds to 127.0.0.1 unless --host or ACCESSLEASE_HOST says otherwise.",
    flags: {
      host: { type: "string", value: "ADDRESS", description: "Bind address (default 127.0.0.1: this computer only; 0.0.0.0 exposes every network interface)" },
      port: { type: "string", value: "PORT", description: "Listen port (default 8791)" },
      "no-worker": { type: "boolean", description: "Serve the API and UI without the revocation worker (run `accesslease worker` separately)" },
    },
  },
  worker: {
    name: "worker",
    summary: "Run the background worker: issue approved leases, revoke expired or closed ones, verify and reconcile.",
    flags: {
      once: { type: "boolean", description: "Run a single pass and exit (exit 4 if unresolved states remain)" },
      "poll-ms": { type: "string", value: "MS", description: "Poll interval in milliseconds" },
    },
  },
  migrate: { name: "migrate", summary: "Apply database migrations. A failed or modified migration stops with an error and leaves the service not ready.", flags: {} },
  "bootstrap-admin": {
    name: "bootstrap-admin",
    summary: "Create a workspace and its first administrator. There is no default password.",
    flags: {
      workspace: { type: "string", value: "NAME", description: "Workspace name", required: true },
      email: { type: "string", value: "EMAIL", description: "Administrator email", required: true },
      "password-file": { type: "string", value: "PATH", description: "Read the password from a file readable only by you (mode 0600)" },
      "password-out": { type: "string", value: "PATH", description: "When the password is generated, write it to this new 0600 file instead of printing it" },
    },
  },
  demo: {
    name: "demo",
    summary: "Run the synthetic demo (SYNTHETIC provider, fixed clock, no network) and write a static report and an evidence bundle.",
    flags: {
      out: { type: "string", value: "DIR", description: "Output directory (created owner-only; must be empty unless --force)", required: true },
      "database-url": { type: "string", value: "URL", description: "PostgreSQL URL for the throwaway demo schema (default: ACCESSLEASE_DATABASE_URL)" },
      "start-at": { type: "string", value: "ISO", description: "Fixed starting instant (default 2026-01-01T00:00:00.000Z)" },
      force: { type: "boolean", description: "Write into a non-empty directory" },
    },
  },
  export: {
    name: "export",
    summary: "Export a versioned, redacted evidence bundle (works offline).",
    flags: {
      out: { type: "string", value: "FILE", description: "Bundle file to write (owner-only)", required: true },
      "lease-ids": { type: "string", value: "ID,ID", description: "Only these leases" },
      workspace: { type: "string", value: "NAME|ID", description: "Workspace (default: the only one)" },
      force: { type: "boolean", description: "Replace an existing file" },
    },
  },
  import: {
    name: "import",
    summary: "Verify and import an evidence bundle as read-only evidence. All or nothing: a bad bundle leaves no partial state.",
    positionals: [{ name: "file", description: "Bundle file", required: true }],
    flags: {
      workspace: { type: "string", value: "NAME|ID", description: "Workspace (default: the only one)" },
      "allow-large": { type: "boolean", description: "Allow bundles above 25 MB (up to 250 MB)" },
    },
  },
  "verify-bundle": {
    name: "verify-bundle",
    summary: "Verify a bundle's size, schema, version, paths and hashes without importing it.",
    positionals: [{ name: "file", description: "Bundle file", required: true }],
    flags: {
      "allow-large": { type: "boolean", description: "Allow bundles above 25 MB (up to 250 MB)" },
      json: { type: "boolean", description: "Print the verification result as JSON" },
    },
  },
  report: {
    name: "report",
    summary: "Render the static HTML report (escaped, no scripts). Exit 4 if any lease is unresolved.",
    flags: {
      out: { type: "string", value: "FILE", description: "Write the report here (owner-only); default: standard output" },
      format: { type: "string", value: "html|json", description: "Output format (default html)" },
      "lease-ids": { type: "string", value: "ID,ID", description: "Only these leases" },
      "from-data": { type: "string", value: "FILE", description: "Render a saved report-data JSON file instead of reading the database" },
      workspace: { type: "string", value: "NAME|ID", description: "Workspace (default: the only one)" },
      force: { type: "boolean", description: "Replace an existing file" },
    },
  },
  doctor: {
    name: "doctor",
    summary: "Check configuration, database, migrations, provider connection and unresolved leases, with next steps.",
    flags: { json: { type: "boolean", description: "Print the result as JSON" } },
  },
  events: {
    name: "events",
    summary: "Print lease events (versioned envelopes, at-least-once). With --consume, feed the reference consumer (disabled unless ACCESSLEASE_ADAPTER_ENABLED=1).",
    flags: {
      after: { type: "string", value: "CURSOR", description: "Resume after this cursor (default 0)" },
      limit: { type: "string", value: "N", description: "Page size, 1 to 100" },
      consume: { type: "boolean", description: "Ingest with the reference consumer: dedupe, version gate, revision ordering" },
      remote: { type: "boolean", description: "Pull over HTTP from ACCESSLEASE_ADAPTER_BASE_URL (allowlisted) instead of the local database" },
      workspace: { type: "string", value: "NAME|ID", description: "Workspace (default: the only one)" },
    },
  },
};

export const COMMAND_NAMES = Object.keys(COMMAND_SPECS);
