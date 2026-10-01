import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LeaseRequestSchema } from "../../../src/domain/schemas.js";
import { buildSchemaFiles } from "../../../src/lib/schema-files.js";

const SCHEMAS_DIR = resolve(import.meta.dirname, "..", "..", "..", "schemas");

describe("schemas/*.json", () => {
  const files = buildSchemaFiles();

  it("are generated from the zod source of truth and do not drift", () => {
    if (process.env.ACCESSLEASE_UPDATE_SCHEMAS === "1") {
      mkdirSync(SCHEMAS_DIR, { recursive: true });
      for (const [name, doc] of Object.entries(files)) writeFileSync(join(SCHEMAS_DIR, name), `${JSON.stringify(doc, null, 2)}\n`);
    }
    for (const [name, doc] of Object.entries(files)) {
      const committed = JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf8"));
      expect(committed, `${name} drifted; run with ACCESSLEASE_UPDATE_SCHEMAS=1`).toEqual(JSON.parse(JSON.stringify(doc)));
    }
  });

  it("ship every required schema document", () => {
    expect(Object.keys(files).sort()).toEqual([
      "approval.json",
      "auth.json",
      "credential.json",
      "error.json",
      "event.json",
      "evidence-bundle.json",
      "lease.json",
      "policy.json",
      "revocation.json",
    ]);
    const lease = files["lease.json"] as { $defs: Record<string, { additionalProperties?: boolean }> };
    expect(Object.keys(lease.$defs)).toContain("LeaseRequest");
    expect(lease.$defs.LeaseRequest?.additionalProperties).toBe(false);
  });

  it("rejects unknown members and non-UTC expiries in the request schema", () => {
    const base = { task_ref: "t", subject_ref: "s", resource_ref: "r", scopes: ["synthetic:demo:read"] };
    expect(LeaseRequestSchema.safeParse(base).success).toBe(true);
    expect(LeaseRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(LeaseRequestSchema.safeParse({ ...base, expires_at: "2026-01-01T00:00:00+02:00" }).success).toBe(false);
    expect(LeaseRequestSchema.safeParse({ ...base, expires_at: "2026-01-01T00:00:00Z" }).success).toBe(true);
    expect(LeaseRequestSchema.safeParse({ ...base, scopes: [] }).success).toBe(false);
  });
});
