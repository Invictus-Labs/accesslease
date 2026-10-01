import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import { ProviderRegistry } from "../../../src/connectors/provider.js";
import { SyntheticProvider } from "../../../src/connectors/synthetic.js";
import { fixedClock } from "../../../src/context.js";
import { canonicalJson, contentHash } from "../../../src/domain/canonical.js";
import { AppError } from "../../../src/errors.js";
import { migrate } from "../../../src/db/migrate.js";
import { bootstrapAdmin, cliPrincipal } from "../../../src/services/auth.js";
import { runDoctor } from "../../../src/services/doctor.js";
import { exportBundle, getImportedLease, getLeaseEvidence, importBundle, listImports, verifyBundle } from "../../../src/services/evidence.js";
import { closeLease, getLease, requestLease, revokeLease } from "../../../src/services/leases.js";
import { runDemo } from "../../../src/services/demo.js";
import { getReportData } from "../../../src/services/report.js";
import { unresolvedCount } from "../../../src/services/unresolved.js";
import { credentialSecretFor } from "../../../src/workers/issue.js";
import { drive, type Env, freshDatabase, goodRequest, iso, makeEnv, requestApprove } from "./helpers.js";

const PLANTED = "PLANTED_SECRET_TOKEN_evidence_9f3a";
let env: Env;
let ids: { active: string; verified: string; unconfirmed: string; requested: string };
let bundle: { bytes: Buffer; bundle_hash: string; lease_count: number; file_count: number };

beforeAll(async () => {
  env = await makeEnv();
  const active = await requestApprove(env, { task_ref: `export-active ${PLANTED}`, subject_ref: "authorization=Bearer abcdef0123456789" }, 3600);
  const verified = await requestApprove(env, { task_ref: "export-verified" });
  const unconfirmed = await requestApprove(env, { task_ref: "export-unconfirmed <script>alert(1)</script>" });
  const requested = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: "export-requested" }));
  await drive(env);
  await closeLease(env.ctx, env.operator, verified.id, { reason: "done" });
  await drive(env);
  env.provider.faults.always("revoke", "outage");
  env.provider.faults.always("lookup", "outage");
  await revokeLease(env.ctx, env.operator, unconfirmed.id, { reason: "outage" });
  await drive(env);
  env.provider.faults.clear();
  ids = { active: active.id, verified: verified.id, unconfirmed: unconfirmed.id, requested: requested.id };
  bundle = await exportBundle(env.ctx, env.operator);
});
afterAll(async () => {
  await env.drop();
});

const mutateBundle = (fn: (b: any) => void, rehash = false) => {
  const parsed = JSON.parse(bundle.bytes.toString("utf8"));
  fn(parsed);
  if (rehash) {
    for (const entry of parsed.manifest.files) {
      entry.sha256 = contentHash(parsed.files[entry.path]);
      entry.bytes = Buffer.byteLength(canonicalJson(parsed.files[entry.path]));
    }
    parsed.manifest.manifest_hash = contentHash(parsed.manifest.files);
    parsed.manifest.total_bytes = parsed.manifest.files.reduce((n: number, e: any) => n + e.bytes, 0);
    const { bundle_hash: _drop, ...rest } = parsed;
    parsed.bundle_hash = contentHash(rest);
  }
  return Buffer.from(JSON.stringify(parsed));
};

async function rejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected rejection");
}

describe("AC-10 export", () => {
  it("exports a versioned, canonical, hash-verifiable and redacted bundle", () => {
    const text = bundle.bytes.toString("utf8");
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ schema_version: 1, kind: "accesslease.evidence-bundle", generator: { name: "accesslease" }, source: { workspace_name: "main" } });
    expect(bundle.lease_count).toBe(4);
    expect(bundle.file_count).toBe(6);
    expect(Object.keys(doc.files).sort()).toEqual(["policy.json", "summary.json", ...Object.values(ids).map((id) => `leases/${id}.json`)].sort());
    expect(doc.bundle_hash).toBe(bundle.bundle_hash);
    expect(text).toBe(canonicalJson(doc));
    expect(doc.files["summary.json"]).toMatchObject({ contains_synthetic: true, unresolved: { issue_unknown: 0, revocation_unconfirmed: 1 } });
    expect(doc.source.provider_labels).toEqual([{ kind: "synthetic", label: "SYNTHETIC", live: false }]);
    // AC-09: planted secrets and credentials never appear
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("0123456789");
    expect(text).not.toContain(credentialSecretFor(env.ctx, ids.active));
    expect(text).not.toContain("credential_ct");
    expect(text).toContain("[REDACTED]");
    // hostile markup is data: stored verbatim inside JSON strings, never interpreted
    expect(text).toContain("<script>alert(1)</script>");
  });

  it("is reproducible for the same state and clock, and verifies offline", () => {
    return exportBundle(env.ctx, env.operator).then((again) => {
      expect(again.bytes.equals(bundle.bytes)).toBe(true);
      expect(verifyBundle(bundle.bytes)).toMatchObject({ ok: true, code: null, schema_version: 1, lease_count: 4, file_count: 6, bundle_hash: bundle.bundle_hash });
    });
  });

  it("supports subsets, rejects foreign/unknown ids, and enforces roles and limits", async () => {
    const subset = await exportBundle(env.ctx, env.operator, { leaseIds: [ids.active] });
    expect(subset.lease_count).toBe(1);
    expect(verifyBundle(subset.bytes).lease_count).toBe(1);
    expect((await rejects(exportBundle(env.ctx, env.other.operator, { leaseIds: [ids.active] }))).status).toBe(404);
    expect((await rejects(exportBundle(env.ctx, env.operator, { leaseIds: ["nope"] }))).status).toBe(404);
    expect((await rejects(exportBundle(env.ctx, env.viewer))).status).toBe(403);
    expect((await exportBundle(env.ctx, env.other.operator)).lease_count).toBe(0);
    const small = { ...env.ctx, settings: { ...env.ctx.settings, importMaxFiles: 4 } };
    expect((await rejects(exportBundle(small, env.operator))).code).toBe("bundle_too_many_files");
    const tiny = { ...env.ctx, settings: { ...env.ctx.settings, importMaxMetadataBytes: 100 } };
    expect((await rejects(exportBundle(tiny, env.operator))).code).toBe("bundle_too_large");
    const evidence = (await getLeaseEvidence(env.ctx, env.viewer, ids.verified)) as any;
    expect(evidence.lease.state).toBe("revoked_verified");
    expect(evidence.events.at(-1).event_type).toBe("lease.revoked_verified");
    expect((await rejects(getLeaseEvidence(env.ctx, env.other.viewer, ids.verified))).status).toBe(404);
    expect((await rejects(getLeaseEvidence(env.ctx, env.viewer, "bad"))).status).toBe(404);
  });
});

describe("AC-10 verification fails closed", () => {
  it("rejects truncated bundles at every cut point", () => {
    const cuts = [0, 1, 10, Math.floor(bundle.bytes.length / 3), Math.floor(bundle.bytes.length / 2), bundle.bytes.length - 50, bundle.bytes.length - 2, bundle.bytes.length - 1];
    for (const cut of cuts) {
      const result = verifyBundle(bundle.bytes.subarray(0, cut));
      expect(result.ok, `cut ${cut}`).toBe(false);
      expect(result.code, `cut ${cut}`).toBe("bundle_truncated");
    }
  });

  it("rejects tampered content, forged hashes, unsupported versions, malformed and oversize input", () => {
    expect(verifyBundle(Buffer.from("not json at all {{{ }"))).toMatchObject({ ok: false, code: "bundle_malformed" });
    expect(verifyBundle(Buffer.from("[1,2,3]"))).toMatchObject({ ok: false, code: "bundle_malformed" });
    expect(verifyBundle(Buffer.from('{"kind":"other"}'))).toMatchObject({ ok: false, code: "bundle_malformed" });
    expect(verifyBundle(mutateBundle((b) => void (b.schema_version = 2)))).toMatchObject({ ok: false, code: "bundle_unsupported_version" });
    expect(verifyBundle(mutateBundle((b) => void (b.schema_version = "1")))).toMatchObject({ ok: false, code: "bundle_unsupported_version" });
    expect(verifyBundle(mutateBundle((b) => void delete b.manifest))).toMatchObject({ ok: false, code: "bundle_schema_invalid" });
    expect(verifyBundle(mutateBundle((b) => void (b.files[`leases/${ids.active}.json`].lease.task_ref = "tampered")))).toMatchObject({ ok: false, code: "bundle_hash_mismatch" });
    expect(verifyBundle(mutateBundle((b) => void (b.generator.version = "9.9.9")))).toMatchObject({ ok: false, code: "bundle_hash_mismatch" });
    expect(verifyBundle(mutateBundle((b) => void (b.manifest.manifest_hash = "0".repeat(64))))).toMatchObject({ ok: false, code: "bundle_hash_mismatch" });
    expect(verifyBundle(mutateBundle((b) => void (b.manifest.total_bytes += 1)))).toMatchObject({ ok: false, code: "bundle_manifest_mismatch" });
    expect(verifyBundle(mutateBundle((b) => void (b.files["extra.json"] = {})))).toMatchObject({ ok: false, code: "bundle_unsafe_path" });
    expect(verifyBundle(mutateBundle((b) => void (b.files[`leases/${ids.active}.json`] = b.files[`leases/${ids.verified}.json`])))).toMatchObject({ ok: false, code: "bundle_hash_mismatch" });
    expect(verifyBundle(mutateBundle((b) => void b.manifest.files.pop()))).toMatchObject({ ok: false, code: "bundle_manifest_mismatch" });
    expect(verifyBundle(mutateBundle((b) => void b.manifest.files.push({ ...b.manifest.files[0] })))).toMatchObject({ ok: false, code: "bundle_manifest_mismatch" });
    expect(verifyBundle(bundle.bytes, { maxBytes: 100 })).toMatchObject({ ok: false, code: "bundle_too_large" });
    expect(verifyBundle(bundle.bytes, { maxFiles: 3 })).toMatchObject({ ok: false, code: "bundle_too_many_files" });
    expect(verifyBundle(bundle.bytes, { maxBytes: 100, allowLarge: true }).ok).toBe(true);
  });

  it("fails closed on hostile nesting depth instead of crashing", () => {
    const doc = JSON.parse(bundle.bytes.toString("utf8"));
    doc.files["summary.json"] = "__DEEP__";
    const hostile = Buffer.from(JSON.stringify(doc).replace('"__DEEP__"', "[".repeat(100_000) + "]".repeat(100_000)));
    const result = verifyBundle(hostile, { maxBytes: 10_000_000 });
    expect(result.ok).toBe(false);
    expect(["bundle_malformed", "bundle_hash_mismatch", "bundle_truncated"]).toContain(result.code);
  });

  it("rejects unsafe paths such as traversal, absolute and symlink-like names even when hashes are consistent", () => {
    for (const path of ["../escape.json", "/etc/passwd", "leases/../../x.json", "leases\\win.json", "leases/not-a-uuid.json", "C:/x.json"]) {
      const forged = mutateBundle((b) => {
        b.files[path] = { x: 1 };
        b.manifest.files.push({ path, sha256: "0".repeat(64), bytes: 1 });
        b.manifest.file_count += 1;
      }, true);
      expect(verifyBundle(forged), path).toMatchObject({ ok: false, code: "bundle_unsafe_path" });
    }
  });

  it("rejects forged-but-consistent bundles: broken references and verified claims without evidence", () => {
    const claimVerified = mutateBundle((b) => {
      const doc = b.files[`leases/${ids.unconfirmed}.json`];
      doc.lease.state = "revoked_verified";
      doc.lease.revocation_status = "verified";
    }, true);
    expect(verifyBundle(claimVerified)).toMatchObject({ ok: false, code: "bundle_reference_broken" });
    const wrongWorkspace = mutateBundle((b) => void (b.files[`leases/${ids.active}.json`].lease.workspace_id = b.files[`leases/${ids.verified}.json`].lease.id), true);
    expect(verifyBundle(wrongWorkspace)).toMatchObject({ ok: false, code: "bundle_reference_broken" });
    const swapped = mutateBundle((b) => void (b.files["summary.json"].lease_ids = [ids.active]), true);
    expect(verifyBundle(swapped)).toMatchObject({ ok: false, code: "bundle_reference_broken" });
    const badDoc = mutateBundle((b) => void delete b.files[`leases/${ids.active}.json`].lease.state, true);
    expect(verifyBundle(badDoc)).toMatchObject({ ok: false, code: "bundle_schema_invalid" });
  });
});

describe("AC-10 import into a clean installation", () => {
  it("restores evidence read-only with matching hashes, idempotently; failures leave no partial state", async () => {
    const clean = await makeEnv();
    try {
      const target = clean.admin;
      const before = await clean.ctx.db.query("SELECT (SELECT count(*) FROM evidence_imports)::int AS i, (SELECT count(*) FROM imported_leases)::int AS l");
      expect(before.rows[0]).toEqual({ i: 0, l: 0 });
      const receipt = await importBundle(clean.ctx, target, bundle.bytes);
      expect(receipt).toMatchObject({ already_imported: false, lease_count: 4, bundle_hash: bundle.bundle_hash });
      const again = await importBundle(clean.ctx, target, bundle.bytes);
      expect(again).toMatchObject({ already_imported: true, import_id: receipt.import_id, lease_count: 4 });
      expect((await clean.ctx.db.query("SELECT 1 FROM imported_leases")).rows).toHaveLength(4);

      const imports = await listImports(clean.ctx, clean.viewer);
      expect(imports).toHaveLength(1);
      expect(imports[0]).toMatchObject({ bundle_hash: bundle.bundle_hash, schema_version: 1, lease_count: 4 });
      const restored = (await getImportedLease(clean.ctx, clean.viewer, receipt.import_id, ids.unconfirmed)) as any;
      expect(restored.hash_verified).toBe(true);
      expect(restored.evidence.lease.state).toBe("revocation_unconfirmed");
      expect(restored.evidence.lease.revocation_status).toBe("unconfirmed");
      expect(contentHash(restored.evidence)).toBe(contentHash(JSON.parse(bundle.bytes.toString("utf8")).files[`leases/${ids.unconfirmed}.json`]));
      // restored evidence is never re-activated: no leases, no jobs, the worker has nothing to do
      expect((await clean.ctx.db.query("SELECT 1 FROM leases")).rows).toHaveLength(0);
      const pass = await drive(clean);
      expect(pass.jobsProcessed).toBe(0);
      expect((await getReportData(clean.ctx, clean.viewer)).imports).toMatchObject([{ import_id: receipt.import_id, lease_count: 4 }]);

      // read-time re-verification detects storage tampering
      await clean.ctx.db.query("UPDATE imported_leases SET doc = jsonb_set(doc, '{lease,task_ref}', '\"tampered\"') WHERE lease_id = $1", [ids.active]);
      expect((await rejects(getImportedLease(clean.ctx, clean.viewer, receipt.import_id, ids.active))).code).toBe("bundle_hash_mismatch");
      // isolation + roles
      expect((await rejects(getImportedLease(clean.ctx, clean.other.viewer, receipt.import_id, ids.verified))).status).toBe(404);
      expect((await rejects(getImportedLease(clean.ctx, clean.viewer, "bad", ids.verified))).status).toBe(404);
      expect((await listImports(clean.ctx, clean.other.viewer))).toEqual([]);
      expect((await rejects(importBundle(clean.ctx, clean.operator, bundle.bytes))).status).toBe(403);
      expect((await rejects(importBundle(clean.ctx, clean.viewer, bundle.bytes))).status).toBe(403);
    } finally {
      await clean.drop();
    }
  });

  it("truncated, tampered, unsupported and oversize bundles are rejected with no state at all", async () => {
    const clean = await makeEnv();
    try {
      const count = async () =>
        (await clean.ctx.db.query("SELECT (SELECT count(*) FROM evidence_imports)::int AS i, (SELECT count(*) FROM imported_leases)::int AS l, (SELECT count(*) FROM audit_events WHERE action = 'evidence.imported')::int AS a")).rows[0];
      const cases: [Buffer, string, number][] = [
        [bundle.bytes.subarray(0, Math.floor(bundle.bytes.length / 2)), "bundle_truncated", 422],
        [mutateBundle((b) => void (b.files[`leases/${ids.active}.json`].lease.task_ref = "x")), "bundle_hash_mismatch", 422],
        [mutateBundle((b) => void (b.schema_version = 99)), "bundle_unsupported_version", 422],
        [Buffer.from("garbage"), "bundle_truncated", 422],
      ];
      for (const [bytes, code, status] of cases) {
        const error = await rejects(importBundle(clean.ctx, clean.admin, bytes));
        expect([error.code, error.status]).toEqual([code, status]);
        expect(await count()).toEqual({ i: 0, l: 0, a: 0 });
      }
      const big = await rejects(importBundle(clean.ctx, clean.admin, bundle.bytes, { maxBytes: 10 }));
      expect([big.code, big.status]).toEqual(["bundle_too_large", 413]);
      expect(await count()).toEqual({ i: 0, l: 0, a: 0 });
    } finally {
      await clean.drop();
    }
  });

  it("a database failure in the middle of an import rolls everything back (transactional)", async () => {
    const clean = await makeEnv();
    try {
      await clean.ctx.db.query(`
        CREATE FUNCTION fail_second() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT count(*) FROM imported_leases) >= 2 THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END $$`);
      await clean.ctx.db.query("CREATE TRIGGER fail_second BEFORE INSERT ON imported_leases FOR EACH ROW EXECUTE FUNCTION fail_second()");
      await expect(importBundle(clean.ctx, clean.admin, bundle.bytes)).rejects.toThrow(/injected failure/);
      const rows = (await clean.ctx.db.query("SELECT (SELECT count(*) FROM evidence_imports)::int AS i, (SELECT count(*) FROM imported_leases)::int AS l")).rows[0];
      expect(rows).toEqual({ i: 0, l: 0 });
      await clean.ctx.db.query("DROP TRIGGER fail_second ON imported_leases");
      expect((await importBundle(clean.ctx, clean.admin, bundle.bytes)).already_imported).toBe(false);
    } finally {
      await clean.drop();
    }
  });
});

describe("report data, doctor and the offline demo", () => {
  it("report data is redacted, flags SYNTHETIC and counts unresolved states explicitly", async () => {
    const data = await getReportData(env.ctx, env.viewer);
    expect(data.contains_synthetic).toBe(true);
    expect(data.summary.total).toBe(4);
    expect(data.summary.by_state).toMatchObject({ active: 1, revoked_verified: 1, revocation_unconfirmed: 1, requested: 1 });
    expect(data.summary.unresolved).toEqual({ issue_unknown: 0, revocation_unconfirmed: 1 });
    expect(JSON.stringify(data)).not.toContain(PLANTED);
    const unconfirmed = data.leases.find((l) => l.id === ids.unconfirmed);
    expect(unconfirmed?.warning).toContain("NOT verified");
    expect(unconfirmed?.revocation_status).toBe("unconfirmed");
    expect(data.summary.max_revocation_request_delay_seconds).toBeNull();
    const subset = await getReportData(env.ctx, env.viewer, { leaseIds: [ids.active] });
    expect(subset.leases).toHaveLength(1);
    expect((await getReportData(env.ctx, env.other.viewer)).summary.total).toBe(0);
  });

  it("summary counts cover the whole workspace and truncation is explicit: an old unresolved lease can not be hidden by the list limit (R-002)", async () => {
    const t = await makeEnv();
    try {
      t.provider.faults.always("revoke", "outage");
      const stuck = await requestApprove(t, { task_ref: "old-unconfirmed" }, 3600);
      await drive(t);
      await revokeLease(t.ctx, t.operator, stuck.id, { reason: "outage" });
      await drive(t);
      t.provider.faults.clear();
      for (let i = 0; i < 4; i += 1) {
        t.clock.advance(1);
        await requestLease(t.ctx, t.operator, goodRequest({ task_ref: `newer-${i}`, expires_at: iso(t.clock, 3600) }));
      }
      const data = await getReportData(t.ctx, t.viewer, { limit: 2 });
      expect(data.leases.map((l) => l.task_ref)).toEqual(["newer-2", "newer-3"]);
      expect(data).toMatchObject({ truncated: true, workspace_total: 5 });
      expect(data.summary.total).toBe(5);
      expect(data.summary.by_state).toMatchObject({ requested: 4, revocation_unconfirmed: 1 });
      expect(data.summary.unresolved).toEqual({ issue_unknown: 0, revocation_unconfirmed: 1 });
      expect(data.contains_synthetic).toBe(true);
      const full = await getReportData(t.ctx, t.viewer);
      expect(full).toMatchObject({ truncated: false, workspace_total: 5 });
      expect(full.leases).toHaveLength(5);
    } finally {
      await t.drop();
    }
  });

  it("report data records the measured delay between expiry and the revocation request", async () => {
    const iso0 = await makeEnv();
    try {
      const lease = await requestApprove(iso0, {}, 120);
      await drive(iso0);
      iso0.clock.advance(125);
      await drive(iso0);
      const data = await getReportData(iso0.ctx, iso0.viewer);
      expect(data.summary.max_revocation_request_delay_seconds).toBe(5);
      expect((await getLease(iso0.ctx, iso0.viewer, lease.id)).state).toBe("revoked_verified");
    } finally {
      await iso0.drop();
    }
  });

  it("doctor diagnoses healthy, unresolved, overdue, not-ready and disconnected installations with exit codes", async () => {
    const d = await makeEnv();
    try {
      let report = await runDoctor(d.ctx);
      expect(report.exitCode).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.checks.find((c) => c.name === "provider:synthetic")).toMatchObject({ status: "warn" });
      const unconfirmed = await requestApprove(d, {}, 600);
      await drive(d);
      d.provider.faults.always("revoke", "outage");
      await revokeLease(d.ctx, d.operator, unconfirmed.id, { reason: "x" });
      await drive(d);
      report = await runDoctor(d.ctx);
      expect(report).toMatchObject({ exitCode: 4, ok: false });
      expect(report.checks.find((c) => c.name === "unresolved-states")).toMatchObject({ status: "warn" });
      expect(await unresolvedCount(d.ctx)).toEqual({ issueUnknown: 0, revocationUnconfirmed: 1 });
      expect(await unresolvedCount(d.ctx, d.other.workspaceId)).toEqual({ issueUnknown: 0, revocationUnconfirmed: 0 });
      // overdue: a lease whose worker never ran
      d.provider.faults.clear();
      const overdue = await requestLease(d.ctx, d.operator, goodRequest({ expires_at: iso(d.clock, 120) }));
      d.clock.advance(300);
      report = await runDoctor(d.ctx);
      expect(report.exitCode).toBe(1);
      expect(report.checks.find((c) => c.name === "overdue-leases")).toMatchObject({ status: "fail", hint: expect.stringContaining("worker") });
      await drive(d);
      expect((await getLease(d.ctx, d.viewer, overdue.id)).close_reason).toBe("expired");
      // failing jobs and a broken migration stop readiness
      await d.ctx.db.query("UPDATE schema_migrations SET checksum = 'tampered'");
      report = await runDoctor(d.ctx);
      expect(report.exitCode).toBe(1);
      expect(report.checks.find((c) => c.name === "migrations")).toMatchObject({ status: "fail", message: expect.stringContaining("not ready") });
      // disconnected live provider: explicit, exit code 3
      const dead = new PostgresRoleProvider({ adminUrl: "postgres://postgres:x@127.0.0.1:1/postgres", allowlist: ["127.0.0.1"], connectTimeoutMs: 300 });
      const liveCtx = { ...d.ctx, providers: new ProviderRegistry([dead], "postgres-role") };
      const liveReport = await runDoctor(liveCtx);
      expect(liveReport.checks.find((c) => c.name === "provider:postgres-role")).toMatchObject({ status: "unavailable" });
      expect(liveReport.exitCode).toBe(1); // still failing because of the tampered migration; unavailable alone is 3
      const dbDown = await freshDatabase("al_doc");
      const brokenCtx = { ...d.ctx, db: dbDown.db };
      await dbDown.drop();
      expect((await runDoctor(brokenCtx)).checks.find((c) => c.name === "database")).toMatchObject({ status: "fail" });
    } finally {
      await d.drop();
    }
  });

  it("doctor reports a clean live-provider outage as exit code 3", async () => {
    const d = await makeEnv({ providers: [new PostgresRoleProvider({ adminUrl: "postgres://postgres:x@127.0.0.1:1/postgres", allowlist: ["127.0.0.1"], connectTimeoutMs: 300 })] });
    try {
      const report = await runDoctor(d.ctx);
      expect(report.checks.find((c) => c.name === "provider:postgres-role")).toMatchObject({ status: "unavailable", hint: expect.stringContaining("ACCESSLEASE_EGRESS_ALLOWLIST") });
      expect(report.exitCode).toBe(3);
    } finally {
      await d.drop();
    }
  });

  it("runs the offline demo deterministically in a throwaway schema with owner-only output and no HTTP", async () => {
    const dirs = [mkdtempSync(join(tmpdir(), "al-demo-")), mkdtempSync(join(tmpdir(), "al-demo-"))];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network is denied in the demo");
    });
    const httpSpy = vi.spyOn(http, "request");
    const httpsSpy = vi.spyOn(https, "request");
    const fresh = await freshDatabase("al_demo_host");
    try {
      const outputs = [];
      for (const dir of dirs) outputs.push(await runDemo({ databaseUrl: fresh.url, outDir: join(dir, "out") }));
      const [first, second] = outputs as [Awaited<ReturnType<typeof runDemo>>, Awaited<ReturnType<typeof runDemo>>];
      expect(first.provider).toEqual({ kind: "synthetic", label: "SYNTHETIC", live: false });
      expect(first.reportData.contains_synthetic).toBe(true);
      expect(first.reportData.summary.total).toBe(3);
      expect(first.reportData.summary.by_state).toMatchObject({ revoked_verified: 2, revocation_unconfirmed: 1 });
      expect(first.unresolved).toEqual({ issueUnknown: 0, revocationUnconfirmed: 1 });
      expect(first.rejectedRequests).toEqual([
        { scope: "*", code: "scope_wildcard" },
        { scope: "synthetic:admin:read", code: "scope_forbidden" },
      ]);
      const closeReasons = first.reportData.leases.map((l) => [l.task_ref, l.close_reason]);
      expect(closeReasons).toEqual([
        ["demo-expiry", "expired"],
        ["demo-ambiguous-issue", "task_closed"],
        ["demo-revocation-outage", "operator_revoked"],
      ]);
      expect(first.reportData.generated_at).toBe("2026-01-01T00:30:07.000Z");
      expect(verifyBundle(first.bundle.bytes)).toMatchObject({ ok: true, lease_count: 3 });
      // deterministic: identical bundle bytes and report data across runs
      expect(first.bundle.bytes.equals(second.bundle.bytes)).toBe(true);
      expect(JSON.stringify(first.reportData)).toBe(JSON.stringify(second.reportData));
      // owner-only files and directories
      expect(statSync(join(dirs[0] as string, "out")).mode & 0o777).toBe(0o700);
      expect(statSync(first.files.bundle as string).mode & 0o777).toBe(0o600);
      expect(readFileSync(first.files.reportData as string, "utf8")).toContain("SYNTHETIC");
      // no network, and the throwaway schema was dropped
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      const schemas = await fresh.db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'al_demo_%'");
      expect(schemas.rows).toEqual([]);
      const noOut = await runDemo({ databaseUrl: fresh.url, startAt: "2026-06-01T00:00:00.000Z" });
      expect(noOut.files).toEqual({});
      expect(noOut.reportData.generated_at).toBe("2026-06-01T00:30:07.000Z");
    } finally {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
      await fresh.drop();
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bootstrapAdmin has no default password and refuses weak ones; cliPrincipal resolves the workspace", async () => {
    const fresh = await freshDatabase("al_boot");
    try {
      await migrate(fresh.db);
      const ctx = { ...env.ctx, db: fresh.db, clock: fixedClock("2026-03-01T00:00:00Z") };
      await expect(bootstrapAdmin(ctx, { email: "admin@example.test", password: "short", workspaceName: "Ops" })).rejects.toMatchObject({ status: 422 });
      expect((await fresh.db.query("SELECT 1 FROM users")).rows).toHaveLength(0);
      await expect(cliPrincipal(ctx)).rejects.toMatchObject({ status: 404 });
      const made = await bootstrapAdmin(ctx, { email: "Admin@Example.test", password: "a-long-synthetic-password", workspaceName: "Ops" });
      expect(made.created).toEqual({ workspace: true, user: true });
      await expect(bootstrapAdmin(ctx, { email: "admin@example.test", password: "a-long-synthetic-password", workspaceName: "Ops" })).rejects.toMatchObject({ status: 409 });
      const second = await bootstrapAdmin(ctx, { email: "second@example.test", password: "another-long-password", workspaceName: "Ops" });
      expect(second.workspaceId).toBe(made.workspaceId);
      expect(second.created).toEqual({ workspace: false, user: true });
      const principal = await cliPrincipal(ctx);
      expect(principal).toMatchObject({ actorRef: "cli:local", role: "admin", workspaceName: "Ops", workspaceId: made.workspaceId });
      expect(await cliPrincipal(ctx, "Ops")).toMatchObject({ workspaceId: made.workspaceId });
      expect(await cliPrincipal(ctx, made.workspaceId)).toMatchObject({ workspaceId: made.workspaceId });
      await bootstrapAdmin(ctx, { email: "third@example.test", password: "yet-another-long-password", workspaceName: "Second" });
      await expect(cliPrincipal(ctx)).rejects.toMatchObject({ code: "validation_failed" });
      await expect(cliPrincipal(ctx, "missing")).rejects.toMatchObject({ status: 404 });
    } finally {
      await fresh.drop();
    }
  });
});
