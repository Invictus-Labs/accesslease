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

  it("redacts prefixed and suffixed credential keys (db_password=, access_token=, PGPASSWORD=)", () => {
    for (const key of ["db_password", "DB_PASSWORD", "PGPASSWORD", "access_token", "refresh_token", "api_key_v2", "x-auth-token"]) {
      expect(redactText(`${key}=hunter2xyz9 tail`), key).toBe(`${key}=${REDACTED} tail`);
    }
    expect(redactText("author: Bob")).toBe("author: Bob");
    for (const scope of ["pg:app.secrets_vault:select", "pg:app.api_tokens:insert"]) expect(redactText(scope), scope).toBe(scope);
    for (const text of ["password=select-Tr0ub4dor", "access_token=read.only.k3y9x", "secret: write-once-v4lue", "password=select"]) expect(redactText(text), text).toContain(REDACTED);
  });

  it("treats only real scope syntax as a scope, honours escaped quotes and keeps punctuation before a URL scheme", () => {
    for (const text of ["password: select", "db_password:read", "token: read"]) expect(redactText(text), text).toContain(REDACTED);
    expect(redactText('{"password":"ab\\"cd"}')).toBe(`{"password":${REDACTED}}`);
    for (const text of ["-https://u:pw9x@h/x", ".https://u:pw9x@h/x"]) expect(redactText(text), text).not.toContain("pw9x");
    expect(redactText("grant pg:app.secrets_vault:select, then stop")).toBe("grant pg:app.secrets_vault:select, then stop");
    for (const text of ["pg:app.secrets_vault:select,pg:app.api_tokens:insert", '{"scopes":["pg:app.secrets_vault:select"]}', "(pg:app.secrets_vault:select)"]) expect(redactText(text), text).toBe(text);
    expect(redactText("pg:a.b_token:select,secret:x9y8z7")).not.toContain("x9y8z7");
    for (const text of ["AWS_SECRET_ACCESS_KEY=Zq9xV4lu3k", '"AWS_SECRET_ACCESS_KEY":"Zq9xV4lu3k"', "STRIPE_SECRET_KEY: Zq9xV4lu3k"]) expect(redactText(text), text).not.toContain("Zq9xV4lu3k");
  });

  it("scans long unbroken input in linear time (no backtracking blow-up in the key pattern)", () => {
    // About 300 KB of key-like text without a separator: the earlier lazy-prefix pattern took several seconds here.
    for (const text of ["password_".repeat(33_000) + "x", "tokentoken".repeat(30_000) + "=", "a_".repeat(150_000), "token-".repeat(50_000) + "!", "secret-".repeat(43_000) + "=", "canary-".repeat(43_000)]) {
      const started = performance.now();
      redactText(text);
      expect(performance.now() - started, `${text.slice(0, 12)}… x${text.length}`).toBeLessThan(1000);
    }
  });

  it("keeps the existing credential patterns", () => {
    expect(redactText("postgres://admin:hunter2@localhost/db")).toBe(`postgres://${REDACTED}@localhost/db`);
    expect(redactText("Bearer abcdefghijklmnop")).toContain(REDACTED);
    expect(redactText("-----BEGIN PRIVATE KEY-----\nMIIFAKE\n-----END PRIVATE KEY-----")).toBe(REDACTED);
    expect(redactText("PLANTED_SECRET_TOKEN_9f3a")).not.toContain("PLANTED");
  });
});
