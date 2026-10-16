import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boolFlag, commandHelp, intFlag, parseCommand, stringFlag, type CommandSpec } from "../../../src/cli/args";
import { CliError, describeError, EXIT, exitCodeForError, finalExitCode, UnavailableError, UsageError } from "../../../src/cli/exit";
import { assertWritable, ensureOwnerOnlyDir, prepareOutputDir, readBoundedFile, writeOwnerOnlyFile } from "../../../src/cli/fs";

const spec: CommandSpec = {
  name: "demo",
  summary: "Run the demo",
  flags: {
    out: { type: "string", description: "Output directory", required: true, value: "DIR" },
    force: { type: "boolean", description: "Overwrite" },
    limit: { type: "string", description: "Limit" },
  },
  positionals: [{ name: "file", description: "Input file", required: false }],
};

describe("argument parser", () => {
  it("parses --flag value, --flag=value, switches and positionals", () => {
    const p = parseCommand("demo", ["--out", "o", "--force", "in.json", "--limit=5"], spec);
    expect(p).toEqual({ command: "demo", flags: { out: "o", force: true, limit: "5" }, positionals: ["in.json"], help: false });
    expect(stringFlag(p.flags, "out")).toBe("o");
    expect(stringFlag(p.flags, "force")).toBeUndefined();
    expect(boolFlag(p.flags, "force")).toBe(true);
    expect(boolFlag(p.flags, "limit")).toBe(false);
  });

  it("rejects unknown, repeated and malformed options with usage errors (exit 2)", () => {
    const bad = (args: string[], message: RegExp) => {
      try {
        parseCommand("demo", args, spec);
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).exitCode).toBe(EXIT.INVALID);
        expect((e as Error).message).toMatch(message);
      }
    };
    bad(["--out", "o", "--nope", "x"], /unknown option --nope/);
    bad(["--out", "o", "-x"], /unknown option -x/);
    bad(["--out", "o", "--out", "p"], /more than once/);
    bad(["--out"], /needs a value/);
    bad(["--out", "--force"], /needs a value/);
    bad(["--out="], /needs a value/);
    bad(["--out", "o", "--force=yes"], /does not take a value/);
    bad([], /needs --out/);
    bad(["--out", "o", "a", "b"], /unexpected argument b/);
  });

  it("treats everything after -- as positional and supports --help", () => {
    expect(parseCommand("demo", ["--out", "o", "--", "--force"], spec).positionals).toEqual(["--force"]);
    expect(parseCommand("demo", ["-"], { ...spec, flags: {} }).positionals).toEqual(["-"]);
    const h = parseCommand("demo", ["--help"], spec);
    expect(h.help).toBe(true);
    expect(parseCommand("demo", ["-h"], spec).help).toBe(true);
  });

  it("enforces required positionals", () => {
    const needs: CommandSpec = { name: "import", summary: "s", flags: {}, positionals: [{ name: "file", description: "d", required: true }] };
    expect(() => parseCommand("import", [], needs)).toThrow(/needs file/);
    expect(parseCommand("import", ["b.json"], needs).positionals).toEqual(["b.json"]);
    const none: CommandSpec = { name: "x", summary: "s", flags: {} };
    expect(() => parseCommand("x", ["extra"], none)).toThrow(/unexpected argument extra/);
    const anon: CommandSpec = { name: "y", summary: "s", flags: {}, positionals: [{ name: "a", description: "d", required: true }] };
    expect(() => parseCommand("y", [], anon)).toThrow(/needs a/);
  });

  it("validates integer flags", () => {
    const flags = { limit: "50" };
    expect(intFlag(flags, "limit", { min: 1, max: 100 }, 10)).toBe(50);
    expect(intFlag({}, "limit", { min: 1, max: 100 }, 10)).toBe(10);
    expect(() => intFlag({ limit: "abc" }, "limit", { min: 1, max: 100 }, 10)).toThrow(/whole number/);
    expect(() => intFlag({ limit: "0" }, "limit", { min: 1, max: 100 }, 10)).toThrow(/between 1 and 100/);
    expect(() => intFlag({ limit: "101" }, "limit", { min: 1, max: 100 }, 10)).toThrow(/between 1 and 100/);
  });

  it("renders help from the spec", () => {
    const text = commandHelp(spec);
    expect(text).toContain("accesslease demo [file]");
    expect(text).toContain("--out DIR");
    expect(text).toContain("(required)");
    expect(text).toContain("--force");
    expect(commandHelp({ name: "x", summary: "s", flags: { a: { type: "string", description: "d" } }, positionals: [{ name: "p", description: "d", required: true }] })).toContain("--a VALUE");
  });
});

describe("exit codes", () => {
  it("defines the five contract codes", () => {
    expect(EXIT).toEqual({ OK: 0, RUNTIME: 1, INVALID: 2, UNAVAILABLE: 3, UNCERTAIN: 4 });
  });

  it("never lets an uncertain state exit 0, and never hides a real error", () => {
    expect(finalExitCode(EXIT.OK, 0)).toBe(0);
    expect(finalExitCode(EXIT.OK, 1)).toBe(4);
    expect(finalExitCode(EXIT.RUNTIME, 3)).toBe(1);
    expect(finalExitCode(EXIT.UNAVAILABLE, 3)).toBe(3);
    expect(finalExitCode(EXIT.INVALID, 1)).toBe(2);
  });

  it("maps errors to codes", () => {
    expect(exitCodeForError(new UsageError("x"))).toBe(2);
    expect(exitCodeForError(new UnavailableError("x"))).toBe(3);
    expect(exitCodeForError(new CliError("x", EXIT.UNCERTAIN))).toBe(4);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(3);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "adapter_unavailable" }))).toBe(3);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "08006" }))).toBe(3);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "57P03" }))).toBe(3);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "3D000" }))).toBe(3);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "endpoint_refused" }))).toBe(2);
    expect(exitCodeForError(Object.assign(new Error("x"), { code: "bundle_invalid" }))).toBe(2);
    expect(exitCodeForError(Object.assign(new Error("x"), { status: 503 }))).toBe(3);
    expect(exitCodeForError(Object.assign(new Error("x"), { statusCode: 422 }))).toBe(2);
    expect(exitCodeForError(Object.assign(new Error("x"), { status: 409 }))).toBe(2);
    expect(exitCodeForError(Object.assign(new Error("x"), { exitCode: 2 }))).toBe(2);
    expect(exitCodeForError(Object.assign(new Error("x"), { exitCode: 3 }))).toBe(3);
    expect(exitCodeForError(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }) }))).toBe(3);
    expect(exitCodeForError(new Error("plain"))).toBe(1);
    expect(exitCodeForError("string")).toBe(1);
    expect(exitCodeForError(null)).toBe(1);
  });

  it("describes errors without stacks", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(new Error(""))).toBe("unexpected error");
    expect(describeError(42)).toBe("unexpected error");
  });
});

describe("owner-only filesystem helpers", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "al-cli-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const mode = (p: string) => statSync(p).mode & 0o777;

  it("creates and tightens evidence directories to 0700", () => {
    const base = tmp();
    const dir = ensureOwnerOnlyDir(join(base, "a", "b"));
    expect(mode(dir)).toBe(0o700);
    chmodSync(dir, 0o755);
    ensureOwnerOnlyDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("refuses symlinks, plain files and non-empty output directories unless forced", () => {
    const base = tmp();
    const real = join(base, "real");
    mkdirSync(real);
    symlinkSync(real, join(base, "link"));
    expect(() => ensureOwnerOnlyDir(join(base, "link"))).toThrow(/symbolic link/);
    expect(() => prepareOutputDir(join(base, "link"), false)).toThrow(/symbolic link/);
    writeFileSync(join(base, "file"), "x");
    expect(() => ensureOwnerOnlyDir(join(base, "file"))).toThrow(/not a directory/);
    writeFileSync(join(real, "existing"), "x");
    expect(() => prepareOutputDir(real, false)).toThrow(/not empty/);
    expect(prepareOutputDir(real, true)).toBe(real);
    expect(prepareOutputDir(join(base, "fresh"), false)).toBe(join(base, "fresh"));
    mkdirSync(join(base, "empty"));
    expect(prepareOutputDir(join(base, "empty"), false)).toBe(join(base, "empty"));
  });

  it("writes files atomically with 0600 and does not follow symlinks", () => {
    const base = tmp();
    const file = writeOwnerOnlyFile(join(base, "out", "report.html"), "<p>x</p>");
    expect(readFileSync(file, "utf8")).toBe("<p>x</p>");
    expect(mode(file)).toBe(0o600);
    expect(mode(join(base, "out"))).toBe(0o700);
    writeOwnerOnlyFile(file, new Uint8Array([1, 2, 3]));
    expect(readFileSync(file).length).toBe(3);
    symlinkSync(file, join(base, "out", "link"));
    expect(() => writeOwnerOnlyFile(join(base, "out", "link"), "x")).toThrow(/symbolic link/);
    expect(existsSync(join(base, "out", ".tmp"))).toBe(false);
  });

  it("guards overwrites and bounds input reads", () => {
    const base = tmp();
    const file = join(base, "in.json");
    writeFileSync(file, "12345");
    expect(() => assertWritable(file, false)).toThrow(/already exists/);
    expect(() => assertWritable(file, true)).not.toThrow();
    expect(() => assertWritable(join(base, "none"), false)).not.toThrow();
    expect(readBoundedFile(file, 5).toString()).toBe("12345");
    expect(() => readBoundedFile(file, 4)).toThrow(/larger than the 4 byte limit/);
    expect(() => readBoundedFile(join(base, "missing"), 10)).toThrow(/cannot read/);
    expect(() => readBoundedFile(base, 10)).toThrow(/not a regular file/);
  });
});
