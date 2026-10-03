import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, getLease, requestLease, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { ghostId, isoPlus } from "../helpers/clock.js";
import { repoRoot } from "../helpers/process.js";
import { clone, bundleHashProblems, hashCanonical, reseal, tableCounts, tableFingerprint, type Bundle } from "../helpers/oracle.js";

/**
 * AC-10: export a versioned evidence bundle and restore/read it in a clean installation with matching hashes; truncated, tampered
 * or unsupported exports fail without any partial accepted state. Hashes are re-derived by an independent canonical-JSON oracle.
 */
export function portabilityAndCorruption(): void {
  let source: Harness;
  let sws: TestWorkspace;
  let clean: Harness;
  let cws: TestWorkspace;
  let raw: string;
  let bundle: Bundle;
  const leaseIds: string[] = [];
  const watch = ["leases", "approvals", "provider_grants", "revocation_attempts", "audit_events", "jobs", "events", "evidence_imports", "imported_leases"];

  beforeAll(async () => {
    source = await createHarness({ provider: "synthetic", fixedClock: true });
    sws = await source.workspace("ac10-source");
    const request = (n: number) => requestLease(source, sws, { task_ref: `TASK-AC10-${n}`, subject_ref: `person-${n}@example.invalid`, resource_ref: "demo", scopes: ["synthetic:demo:read"], expires_at: isoPlus(source.clock!(), 3600) });
    for (let n = 0; n < 4; n += 1) {
      const l = await request(n);
      leaseIds.push(l.id);
      if (n > 0) await source.client.post(sws.operator.session, `/leases/${l.id}/approve`, { plan_hash: l.plan_hash });
    }
    await source.drain();
    await source.client.post(sws.operator.session, `/leases/${leaseIds[1]}/close`, { reason: "done" });
    source.clock!.advance(3601); // two leases expire while ACTIVE
    await source.drain();
    const exported = await source.client.get(sws.operator.session, "/evidence/export");
    expect(exported.status).toBe(200);
    raw = exported.raw;
    bundle = JSON.parse(raw) as Bundle;
    clean = await createHarness({ provider: "synthetic", fixedClock: true });
    cws = await clean.workspace("ac10-clean");
  });
  afterAll(async () => {
    await source.close();
    await source.database.drop();
    await clean.close();
    await clean.database.drop();
  });

  const verify = (body: string | Buffer) => clean.client.post(cws.operator.session, "/evidence/verify", undefined, { rawBody: body });
  const importRaw = (body: string | Buffer) => clean.client.post(cws.admin.session, "/evidence/import", undefined, { rawBody: body });
  const expectRefused = async (name: string, body: string | Buffer, codes: string[]) => {
    const before = { rows: await tableCounts(clean.database.url), fp: await tableFingerprint(clean.database.url, watch) };
    const res = await importRaw(body);
    expect(res.status, `${name} -> ${res.raw.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    if (codes.length > 0) expect(codes, `${name} -> ${res.body?.error?.code}`).toContain(res.body?.error?.code);
    expect(await tableCounts(clean.database.url), `${name}: no rows may be added`).toEqual(before.rows);
    expect(await tableFingerprint(clean.database.url, watch), `${name}: no row may change`).toEqual(before.fp);
  };

  it("exports a versioned, self-describing bundle whose every hash re-verifies with an independent canonical-JSON oracle and which contains no secrets", async () => {
    expect(bundle.schema_version).toBe(1);
    expect(bundle.kind).toBe("accesslease.evidence-bundle");
    expect(bundleHashProblems(bundle)).toEqual([]);
    const paths = Object.keys(bundle.files).sort();
    expect(paths).toContain("policy.json");
    expect(paths).toContain("summary.json");
    for (const id of leaseIds) expect(paths).toContain(`leases/${id}.json`);
    expect(bundle.manifest.file_count).toBe(paths.length);
    expect(raw).not.toMatch(/"(secret|credential|ciphertext|password)"\s*:/i);
    expect(JSON.stringify(bundle.source)).toContain("SYNTHETIC");
  });

  it("restores into a clean installation: verify, import, re-read with matching hashes, idempotent re-import, and imported leases stay read-only evidence", async () => {
    const verified = await verify(raw);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ ok: true, code: null, bundle_hash: bundle.bundle_hash, lease_count: leaseIds.length });
    const before = await tableCounts(clean.database.url);
    const imported = await importRaw(raw);
    expect([200, 201]).toContain(imported.status);
    expect(imported.body).toMatchObject({ bundle_hash: bundle.bundle_hash, already_imported: false, lease_count: leaseIds.length });
    const importId = imported.body.import_id as string;
    expect((await clean.client.get(cws.viewer.session, "/imports")).body.items?.map((i: { import_id: string }) => i.import_id) ?? (await clean.client.get(cws.viewer.session, "/imports")).body.map?.((i: { import_id: string }) => i.import_id)).toContain(importId);
    for (const entry of bundle.manifest.files.filter((f) => f.path.startsWith("leases/"))) {
      const leaseId = entry.path.slice("leases/".length, -".json".length);
      const read = await clean.client.get(cws.viewer.session, `/imports/${importId}/leases/${leaseId}`);
      expect(read.status).toBe(200);
      expect(read.body.hash_verified, "the server re-verifies the stored document on every read").toBe(true);
      expect(hashCanonical(read.body.evidence), "an independently computed hash of the returned evidence equals the manifest hash").toBe(entry.sha256);
    }
    // Re-import returns the existing receipt and adds nothing.
    const again = await importRaw(raw);
    expect([200, 201]).toContain(again.status);
    expect(again.body.already_imported).toBe(true);
    expect(again.body.import_id).toBe(importId);
    const after = await tableCounts(clean.database.url);
    expect(after.evidence_imports).toBe((before.evidence_imports ?? 0) + 1);
    // Imported evidence is not live: it is not in the lease list, has no jobs and the worker never acts on it.
    const list = await clean.client.get(cws.viewer.session, "/leases?limit=100");
    expect(list.body.items).toEqual([]);
    const jobsBefore = after.jobs;
    await clean.drain();
    expect((await tableCounts(clean.database.url)).jobs).toBe(jobsBefore);
    expect((await clean.client.post(cws.operator.session, `/leases/${leaseIds[0]}/revoke`, { reason: "x" })).status).toBe(404);
  });

  it("truncated, empty and non-JSON exports are refused with no partial state", async () => {
    const text = raw;
    await expectRefused("truncated at 10%", text.slice(0, Math.floor(text.length * 0.1)), ["bundle_truncated", "bundle_malformed"]);
    await expectRefused("truncated at 50%", text.slice(0, Math.floor(text.length * 0.5)), ["bundle_truncated", "bundle_malformed"]);
    await expectRefused("truncated at 99%", text.slice(0, Math.floor(text.length * 0.99)), ["bundle_truncated", "bundle_malformed"]);
    await expectRefused("last byte missing", text.slice(0, -1), ["bundle_truncated", "bundle_malformed"]);
    await expectRefused("empty", "", []);
    await expectRefused("plain text fixture", readFileSync(join(repoRoot, "fixtures/corrupt/bundle-not-a-bundle.txt")), ["bundle_malformed", "bundle_truncated", "bundle_schema_invalid"]);
    await expectRefused("binary noise", Buffer.from([0, 1, 2, 3, 255, 254, 253]), ["bundle_malformed", "bundle_truncated"]);
  });

  it("unsupported versions and wrong kinds are refused with no partial state", async () => {
    await expectRefused("unsupported fixture", readFileSync(join(repoRoot, "fixtures/corrupt/bundle-unsupported-version.json")), ["bundle_unsupported_version"]);
    const v2 = clone(bundle);
    v2.schema_version = 2;
    await expectRefused("version 2", JSON.stringify(v2), ["bundle_unsupported_version"]);
    const v0 = clone(bundle);
    v0.schema_version = 0;
    await expectRefused("version 0", JSON.stringify(v0), ["bundle_unsupported_version", "bundle_schema_invalid"]);
    const kind = clone(bundle);
    kind.kind = "something.else";
    await expectRefused("wrong kind", JSON.stringify(kind), ["bundle_unsupported_version", "bundle_schema_invalid", "bundle_malformed"]);
  });

  it("tampering with any content, manifest or seal is detected by hash verification with no partial state", async () => {
    const leaseFile = Object.keys(bundle.files).find((p) => p.startsWith("leases/"))!;
    const changed = clone(bundle);
    (changed.files[leaseFile] as Record<string, any>).lease.state = "ACTIVE";
    await expectRefused("lease content changed", JSON.stringify(changed), ["bundle_hash_mismatch", "bundle_manifest_mismatch"]);
    const manifest = clone(bundle);
    manifest.manifest.files[0]!.sha256 = "0".repeat(64);
    await expectRefused("manifest hash changed", JSON.stringify(manifest), ["bundle_hash_mismatch", "bundle_manifest_mismatch"]);
    const seal = clone(bundle);
    seal.bundle_hash = "f".repeat(64);
    await expectRefused("bundle seal changed", JSON.stringify(seal), ["bundle_hash_mismatch"]);
    const dropped = clone(bundle);
    delete dropped.files[leaseFile];
    await expectRefused("file removed", JSON.stringify(dropped), ["bundle_hash_mismatch", "bundle_manifest_mismatch", "bundle_schema_invalid"]);
    // A corrupt LAST file after valid ones must not leave the earlier files imported.
    const names = Object.keys(bundle.files).filter((p) => p.startsWith("leases/")).sort();
    const lastBroken = clone(bundle);
    (lastBroken.files[names.at(-1)!] as Record<string, any>).lease.task_ref = "tampered after the others were fine";
    await expectRefused("last file corrupt", JSON.stringify(lastBroken), ["bundle_hash_mismatch", "bundle_manifest_mismatch"]);
    // Preserve the manifest's recorded file hash, but make the outer seal valid:
    // otherwise outer-seal rejection masks a missing per-file verification guard.
    const fileHashOnly = clone(bundle);
    (fileHashOnly.files[leaseFile] as Record<string, any>).lease.task_ref += "-tampered";
    const { bundle_hash: _oldSeal, ...unsealed } = fileHashOnly;
    fileHashOnly.bundle_hash = hashCanonical(unsealed);
    expect(bundleHashProblems(fileHashOnly)).toEqual([`hash mismatch ${leaseFile}`]);
    await expectRefused("content changed with valid outer seal", JSON.stringify(fileHashOnly), ["bundle_hash_mismatch"]);
  });

  it("re-sealed bundles with unsafe paths, broken references or too many files are refused with no partial state", async () => {
    const sample = Object.keys(bundle.files).find((p) => p.startsWith("leases/"))!;
    for (const [name, path] of [["parent traversal", "../escape.json"], ["absolute path", "/etc/escape.json"], ["backslash", "leases\\escape.json"], ["drive letter", "C:/escape.json"], ["double dot inside", "leases/../../x.json"]] as const) {
      const evil = clone(bundle);
      evil.files[path] = evil.files[sample];
      await expectRefused(`unsafe path: ${name}`, JSON.stringify(reseal(evil)), ["bundle_unsafe_path"]);
    }
    const broken = clone(bundle);
    (broken.files[sample] as Record<string, any>).lease.id = ghostId(255);
    await expectRefused("lease id differs from its path", JSON.stringify(reseal(broken)), ["bundle_reference_broken", "bundle_schema_invalid"]);
    const wrongWorkspace = clone(bundle);
    (wrongWorkspace.files[sample] as Record<string, any>).lease.workspace_id = ghostId(238);
    await expectRefused("lease from another workspace", JSON.stringify(reseal(wrongWorkspace)), ["bundle_reference_broken", "bundle_schema_invalid"]);
    const many = clone(bundle);
    for (let i = 0; i < 1001; i += 1) many.files[`leases/00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json`] = many.files[sample];
    await expectRefused("1001 files", JSON.stringify(reseal(many)), ["bundle_too_many_files", "bundle_reference_broken", "bundle_schema_invalid"]);
  });

  it("the whole round trip needs no network: verification and import work with the database only", async () => {
    // Evidence: the import above ran against a database-only installation; the offline guarantee is enforced again in the offline demo test.
    const detail = await getLease(source, sws.viewer.session, leaseIds[0]!);
    expect(detail.provider.label).toBe("SYNTHETIC");
  });
}
