import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLANTED_SECRETS, leakedSecrets } from "../helpers/secrets.js";
import { repoRoot, runToCompletion } from "../helpers/process.js";

/**
 * Operator-facing behavior of the packaged CLI that needs no database or network: help, exit codes, input validation before any
 * side effect, and error messages that never print secrets or stack traces. Needs `npm run build:server`.
 */
const cli = join(repoRoot, "dist/src/cli.js");
let dir: string;
const run = (args: string[], env: Record<string, string> = {}) => runToCompletion(process.execPath, [cli, ...args], env, { cwd: dir });
const clean = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;

describe("packaged CLI without a database", () => {
  beforeAll(() => {
    expect(existsSync(cli), "run `npm run build:server` first: the packaged CLI is what is tested").toBe(true);
    dir = mkdtempSync(join(tmpdir(), "al-cli-basics-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prints help listing every documented command and exits 0; an unknown command exits 2 with a useful message", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    for (const command of ["serve", "worker", "migrate", "bootstrap-admin", "demo", "export", "import", "verify-bundle", "report", "doctor", "events"]) expect(clean(help), command).toContain(command);
    const unknown = await run(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(clean(unknown)).toMatch(/unknown|usage|help/i);
    expect(clean(unknown)).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/); // no stack trace
  });

  it("refuses to start without configuration, says what to do, and never echoes a secret it was given", async () => {
    const missing = await run(["serve"]);
    expect(missing.code).toBe(2);
    expect(clean(missing)).toMatch(/configuration|ACCESSLEASE_/);
    const planted = await run(["migrate"], { ACCESSLEASE_DATABASE_URL: "postgres://user:pw@localhost:1/db", ACCESSLEASE_SECRET_KEY: PLANTED_SECRETS.githubToken });
    expect(planted.code).toBe(2);
    expect(leakedSecrets(clean(planted))).toEqual([]);
    expect(clean(planted)).not.toContain("pw@");
    const badUrl = await run(["migrate"], { ACCESSLEASE_DATABASE_URL: "postgres://user:Tr0ub4dor@localhost:1/db", ACCESSLEASE_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"), ACCESSLEASE_PROVIDER: "postgres-role" });
    expect(badUrl.code).toBe(2);
    expect(clean(badUrl)).not.toContain("Tr0ub4dor");
  });

  it("a database that cannot be reached is exit 3 (dependency unavailable), explicit and without the connection string", async () => {
    const down = await run(["migrate"], { ACCESSLEASE_DATABASE_URL: "postgres://al_user:Tr0ub4dor@127.0.0.1:1/db", ACCESSLEASE_SECRET_KEY: Buffer.alloc(32, 2).toString("base64") });
    expect(down.code, clean(down)).toBe(3);
    expect(clean(down)).not.toContain("Tr0ub4dor");
    const doctor = await run(["doctor"], { ACCESSLEASE_DATABASE_URL: "postgres://al_user:Tr0ub4dor@127.0.0.1:1/db", ACCESSLEASE_SECRET_KEY: Buffer.alloc(32, 2).toString("base64") });
    expect([1, 3]).toContain(doctor.code);
    expect(clean(doctor)).not.toContain("Tr0ub4dor");
  });

  it("bootstrap-admin validates its input before touching anything: missing flags, weak passwords and unsafe password files are exit 2", async () => {
    expect((await run(["bootstrap-admin"])).code).toBe(2);
    const weak = join(dir, "weak.txt");
    writeFileSync(weak, "short\n", { mode: 0o600 });
    const weakRun = await run(["bootstrap-admin", "--workspace", "w", "--email", "a@example.invalid", "--password-file", weak]);
    expect(weakRun.code).toBe(2);
    expect(clean(weakRun)).not.toContain("short\n");
    const open = join(dir, "open.txt");
    writeFileSync(open, `${PLANTED_SECRETS.passwordAssignment}-long-enough\n`);
    chmodSync(open, 0o644);
    const openRun = await run(["bootstrap-admin", "--workspace", "w", "--email", "a@example.invalid", "--password-file", open]);
    expect(openRun.code).toBe(2);
    expect(leakedSecrets(clean(openRun))).toEqual([]);
    expect((await run(["bootstrap-admin", "--workspace", "w", "--email", "a@example.invalid", "--password-file", join(dir, "missing.txt")])).code).toBe(2);
    expect((await run(["bootstrap-admin", "--workspace", "w", "--email", "a@example.invalid"], { ACCESSLEASE_BOOTSTRAP_PASSWORD: "short" })).code).toBe(2);
  });

  it("verify-bundle rejects unrecognised, unsupported, oversize, directory and missing inputs with exit 2 and a stable code, accepts nothing", async () => {
    const notBundle = await run(["verify-bundle", join(repoRoot, "fixtures/corrupt/bundle-not-a-bundle.txt")]);
    expect(notBundle.code).toBe(2);
    expect(clean(notBundle)).toMatch(/bundle_(malformed|truncated)/);
    const unsupported = await run(["verify-bundle", join(repoRoot, "fixtures/corrupt/bundle-unsupported-version.json"), "--json"]);
    expect(unsupported.code).toBe(2);
    expect(JSON.parse(unsupported.stdout)).toMatchObject({ ok: false, code: "bundle_unsupported_version" });
    const huge = join(dir, "huge.json");
    writeFileSync(huge, Buffer.alloc(26 * 1024 * 1024, 0x20));
    const hugeRun = await run(["verify-bundle", huge]);
    expect(hugeRun.code).toBe(2);
    expect(clean(hugeRun)).toMatch(/larger|limit|too large/i);
    expect((await run(["verify-bundle", dir])).code).toBe(2);
    expect((await run(["verify-bundle", join(dir, "nope.json")])).code).toBe(2);
    expect((await run(["verify-bundle"])).code).toBe(2);
  });

  it("demo and report refuse bad input up front: missing --out, unknown format, unreadable data", async () => {
    expect((await run(["demo"])).code).toBe(2);
    expect((await run(["report", "--format", "pdf", "--from-data", join(dir, "x.json")])).code).toBe(2);
    expect((await run(["report", "--from-data", join(dir, "absent.json")])).code).toBe(2);
    const occupied = join(dir, "occupied");
    writeFileSync(join(dir, "marker.txt"), "x");
    expect((await run(["demo", "--out", dir], { ACCESSLEASE_DATABASE_URL: "postgres://u:p@127.0.0.1:1/db", ACCESSLEASE_SECRET_KEY: Buffer.alloc(32, 3).toString("base64") })).code, "a non-empty output directory is refused without --force").toBe(2);
    void occupied;
  });
});
