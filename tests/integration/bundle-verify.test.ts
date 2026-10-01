import { describe, expect, it } from "vitest";
import { verifyBundle } from "../../src/services/index.js";
import { ghostId } from "../helpers/clock.js";
import { deepJson } from "../helpers/hostile.js";
import { hashCanonical } from "../helpers/oracle.js";

/**
 * Pure, offline probing of the evidence bundle verifier with hostile structures. `verifyBundle` must NEVER throw and never hang for a
 * bad bundle: it returns { ok:false, code } with a stable code, quickly, whatever the input (AC-10: fail without partial accepted
 * state; AC-09: size and schema validated before processing; security section: validate paths, expansion and content).
 */
const enc = (value: string | object): Uint8Array => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const KIND = "accesslease.evidence-bundle";

function bundleWith(files: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  const entries = Object.keys(files).map((path) => ({ path, sha256: hashCanonical(files[path]), bytes: Buffer.byteLength(JSON.stringify(files[path])) }));
  const manifest = { files: entries, file_count: entries.length, total_bytes: entries.reduce((n, e) => n + e.bytes, 0), manifest_hash: hashCanonical(entries) };
  const base: Record<string, unknown> = { schema_version: 1, kind: KIND, exported_at: "2026-01-01T00:00:00.000Z", generator: { name: "accesslease", version: "0" }, source: { workspace_id: "w", workspace_name: "n", provider_labels: [] }, manifest, files, ...over };
  const { bundle_hash: _drop, ...rest } = base;
  return { ...rest, bundle_hash: hashCanonical(rest) };
}

const timed = (bytes: Uint8Array, options?: Parameters<typeof verifyBundle>[1]) => {
  const started = Date.now();
  const result = verifyBundle(bytes, options);
  expect(Date.now() - started, "the verifier must answer quickly even for hostile input").toBeLessThan(5000);
  return result;
};

describe("evidence bundle verifier: hostile input never throws and never hangs", () => {
  it("empty, whitespace, BOM-only, non-UTF-8, array, scalar and null roots are refused with a stable code", () => {
    for (const [name, bytes] of [
      ["empty", enc("")],
      ["whitespace", enc("   \n ")],
      ["bom only", Buffer.from([0xef, 0xbb, 0xbf])],
      ["invalid utf-8", Buffer.from([0xff, 0xfe, 0x00, 0x7b])],
      ["array root", enc("[]")],
      ["number root", enc("42")],
      ["null root", enc("null")],
      ["string root", enc('"x"')],
    ] as const) {
      const result = timed(bytes);
      expect(result.ok, name).toBe(false);
      expect(result.code, name).toMatch(/^bundle_/);
      expect(result.lease_count).toBe(0);
    }
  });

  it("hostile nesting depth, huge scalars and trailing garbage fail closed", () => {
    for (const [name, bytes] of [
      ["deep arrays", enc(deepJson(2_000_000))],
      ["deep objects", enc(`${'{"a":'.repeat(200_000)}1${"}".repeat(200_000)}`)],
      ["trailing garbage", enc(`${JSON.stringify(bundleWith({}))} trailing`)],
      ["two documents", enc(`${JSON.stringify({})}${JSON.stringify({})}`)],
      ["huge number", enc('{"schema_version":1e999,"kind":"x"}')],
      ["1 MB string member", enc(JSON.stringify({ kind: KIND, schema_version: 1, note: "x".repeat(1_000_000) }))],
    ] as const) {
      const result = timed(bytes);
      expect(result.ok, name).toBe(false);
      expect(result.code, name).toMatch(/^bundle_/);
    }
  });

  it("wrong kind, string or float or negative versions, and missing members are refused before anything else is trusted", () => {
    expect(timed(enc({ kind: "other", schema_version: 1 })).code).toBe("bundle_malformed");
    expect(timed(enc({ kind: KIND, schema_version: "1" })).code).toBe("bundle_unsupported_version");
    expect(timed(enc({ kind: KIND, schema_version: 1.5 })).code).toBe("bundle_unsupported_version");
    expect(timed(enc({ kind: KIND, schema_version: -1 })).code).toBe("bundle_unsupported_version");
    expect(timed(enc({ kind: KIND, schema_version: 1 })).code).toBe("bundle_schema_invalid");
    expect(timed(enc({ kind: KIND, schema_version: 1, files: null, manifest: null })).code).toBe("bundle_schema_invalid");
  });

  it("file paths are an allow-list: traversal, absolute, backslash, drive letters, NUL, bidi, prototype keys, URL-encoded and over-long names are refused", () => {
    const evil = ["../x.json", "/x.json", "leases/../../x.json", "leases\\x.json", "C:/x.json", "leases/x.json\u0000", "leases/\u202ex.json", "__proto__", "constructor", "leases/%2e%2e/x.json", `leases/${"a".repeat(5000)}.json`, "LEASES/x.json", "leases/x.JSON", " policy.json", "policy.json ", "policy.json/", "./policy.json"];
    for (const path of evil) {
      const result = timed(enc(bundleWith({ [path]: { a: 1 } })));
      expect(result.ok, JSON.stringify(path)).toBe(false);
      expect(["bundle_unsafe_path", "bundle_schema_invalid", "bundle_manifest_mismatch"], `${JSON.stringify(path)} -> ${result.code}`).toContain(result.code);
    }
  });

  it("file-count and size limits apply before hashing: 1001 files and an over-limit byte count are refused fast", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 1001; i += 1) many[`leases/${String(i).padStart(8, "0")}-0000-4000-8000-000000000000.json`] = {};
    const tooMany = timed(enc(bundleWith(many)));
    expect(tooMany.ok).toBe(false);
    expect(["bundle_too_many_files", "bundle_schema_invalid"]).toContain(tooMany.code);
    const small = timed(enc(bundleWith({ "policy.json": {} })), { maxBytes: 100 });
    expect(small.code).toBe("bundle_too_large");
    const override = timed(enc(bundleWith({ "policy.json": {} })), { maxBytes: 100, allowLarge: true });
    expect(override.code, "an explicit large-file override raises the limit but a bad bundle is still refused").not.toBe("bundle_too_large");
    expect(override.ok).toBe(false);
  });

  it("a consistent-looking bundle without the required policy and summary documents is not accepted", () => {
    const result = timed(enc(bundleWith({ [`leases/${ghostId(1)}.json`]: { lease: {}, events: [] } })));
    expect(result.ok).toBe(false);
    expect(result.lease_count).toBe(0);
  });
});
