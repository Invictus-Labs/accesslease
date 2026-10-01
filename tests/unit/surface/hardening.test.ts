import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeOwnerOnlyFile } from "../../../src/cli/fs";
import { redactText, REDACTED } from "../../../src/report/redact";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "al-hard-"));
  dirs.push(d);
  return d;
};
const mode = (p: string) => statSync(p).mode & 0o777;

describe("F-003: output files do not change an existing parent directory", () => {
  it("leaves a shared 755 directory alone and tightens only the file", () => {
    const base = tmp();
    const shared = join(base, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    writeFileSync(join(shared, "other.txt"), "someone else's file");
    writeOwnerOnlyFile(join(shared, "report.html"), "x");
    expect(mode(shared)).toBe(0o755);
    expect(mode(join(shared, "report.html"))).toBe(0o600);
  });

  it("creates missing parents owner-only and refuses a file where a directory is expected", () => {
    const base = tmp();
    writeOwnerOnlyFile(join(base, "a", "b", "out.json"), "x");
    expect(mode(join(base, "a"))).toBe(0o700);
    expect(mode(join(base, "a", "b"))).toBe(0o700);
    writeFileSync(join(base, "plain"), "x");
    expect(() => writeOwnerOnlyFile(join(base, "plain", "out.json"), "x")).toThrow(/not a directory/);
    expect(existsSync(join(base, "plain", "out.json"))).toBe(false);
  });
});

describe("F-004: redaction covers token shapes and whole assignment values", () => {
  const planted = [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-" + "000000000000-000000000000-abcdefghijklmnopqrstuvwx",
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlLWV4YW1wbGU",
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
  ];

  it("removes every well-known token shape, alone or inside prose", () => {
    for (const token of planted) {
      expect(redactText(token), token).not.toContain(token);
      const prose = redactText(`please use ${token} for the job, thanks`);
      expect(prose).not.toContain(token);
      expect(prose).toContain("please use");
      expect(prose).toContain("thanks");
    }
  });

  it("lets an assignment value run to whitespace, quote, comma or semicolon, not just to an ampersand", () => {
    expect(redactText("password=Tr0ub4dor&3-example")).toBe(`password=${REDACTED}`);
    expect(redactText("db password=a&b&c, next field")).toBe(`db password=${REDACTED}, next field`);
    expect(redactText('{"api_key": "abc&def"}')).toBe(`{"api_key": ${REDACTED}}`);
    expect(redactText("secret=one;two")).toBe(`secret=${REDACTED};two`);
    expect(redactText("close TASK-1 for contractor-a")).toBe("close TASK-1 for contractor-a");
  });

  it("keeps the existing credential patterns", () => {
    expect(redactText("postgres://admin:hunter2@localhost/db")).toBe(`postgres://${REDACTED}@localhost/db`);
    expect(redactText("Bearer abcdefghijklmnop")).toContain(REDACTED);
    expect(redactText("-----BEGIN PRIVATE KEY-----\nMIIFAKE\n-----END PRIVATE KEY-----")).toBe(REDACTED);
    expect(redactText("PLANTED_SECRET_TOKEN_9f3a")).not.toContain("PLANTED");
  });
});
