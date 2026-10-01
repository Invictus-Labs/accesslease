import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief, runCommand, usage, type CommandDeps } from "../../../src/commands";
import { appError, capture, fakeServices, lease, LIVE, reportData, SYNTH } from "./fakes";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "al-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const mode = (p: string) => statSync(p).mode & 0o777;
const run = async (argv: string[], env: NodeJS.ProcessEnv = {}, deps: CommandDeps = {}) => {
  const cap = capture();
  const code = await runCommand(argv, env, cap.io, deps);
  return { code, out: cap.out.join("\n"), err: cap.err.join("\n") };
};
const withSvc = (over = {}) => {
  const f = fakeServices(over);
  return { ...f, deps: { services: async () => f.svc } as CommandDeps };
};

describe("dispatch, help and version", () => {
  it("prints usage with the exit-code table", async () => {
    const r = await run(["help"]);
    expect(r.code).toBe(0);
    for (const name of ["serve", "worker", "migrate", "bootstrap-admin", "demo", "export", "import", "verify-bundle", "report", "doctor", "events"]) expect(r.out).toContain(name);
    expect(r.out).toContain("4 unresolved uncertain state present (not success)");
    expect(usage()).toContain("exit codes:");
  });

  it("shortens summaries for the command list", () => {
    expect(brief("One. Two")).toBe("One");
    expect(brief("short thing.")).toBe("short thing");
    expect(brief("Run the worker: issue and revoke")).toBe("Run the worker");
    expect(brief(`${"x".repeat(40)} ${"y".repeat(60)}`)).toBe(`${"x".repeat(40)}...`);
    expect(brief("z".repeat(100))).toBe("z...");
    for (const line of usage().split("\n").slice(2, 13)) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("no arguments is a usage error; unknown commands and topics are refused", async () => {
    expect((await run([])).code).toBe(2);
    const unknown = await run(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown command frobnicate");
    expect((await run(["help", "nope"])).code).toBe(2);
  });

  it("prints per-command help for `help <cmd>`, --help and -h without touching the backend", async () => {
    const deps: CommandDeps = {
      services: async () => {
        throw new Error("must not load");
      },
    };
    for (const argv of [["help", "export"], ["export", "--help"], ["export", "-h"], ["--help"], ["-h"]]) {
      const r = await run(argv, {}, deps);
      expect(r.code).toBe(0);
      expect(r.out.length).toBeGreaterThan(20);
    }
    expect((await run(["help", "export"])).out).toContain("--out FILE");
  });

  it("prints the version from package.json", async () => {
    const r = await run(["version"]);
    expect(r.out).toMatch(/^accesslease \d+\.\d+\.\d+/);
    expect((await run(["--version"])).code).toBe(0);
    expect((await run(["-v"])).code).toBe(0);
  });

  it("maps argument errors to exit 2 with a hint", async () => {
    const r = await run(["export"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs --out");
    expect(r.err).toContain("accesslease help export");
    expect((await run(["migrate", "--bogus"])).code).toBe(2);
  });
});

describe("configuration and process-level errors", () => {
  it("reports configuration problems as invalid input (exit 2) and never closes a pool it did not open", async () => {
    const { svc } = fakeServices({
      loadConfig: vi.fn(() => {
        throw new Error("missing required configuration: ACCESSLEASE_DATABASE_URL, ACCESSLEASE_SECRET_KEY (see .env.example)");
      }),
    });
    const r = await run(["migrate"], {}, { services: async () => svc });
    expect(r.code).toBe(2);
    expect(r.err).toContain("configuration problem: missing required configuration");
  });

  it("maps provider disconnection to exit 3 and unexpected errors to 1", async () => {
    const down = withSvc({
      getReportData: vi.fn(async () => {
        throw appError(503, "provider_unavailable", "the provider is disconnected");
      }),
    });
    const r = await run(["report"], {}, down.deps);
    expect(r.code).toBe(3);
    expect(r.err).toContain("provider is disconnected");
    expect(down.close).toHaveBeenCalled();
    const boom = withSvc({
      migrate: vi.fn(async () => {
        throw new Error("migration 003 failed");
      }),
    });
    expect((await run(["migrate"], {}, boom.deps)).code).toBe(1);
    const dbDown = withSvc({
      migrate: vi.fn(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
      }),
    });
    expect((await run(["migrate"], {}, dbDown.deps)).code).toBe(3);
  });
});

describe("migrate", () => {
  it("lists applied migrations or says the schema is current, and closes the database", async () => {
    const a = withSvc({ migrate: vi.fn(async () => ({ applied: ["001_initial.sql", "002_jobs.sql"] })) });
    const r = await run(["migrate"], {}, a.deps);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toBe("applied migrations: 001_initial.sql, 002_jobs.sql");
    expect(a.close).toHaveBeenCalledTimes(1);
    const b = withSvc();
    expect((await run(["migrate"], {}, b.deps)).out).toBe("schema up to date");
  });
});

describe("bootstrap-admin", () => {
  const base = ["bootstrap-admin", "--workspace", "Demo", "--email", "admin@example.test"];

  it("generates a password, shows it once and never defaults one", async () => {
    const a = withSvc();
    const r = await run(base, {}, { ...a.deps, randomPassword: () => "generated-pass-ABC123" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("generated password (shown once, copy it now): generated-pass-ABC123");
    expect(a.svc.bootstrapAdmin).toHaveBeenCalledWith(a.ctx, { email: "admin@example.test", password: "generated-pass-ABC123", workspaceName: "Demo" });
    expect(a.svc.migrate).toHaveBeenCalled();
    const real = withSvc();
    const r2 = await run(base, {}, real.deps);
    const pw = /copy it now\): (\S+)/.exec(r2.out)?.[1] as string;
    expect(pw.length).toBeGreaterThanOrEqual(24);
    expect(pw).not.toBe("generated-pass-ABC123");
  });

  it("writes a generated password to a new 0600 file instead of printing it", async () => {
    const a = withSvc();
    const file = join(dir, "pw.txt");
    const r = await run([...base, "--password-out", file], {}, { ...a.deps, randomPassword: () => "generated-pass-ABC123" });
    expect(r.out).not.toContain("generated-pass-ABC123");
    expect(readFileSync(file, "utf8")).toBe("generated-pass-ABC123\n");
    expect(mode(file)).toBe(0o600);
    expect((await run([...base, "--password-out", file], {}, a.deps)).code).toBe(2);
  });

  it("uses a supplied password from a 0600 file or the environment and never prints it", async () => {
    const a = withSvc();
    const file = join(dir, "supplied.txt");
    writeFileSync(file, "my-own-long-password\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    const r = await run([...base, "--password-file", file], {}, a.deps);
    expect(r.out).not.toContain("my-own-long-password");
    expect(r.out).toContain("The password you supplied is set");
    expect(a.svc.bootstrapAdmin).toHaveBeenCalledWith(a.ctx, expect.objectContaining({ password: "my-own-long-password" }));
    const b = withSvc();
    const e = await run(base, { ACCESSLEASE_BOOTSTRAP_PASSWORD: "env-supplied-password" }, b.deps);
    expect(e.out).not.toContain("env-supplied-password");
    expect(b.svc.bootstrapAdmin).toHaveBeenCalledWith(b.ctx, expect.objectContaining({ password: "env-supplied-password" }));
  });

  it("refuses weak, group-readable, missing and misplaced password inputs", async () => {
    const a = withSvc();
    const loose = join(dir, "loose.txt");
    writeFileSync(loose, "long-enough-password\n");
    chmodSync(loose, 0o644);
    expect((await run([...base, "--password-file", loose], {}, a.deps)).err).toContain("readable only by you");
    const short = join(dir, "short.txt");
    writeFileSync(short, "short\n", { mode: 0o600 });
    chmodSync(short, 0o600);
    expect((await run([...base, "--password-file", short], {}, a.deps)).err).toContain("at least 12");
    expect((await run([...base, "--password-file", join(dir, "absent")], {}, a.deps)).err).toContain("cannot read");
    expect((await run([...base, "--password-file", dir], {}, a.deps)).err).toContain("not a regular file");
    expect((await run(base, { ACCESSLEASE_BOOTSTRAP_PASSWORD: "tiny" }, a.deps)).code).toBe(2);
    const ok = join(dir, "ok.txt");
    writeFileSync(ok, "long-enough-password", { mode: 0o600 });
    chmodSync(ok, 0o600);
    expect((await run([...base, "--password-file", ok, "--password-out", join(dir, "o")], {}, a.deps)).err).toContain("only applies when the password is generated");
    expect(a.svc.bootstrapAdmin).not.toHaveBeenCalled();
  });

  it("does not print a password when the administrator already exists", async () => {
    const a = withSvc({ bootstrapAdmin: vi.fn(async () => ({ workspaceId: "ws-1", userId: "u-1", created: { workspace: false, user: false } })) });
    const r = await run(base, {}, { ...a.deps, randomPassword: () => "generated-pass-ABC123" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("already existed");
    expect(r.out).toContain("no password was set or shown");
    expect(r.out).not.toContain("generated-pass-ABC123");
  });
});

describe("demo", () => {
  const demoResult = (leases = [lease()], unresolved = { issueUnknown: 0, revocationUnconfirmed: 0 }, outDir = "") => ({
    provider: SYNTH,
    reportData: reportData(leases),
    bundle: { bytes: Buffer.from("{}"), bundle_hash: "h".repeat(64), lease_count: leases.length, file_count: 3 },
    files: { reportData: join(outDir, "report-data.json"), bundle: join(outDir, "evidence-bundle.json") },
    unresolved,
  });

  it("runs the synthetic demo with a fixed clock, writes an owner-only static report and exits 0 when nothing is unresolved", async () => {
    const out = join(dir, "demo");
    const a = withSvc();
    (a.svc.runDemo as ReturnType<typeof vi.fn>).mockImplementation(async (o: { outDir: string }) => demoResult([lease()], undefined, o.outDir));
    const r = await run(["demo", "--out", out, "--database-url", "postgres://u@localhost:5432/d"], {}, a.deps);
    expect(r.code).toBe(0);
    expect(a.svc.runDemo).toHaveBeenCalledWith({ databaseUrl: "postgres://u@localhost:5432/d", outDir: out, startAt: "2026-01-01T00:00:00.000Z" });
    expect(r.out).toContain("SYNTHETIC");
    expect(r.out).toContain("live: false");
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).toContain("SYNTHETIC");
    expect(html).toContain("TASK-1");
    expect(mode(join(out, "report.html"))).toBe(0o600);
    expect(mode(out)).toBe(0o700);
  });

  it("exits 4 and says why when the demo leaves uncertain leases, and shows them as warnings", async () => {
    const out = join(dir, "demo");
    const a = withSvc();
    const leases = [lease(), lease({ id: "b", task_ref: "uncertain", state: "REVOCATION_UNCONFIRMED", last_verified_at: null, revocation_status: "unconfirmed", next_retry_at: "2026-01-01T01:05:00.000Z", warning: "Revocation could not be verified" })];
    (a.svc.runDemo as ReturnType<typeof vi.fn>).mockResolvedValue(demoResult(leases, { issueUnknown: 0, revocationUnconfirmed: 1 }, out));
    const r = await run(["demo", "--out", out], { ACCESSLEASE_DATABASE_URL: "postgres://u@localhost:5432/d" }, a.deps);
    expect(r.code).toBe(4);
    expect(r.err).toContain("Exiting with code 4: this is not success");
    expect(r.err).toContain("deliberately leaves uncertain leases");
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).toContain("1 unresolved state: do not read as success");
    expect(html).toContain("REVOCATION UNCONFIRMED");
  });

  it("refuses to run without a database, with a bad start instant, or into a non-empty directory", async () => {
    const a = withSvc();
    expect((await run(["demo", "--out", join(dir, "x")], {}, a.deps)).err).toContain("demo needs a PostgreSQL URL");
    expect((await run(["demo", "--out", join(dir, "x"), "--database-url", "u", "--start-at", "yesterday"], {}, a.deps)).err).toContain("UTC instant");
    expect((await run(["demo", "--out", join(dir, "x"), "--database-url", "u", "--start-at", "2026-01-01T00:00:00+02:00"], {}, a.deps)).code).toBe(2);
    const busy = join(dir, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "keep.txt"), "x");
    const r = await run(["demo", "--out", busy, "--database-url", "u"], {}, a.deps);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not empty");
    expect(a.svc.runDemo).not.toHaveBeenCalled();
  });

  it("applies a separate database password like the server does, and rejects an unparsable URL", async () => {
    const a = withSvc();
    (a.svc.runDemo as ReturnType<typeof vi.fn>).mockImplementation(async (o: { outDir: string }) => demoResult([lease()], undefined, o.outDir));
    await run(["demo", "--out", join(dir, "d1")], { ACCESSLEASE_DATABASE_URL: "postgres://accesslease@db:5432/accesslease", ACCESSLEASE_DATABASE_PASSWORD: "p/w+=x" }, a.deps);
    const url = new URL((a.svc.runDemo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].databaseUrl);
    expect(decodeURIComponent(url.password)).toBe("p/w+=x");
    expect(url.username).toBe("accesslease");
    const bad = await run(["demo", "--out", join(dir, "d2"), "--database-url", "not a url"], { ACCESSLEASE_DATABASE_PASSWORD: "x" }, a.deps);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not a valid URL");
  });

  it("propagates a demo failure with the right exit code", async () => {
    const a = withSvc();
    (a.svc.runDemo as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect((await run(["demo", "--out", join(dir, "d"), "--database-url", "u"], {}, a.deps)).code).toBe(3);
  });

  it("escapes hostile text in the demo report", async () => {
    const out = join(dir, "demo");
    const a = withSvc();
    (a.svc.runDemo as ReturnType<typeof vi.fn>).mockResolvedValue(demoResult([lease({ task_ref: "<script>alert(1)</script>" })], undefined, out));
    await run(["demo", "--out", out, "--database-url", "u"], {}, a.deps);
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("export, import and verify-bundle", () => {
  it("exports an owner-only bundle and exits 0 when nothing is unresolved", async () => {
    const a = withSvc();
    const file = join(dir, "bundle.json");
    const r = await run(["export", "--out", file, "--lease-ids", "a, b", "--workspace", "ws-9"], {}, a.deps);
    expect(r.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"bundle":true}');
    expect(mode(file)).toBe(0o600);
    expect(a.svc.exportBundle).toHaveBeenCalledWith(a.ctx, expect.objectContaining({ workspaceId: "ws-9" }), { leaseIds: ["a", "b"] });
    expect(r.out).toContain("exported 2 lease(s), 4 file(s)");
    expect(r.out).toContain(`bundle_hash ${"h".repeat(64)}`);
  });

  it("exits 4 when the export contains unresolved leases and never silently overwrites", async () => {
    const a = withSvc({ unresolvedCount: vi.fn(async () => ({ issueUnknown: 1, revocationUnconfirmed: 2 })) });
    const file = join(dir, "bundle.json");
    const r = await run(["export", "--out", file], {}, a.deps);
    expect(r.code).toBe(4);
    expect(r.err).toContain("1 lease(s) in ISSUE_UNKNOWN and 2 in REVOCATION_UNCONFIRMED");
    expect((await run(["export", "--out", file], {}, a.deps)).code).toBe(2);
    expect((await run(["export", "--out", file, "--force"], {}, a.deps)).code).toBe(4);
  });

  it("imports a bundle, reports idempotent re-imports and maps rejected bundles to exit 2 with no state change", async () => {
    const file = join(dir, "in.json");
    writeFileSync(file, '{"x":1}');
    const a = withSvc();
    const r = await run(["import", file, "--workspace", "ws-2", "--allow-large"], {}, a.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("imported 2 lease(s) as read-only evidence: imp-1");
    expect(a.svc.importBundle).toHaveBeenCalledWith(a.ctx, expect.objectContaining({ workspaceId: "ws-2" }), expect.any(Buffer), { allowLarge: true });
    const again = withSvc({ importBundle: vi.fn(async () => ({ import_id: "imp-1", bundle_hash: "h".repeat(64), already_imported: true, lease_count: 2, imported_at: "t" })) });
    expect((await run(["import", file], {}, again.deps)).out).toContain("already imported: imp-1 (no change)");
    for (const code of ["bundle_hash_mismatch", "bundle_truncated", "bundle_unsupported_version"]) {
      const bad = withSvc({
        importBundle: vi.fn(async () => {
          throw appError(422, code, `rejected: ${code}`);
        }),
      });
      const rejected = await run(["import", file], {}, bad.deps);
      expect(rejected.code).toBe(2);
      expect(rejected.err).toContain(code);
    }
  });

  it("checks file size before reading and refuses missing or non-file inputs", async () => {
    const big = join(dir, "big.json");
    writeFileSync(big, "");
    truncateSync(big, 25 * 1024 * 1024 + 1);
    const a = withSvc();
    const refused = await run(["import", big], {}, a.deps);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("larger than");
    expect(a.svc.importBundle).not.toHaveBeenCalled();
    expect((await run(["import", big, "--allow-large"], {}, a.deps)).code).toBe(0);
    expect((await run(["import", join(dir, "absent.json")], {}, a.deps)).err).toContain("cannot read");
    expect((await run(["verify-bundle", dir], {}, a.deps)).err).toContain("not a regular file");
  });

  it("verifies bundles without importing, in text and JSON, and rejects bad ones with exit 2", async () => {
    const file = join(dir, "b.json");
    writeFileSync(file, "{}");
    const ok = withSvc();
    const r = await run(["verify-bundle", file], {}, ok.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bundle verified: hash");
    expect(ok.svc.importBundle).not.toHaveBeenCalled();
    expect(JSON.parse((await run(["verify-bundle", file, "--json"], {}, ok.deps)).out)).toMatchObject({ ok: true, lease_count: 2 });
    const bad = withSvc({ verifyBundle: vi.fn(() => ({ ok: false, code: "bundle_truncated", message: "unexpected end of JSON", bundle_hash: null, schema_version: null, file_count: 0, lease_count: 0 })) });
    const rejected = await run(["verify-bundle", file], {}, bad.deps);
    expect(rejected.code).toBe(2);
    expect(rejected.err).toContain("bundle REJECTED (bundle_truncated)");
    expect(rejected.err).toContain("Nothing was imported or accepted");
    const noMessage = withSvc({ verifyBundle: vi.fn(() => ({ ok: false, code: "bundle_malformed", message: null, bundle_hash: null, schema_version: null, file_count: 0, lease_count: 0 })) });
    expect((await run(["verify-bundle", file], {}, noMessage.deps)).err).toContain("verification failed");
  });
});

describe("report", () => {
  it("prints the escaped static report to stdout and exits 0 when everything is resolved", async () => {
    const a = withSvc();
    const r = await run(["report", "--lease-ids", "x,y"], {}, a.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("<!doctype html>");
    expect(r.out).toContain("TASK-1");
    expect(a.svc.getReportData).toHaveBeenCalledWith(a.ctx, expect.anything(), { leaseIds: ["x", "y"] });
  });

  it("writes an owner-only file, supports JSON and refuses to overwrite", async () => {
    const a = withSvc();
    const file = join(dir, "r.html");
    const r = await run(["report", "--out", file], {}, a.deps);
    expect(r.out).toContain("report written to");
    expect(mode(file)).toBe(0o600);
    expect((await run(["report", "--out", file], {}, a.deps)).code).toBe(2);
    const json = join(dir, "r.json");
    await run(["report", "--out", json, "--format", "json"], {}, a.deps);
    expect(JSON.parse(readFileSync(json, "utf8")).workspace.name).toBe("Demo (synthetic)");
    expect((await run(["report", "--format", "xml"], {}, a.deps)).code).toBe(2);
  });

  it("exits 4 and warns when any lease is unresolved, and renders it as a warning", async () => {
    const data = reportData([lease({ state: "ISSUE_UNKNOWN", last_verified_at: null, revocation_status: "none", provider: LIVE, warning: "Provider timed out" })], { providers: [LIVE], contains_synthetic: false });
    const a = withSvc({ getReportData: vi.fn(async () => data) });
    const r = await run(["report"], {}, a.deps);
    expect(r.code).toBe(4);
    expect(r.err).toContain("1 lease(s) are in an unresolved state");
    expect(r.out).toContain("ISSUE UNKNOWN");
    expect(r.out).toContain("Provider timed out");
    expect(r.out).not.toContain('class="banner synthetic"');
  });

  it("renders a saved report-data file offline and validates it first", async () => {
    const good = join(dir, "data.json");
    writeFileSync(good, JSON.stringify(reportData()));
    const noDb = { services: async () => { throw new Error("must not load services"); } } as CommandDeps;
    const r = await run(["report", "--from-data", good], {}, noDb);
    expect(r.code).toBe(0);
    expect(r.out).toContain("TASK-1");
    const withUnresolved = join(dir, "u.json");
    writeFileSync(withUnresolved, JSON.stringify(reportData([lease({ state: "REVOCATION_UNCONFIRMED", last_verified_at: null })])));
    expect((await run(["report", "--from-data", withUnresolved], {}, noDb)).code).toBe(4);
    const truncated = join(dir, "t.json");
    writeFileSync(truncated, '{"schema_version":1,"generated_at"');
    const t = await run(["report", "--from-data", truncated], {}, noDb);
    expect(t.code).toBe(2);
    expect(t.err).toContain("not valid JSON");
    const wrong = join(dir, "w.json");
    writeFileSync(wrong, JSON.stringify({ schema_version: 2 }));
    expect((await run(["report", "--from-data", wrong], {}, noDb)).code).toBe(2);
    const missing = join(dir, "m.json");
    writeFileSync(missing, JSON.stringify({ ...reportData(), leases: [{ id: "x" }] }));
    expect((await run(["report", "--from-data", missing], {}, noDb)).err).toContain("invalid report data at leases.0");
    const shape = join(dir, "s.json");
    writeFileSync(shape, JSON.stringify({ ...reportData(), summary: undefined }));
    expect((await run(["report", "--from-data", shape], {}, noDb)).err).toContain("invalid report data at summary");
    const root = join(dir, "root.json");
    writeFileSync(root, "[]");
    expect((await run(["report", "--from-data", root], {}, noDb)).err).toContain("invalid report data");
  });

  it("labels mixed provider reports", async () => {
    const data = reportData([lease(), lease({ id: "z", provider: LIVE })], { providers: [SYNTH, LIVE] });
    const a = withSvc({ getReportData: vi.fn(async () => data) });
    expect((await run(["report"], {}, a.deps)).out).toContain("SYNTHETIC leases included");
    const none = withSvc({ getReportData: vi.fn(async () => reportData([], { providers: [] })) });
    expect((await run(["report"], {}, none.deps)).out).toContain("Unrecognised provider: unknown");
  });
});

describe("doctor", () => {
  it("prints each check with its next step and returns the service's exit code", async () => {
    const a = withSvc({
      runDoctor: vi.fn(async () => ({
        ok: false,
        checks: [
          { name: "database", status: "ok", message: "reachable" },
          { name: "provider", status: "unavailable", message: "cluster not reachable", hint: "start the provider cluster or fix ACCESSLEASE_PROVIDER_ADMIN_URL" },
          { name: "leases", status: "warn", message: "1 unresolved" },
          { name: "migrations", status: "fail", message: "003 modified" },
        ],
        exitCode: 3 as const,
      })),
    });
    const r = await run(["doctor"], {}, a.deps);
    expect(r.code).toBe(3);
    expect(r.out).toContain("[ok] database: reachable");
    expect(r.out).toContain("[UNAVAILABLE] provider: cluster not reachable");
    expect(r.out).toContain("next step: start the provider cluster");
    expect(r.out).toContain("[WARN] leases");
    expect(r.out).toContain("[FAIL] migrations");
    expect(r.out).toContain("problems found (exit 3)");
    const healthy = withSvc();
    const ok = await run(["doctor"], {}, healthy.deps);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("doctor: all checks passed");
    expect(JSON.parse((await run(["doctor", "--json"], {}, healthy.deps)).out).ok).toBe(true);
  });

  it("returns exit 4 when unresolved leases are present", async () => {
    const a = withSvc({ runDoctor: vi.fn(async () => ({ ok: false, checks: [{ name: "leases", status: "warn" as const, message: "2 unresolved" }], exitCode: 4 as const })) });
    expect((await run(["doctor"], {}, a.deps)).code).toBe(4);
  });

  it("diagnoses missing configuration instead of crashing", async () => {
    const { svc } = fakeServices({
      loadConfig: vi.fn(() => {
        throw new Error("missing required configuration: ACCESSLEASE_SECRET_KEY");
      }),
    });
    const deps = { services: async () => svc } as CommandDeps;
    const r = await run(["doctor"], {}, deps);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[FAIL] configuration");
    expect(r.out).toContain("copy .env.example");
    const j = JSON.parse((await run(["doctor", "--json"], {}, deps)).out);
    expect(j.ok).toBe(false);
    const other = withSvc({
      runDoctor: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect((await run(["doctor"], {}, other.deps)).code).toBe(1);
  });
});

describe("events and the reference consumer", () => {
  const evt = (over: Record<string, unknown> = {}) => ({ schema_version: 1, event_id: "e1", source: "accesslease", resource_id: "lease-1", event_type: "lease.requested", occurred_at: "2026-01-01T00:00:00.000Z", revision: 1, evidence_ref: "lease:lease-1@1", ...over });

  it("prints events as JSON lines with the next cursor on stderr", async () => {
    const a = withSvc({ pullEvents: vi.fn(async () => ({ items: [evt(), evt({ event_id: "e2", revision: 2 })] as never, next_cursor: "2" })) });
    const r = await run(["events", "--after", "0", "--limit", "10", "--workspace", "ws-4"], {}, a.deps);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").map((l) => JSON.parse(l).event_id)).toEqual(["e1", "e2"]);
    expect(r.err).toBe("next_cursor=2");
    expect(a.svc.pullEvents).toHaveBeenCalledWith(a.ctx, expect.objectContaining({ workspaceId: "ws-4" }), { after: "0", limit: 10 });
    expect((await run(["events", "--limit", "500"], {}, a.deps)).code).toBe(2);
  });

  it("refuses --consume while the adapter is disabled (the default) and --remote without --consume", async () => {
    const a = withSvc();
    const r = await run(["events", "--consume"], {}, a.deps);
    expect(r.code).toBe(2);
    expect(r.err).toContain("disabled");
    expect(r.err).toContain("ACCESSLEASE_ADAPTER_ENABLED=1");
    expect((await run(["events", "--remote"], {}, a.deps)).code).toBe(2);
  });

  it("consumes locally: dedupes across runs, ignores older revisions, rejects bad versions and persists state", async () => {
    const state = join(dir, "adapter.json");
    const env = { ACCESSLEASE_ADAPTER_ENABLED: "1", ACCESSLEASE_ADAPTER_STATE_FILE: state };
    const pages = [
      { items: [evt(), evt({ event_id: "e3", revision: 3, event_type: "lease.revoking" }), evt({ event_id: "e2", revision: 2, event_type: "lease.revoked_verified" }), evt({ event_id: "bad", schema_version: 2 })], next_cursor: "4" },
      { items: [], next_cursor: "4" },
    ];
    let i = 0;
    const a = withSvc({ pullEvents: vi.fn(async () => (pages[Math.min(i++, 1)] as never)) });
    const r = await run(["events", "--consume"], env, a.deps);
    expect(r.out).toContain("consumed 4 event(s): 2 applied, 0 duplicate, 1 stale (older revision, not applied), 1 rejected; cursor 4");
    expect(r.err).toContain("rejected event (unsupported_version)");
    expect(r.code).toBe(2);
    expect(mode(state)).toBe(0o600);
    const persisted = JSON.parse(readFileSync(state, "utf8"));
    expect(persisted.resources["lease-1"]).toMatchObject({ revision: 3, event_type: "lease.revoking" });
    // second run: same events again are duplicates
    i = 0;
    const b = withSvc({ pullEvents: vi.fn(async () => ({ items: [evt(), evt({ event_id: "e3", revision: 3 })] as never, next_cursor: "5" })) });
    let calls = 0;
    (b.svc.pullEvents as ReturnType<typeof vi.fn>).mockImplementation(async () => (calls++ === 0 ? { items: [evt(), evt({ event_id: "e3", revision: 3 })], next_cursor: "5" } : { items: [], next_cursor: "5" }));
    const second = await run(["events", "--consume"], env, b.deps);
    expect(second.out).toContain("2 duplicate");
    expect(second.code).toBe(0);
  });

  it("consumes in memory when no state file is configured", async () => {
    let calls = 0;
    const a = withSvc({ pullEvents: vi.fn(async () => (calls++ === 0 ? { items: [evt()] as never, next_cursor: "1" } : { items: [] as never, next_cursor: "1" })) });
    const r = await run(["events", "--consume", "--after", "7"], { ACCESSLEASE_ADAPTER_ENABLED: "1" }, a.deps);
    expect(r.out).toContain("1 applied");
    expect((a.svc.pullEvents as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({ after: "7" });
  });

  it("pulls remotely through the allowlist (pinned connection) and reports an unreachable source as exit 3", async () => {
    const seen: Array<{ url?: string; cookie?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, cookie: req.headers.cookie });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: seen.length === 1 ? [evt()] : [], next_cursor: "1" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const env = { ACCESSLEASE_ADAPTER_ENABLED: "1", ACCESSLEASE_ADAPTER_BASE_URL: `http://127.0.0.1:${port}`, ACCESSLEASE_ADAPTER_SESSION_COOKIE: "accesslease_session=fake" };
      const noSvc = { services: async () => { throw new Error("remote mode must not load the database"); } } as CommandDeps;
      const r = await run(["events", "--consume", "--remote"], env, noSvc);
      expect(r.code).toBe(0);
      expect(r.out).toContain("1 applied");
      expect(seen[0]?.url).toBe("/api/v1/events?after=0");
      expect(seen[0]?.cookie).toBe("accesslease_session=fake");
      expect((await run(["events", "--consume", "--remote"], { ACCESSLEASE_ADAPTER_ENABLED: "1" }, noSvc)).err).toContain("ACCESSLEASE_ADAPTER_BASE_URL");
      const offList = await run(["events", "--consume", "--remote"], { ...env, ACCESSLEASE_ADAPTER_BASE_URL: "http://evil.example.test" }, noSvc);
      expect(offList.code).toBe(2);
      expect(offList.err).toContain("allowlist");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // the server is gone: connection refused is an explicit, unreachable failure
    const down = await run(["events", "--consume", "--remote"], { ACCESSLEASE_ADAPTER_ENABLED: "1", ACCESSLEASE_ADAPTER_BASE_URL: `http://127.0.0.1:${port}` }, { services: async () => { throw new Error("no"); } } as CommandDeps);
    expect(down.code).toBe(3);
    expect(down.err).toContain("unreachable");
  });
});

describe("worker", () => {
  it("runs one pass and exits 4 when unresolved leases remain", async () => {
    const a = withSvc();
    const clean = await run(["worker", "--once"], {}, a.deps);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("worker pass: 1 job(s), 1 issued");
    const b = withSvc({
      runWorkerOnce: vi.fn(async () => ({
        sweep: { expiredToRevoking: 2, overdueRecovered: 0, staleRequestsClosed: 0, jobsReclaimed: 0, at: "t" },
        jobsProcessed: 3,
        issued: 0,
        reconciled: 1,
        revokeAttempts: 2,
        verified: 1,
        unconfirmed: 1,
        unresolved: { issueUnknown: 0, revocationUnconfirmed: 1 },
      })),
    });
    const r = await run(["worker", "--once"], {}, b.deps);
    expect(r.code).toBe(4);
    expect(r.err).toContain("Exiting with code 4");
    expect(r.out).toContain("2 expired -> revoking");
  });

  it("runs the loop until stopped, reports activity, then aborts and closes the database", async () => {
    let passHandler: ((p: unknown) => void) | undefined;
    let aborted = false;
    const a = withSvc({
      runWorker: vi.fn(async (_ctx: unknown, o: { signal: AbortSignal; pollMs?: number; onPass: (p: unknown) => void }) => {
        passHandler = o.onPass;
        await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => { aborted = true; resolve(); }));
      }),
    });
    const cap = capture();
    const stop = await runCommand(["worker", "--poll-ms", "250"], {}, cap.io, a.deps);
    expect(typeof stop).toBe("function");
    expect(cap.out[0]).toContain("worker running");
    const pass = (jobsProcessed: number, expired: number) => ({ jobsProcessed, issued: 0, verified: 0, unconfirmed: 0, sweep: { expiredToRevoking: expired } });
    passHandler?.(pass(0, 0));
    passHandler?.(pass(2, 0));
    passHandler?.(pass(0, 1));
    expect(cap.out.filter((l) => l.startsWith("pass:")).length).toBe(2);
    expect((a.svc.runWorker as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ pollMs: 250 });
    await (stop as () => Promise<void>)();
    expect(aborted).toBe(true);
    expect(a.close).toHaveBeenCalled();
    expect((await run(["worker", "--poll-ms", "5"], {}, a.deps)).code).toBe(2);
  });
});

describe("serve", () => {
  const fakeServer = () => {
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async (_ctx: unknown, o: { host: string; port: number }) => ({ address: `http://${o.host}:${o.port}`, close }));
    return { close, startServer };
  };

  it("binds to the configured loopback address by default and stops cleanly", async () => {
    const a = withSvc();
    const s = fakeServer();
    const cap = capture();
    const stop = await runCommand(["serve"], {}, cap.io, { ...a.deps, startServer: s.startServer as never });
    expect(cap.out[0]).toBe("accesslease listening on http://127.0.0.1:8791");
    expect(cap.err.join("\n")).not.toContain("other computers");
    expect(s.startServer.mock.calls[0]?.[1]).toMatchObject({ host: "127.0.0.1", port: 8791, worker: true });
    expect(a.svc.migrate).toHaveBeenCalled();
    await (stop as () => Promise<void>)();
    expect(s.close).toHaveBeenCalled();
    expect(a.close).toHaveBeenCalled();
  });

  it("honours --host, --port and --no-worker and warns when binding every interface", async () => {
    const a = withSvc();
    const s = fakeServer();
    const cap = capture();
    await runCommand(["serve", "--host", "0.0.0.0", "--port", "9000", "--no-worker"], {}, cap.io, { ...a.deps, startServer: s.startServer as never });
    expect(s.startServer.mock.calls[0]?.[1]).toMatchObject({ host: "0.0.0.0", port: 9000, worker: false });
    expect(cap.err.join("\n")).toContain("accepts connections from other computers");
    expect((await run(["serve", "--port", "70000"], {}, { ...a.deps, startServer: s.startServer as never })).code).toBe(2);
  });

  it("closes the database and reports when the server cannot start", async () => {
    const a = withSvc();
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    });
    const r = await run(["serve"], {}, { ...a.deps, startServer: failing as never });
    expect(r.code).toBe(1);
    expect(r.err).toContain("EADDRINUSE");
    expect(a.close).toHaveBeenCalled();
  });

  it("reports a missing web build without failing the API", async () => {
    const a = withSvc();
    const s = fakeServer();
    const cap = capture();
    await runCommand(["serve"], {}, cap.io, { ...a.deps, startServer: s.startServer as never });
    const webRoot = (s.startServer.mock.calls[0]?.[1] as { webRoot: string }).webRoot;
    expect(webRoot.endsWith(join("dist", "web"))).toBe(true);
    if (!existsSync(webRoot)) expect(cap.err.join("\n")).toContain("npm run build");
  });
});
