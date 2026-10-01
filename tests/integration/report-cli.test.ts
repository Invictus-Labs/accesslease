import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leakedSecrets, plantedPieces } from "../helpers/secrets.js";
import { HOSTILE_HTML } from "../helpers/hostile.js";
import { repoRoot, runToCompletion } from "../helpers/process.js";

/**
 * The offline `accesslease report --from-data` path takes an UNTRUSTED JSON file and renders a static HTML report: size and schema are
 * validated first, every value is escaped, credential-shaped text is redacted, output files are owner-only. Runs the packaged CLI, so
 * it needs `npm run build:server`; no database or network is involved.
 */
const cli = join(repoRoot, "dist/src/cli.js");
let dir: string;

const provider = { kind: "synthetic", label: "SYNTHETIC", live: false };
const lease = (over: Record<string, unknown> = {}) => ({
  id: "lease-1",
  task_ref: "TASK-REPORT",
  subject_ref: "contractor@example.invalid",
  resource_ref: "demo",
  scopes: ["synthetic:demo:read"],
  state: "revoked_verified",
  expires_at: "2026-01-01T01:00:00.000Z",
  last_verified_at: "2026-01-01T01:00:05.000Z",
  revocation_status: "verified",
  next_retry_at: null,
  provider,
  close_reason: "expired",
  warning: null,
  attempts: [{ attempted_at: "2026-01-01T01:00:04.000Z", result: "verified", verification_ref: "introspection:absent+probe:denied" }],
  audit: [{ occurred_at: "2026-01-01T01:00:00.000Z", actor_ref: "system:worker", action: "sweep.expired", metadata: {} }],
  ...over,
});
const reportData = (leases: unknown[], unresolved = { issue_unknown: 0, revocation_unconfirmed: 0 }, over: Record<string, unknown> = {}) => {
  const byState: Record<string, number> = {};
  for (const l of leases as { state: string }[]) byState[l.state.toLowerCase()] = (byState[l.state.toLowerCase()] ?? 0) + 1;
  return {
    schema_version: 1,
    generated_at: "2026-01-01T02:00:00.000Z",
    workspace: { id: "ws-1", name: "report-test" },
    providers: [provider],
    contains_synthetic: true,
    truncated: false,
    workspace_total: leases.length,
    summary: { by_state: byState, unresolved, max_revocation_request_delay_seconds: 3 },
    leases,
    ...over,
  };
};

async function render(name: string, data: unknown | Buffer, extra: string[] = []) {
  const input = join(dir, `${name}.json`);
  writeFileSync(input, Buffer.isBuffer(data) ? data : JSON.stringify(data));
  const out = join(dir, `${name}.html`);
  const result = await runToCompletion(process.execPath, [cli, "report", "--from-data", input, "--out", out, ...extra], {});
  return { ...result, out, html: existsSync(out) ? readFileSync(out, "utf8") : null };
}

describe("static report from untrusted data", () => {
  beforeAll(() => {
    expect(existsSync(cli), "run `npm run build:server` first: the packaged CLI is what is tested").toBe(true);
    dir = mkdtempSync(join(tmpdir(), "al-report-cli-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("renders a valid report as owner-only, script-free HTML that labels the provider and shows verification", async () => {
    const r = await render("valid", reportData([lease()]));
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.html).toContain("SYNTHETIC");
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(/https?:\/\/(?!localhost)/);
    expect(r.html).toContain("introspection:absent+probe:denied");
    expect(statSync(r.out).mode & 0o077, "report file must not be group/world accessible").toBe(0);
  });

  it("exits 4 and shows an unresolved warning, never green, when a lease is unconfirmed (lowercase or uppercase state)", async () => {
    for (const state of ["revocation_unconfirmed", "REVOCATION_UNCONFIRMED"]) {
      const r = await render(`unconfirmed-${state === state.toLowerCase() ? "lower" : "upper"}`, reportData([lease({ state, revocation_status: "unconfirmed", last_verified_at: null, next_retry_at: "2026-01-01T01:05:00.000Z", warning: "Revocation could not be verified." })], { issue_unknown: 0, revocation_unconfirmed: 1 }));
      expect(r.code, state).toBe(4);
      expect(r.html).toMatch(/tone-uncertain/);
      expect(r.html).not.toMatch(/tone-verified" data-state="revocation_unconfirmed"/i);
      expect(r.html).toContain("do not read as success");
    }
  });

  it("hostile markup, control characters and bidirectional overrides are escaped to inert text", async () => {
    const r = await render("hostile", reportData([lease({ task_ref: HOSTILE_HTML[0], subject_ref: HOSTILE_HTML[1], resource_ref: `${HOSTILE_HTML[2]}‮\u0007`, scopes: [HOSTILE_HTML[3]], warning: HOSTILE_HTML[4] })]));
    expect([0, 2], `${r.stdout}\n${r.stderr}`).toContain(r.code);
    if (r.html) {
      expect(r.html).not.toMatch(/<script/i);
      expect(r.html).not.toMatch(/<img[^>]*onerror/i);
      expect(r.html).not.toMatch(/<iframe/i);
      expect(r.html).not.toMatch(/<svg[^>]*onload/i);
      expect(r.html).not.toMatch(/href="javascript:/i);
      expect(r.html).toContain("&lt;script&gt;");
    }
  });

  it("planted secret tokens in the data never appear in the rendered report or the CLI output", async () => {
    const pieces = plantedPieces("data");
    const r = await render("secrets", reportData([lease({ task_ref: pieces[0], subject_ref: pieces[1], resource_ref: pieces[2], warning: pieces[3], audit: [{ occurred_at: "2026-01-01T01:00:00.000Z", actor_ref: pieces[0], action: pieces[1], metadata: { reason: pieces[2] } }] })]));
    expect(leakedSecrets(`${r.html ?? ""}\n${r.stdout}\n${r.stderr}`)).toEqual([]);
  });

  it("a truncated report says so, reports whole-workspace counts, exits 4 and refuses inconsistent totals", async () => {
    const shown = [lease()];
    const truncated = await render("truncated-report", reportData(shown, { issue_unknown: 0, revocation_unconfirmed: 0 }, { truncated: true, workspace_total: 6000, summary: { by_state: { revoked_verified: 5990, revocation_unconfirmed: 10 }, unresolved: { issue_unknown: 0, revocation_unconfirmed: 10 }, max_revocation_request_delay_seconds: 3 } }));
    expect(truncated.code, `${truncated.stdout}\n${truncated.stderr}`).toBe(4);
    expect(truncated.html).toMatch(/INCOMPLETE|incomplete|truncated|1 of 6000|6000/);
    expect(truncated.html).not.toMatch(/No lease in this report is in an unresolved state/);
    const lying = await render("lying-totals", reportData(shown, undefined, { truncated: false, workspace_total: 6000 }));
    expect(lying.code, "a report that claims to be complete while the totals disagree must be refused").toBe(2);
    expect(lying.html).toBeNull();
  });

  it("a truncated report exits 4 with the incomplete banner even when nothing that is listed is unresolved (html and json)", async () => {
    const data = reportData([lease()], { issue_unknown: 0, revocation_unconfirmed: 0 }, { truncated: true, workspace_total: 6000 });
    const html = await render("trunc-quiet-html", data);
    expect(html.code, `${html.stdout}\n${html.stderr}`).toBe(4);
    expect(html.html).toMatch(/INCOMPLETE|incomplete|1 of 6000|6000/);
    expect(`${html.stdout}\n${html.stderr}`).toMatch(/INCOMPLETE|incomplete/);
    const json = await render("trunc-quiet-json", data, ["--format", "json"]);
    expect(json.code).toBe(4);
    expect(JSON.parse(json.html ?? "{}")).toMatchObject({ truncated: true, workspace_total: 6000 });
  });

  it("a file that omits the truncated flag, or declares an impossible total, is refused with exit 2 and no report", async () => {
    const { truncated: _omit, ...withoutFlag } = reportData([lease()]);
    const missing = await render("missing-truncated", withoutFlag);
    expect(missing.code).toBe(2);
    expect(missing.html).toBeNull();
    const impossible = await render("impossible-total", reportData([lease(), lease({ id: "lease-2" })], undefined, { truncated: true, workspace_total: 1 }));
    expect(impossible.code, "workspace_total smaller than the listed leases is impossible").toBe(2);
    expect(impossible.html).toBeNull();
  });

  it("an unknown state string is shown as unrecognised, never as success", async () => {
    const r = await render("unknown-state", reportData([lease({ state: "<b>great</b>", revocation_status: "verified" })]));
    expect(r.html).not.toContain("<b>great</b>");
    expect(r.html).not.toMatch(/tone-verified[^>]*data-state="&lt;b/);
    expect(r.html).toMatch(/Unrecognised state/);
  });

  it("refuses oversize, truncated, malformed and over-limit input before rendering, exit 2, and writes no report", async () => {
    const big = await render("oversize", Buffer.alloc(26 * 1024 * 1024, 0x20));
    expect(big.code).toBe(2);
    expect(big.html).toBeNull();
    const truncated = await render("truncated", Buffer.from(JSON.stringify(reportData([lease()])).slice(0, 120)));
    expect(truncated.code).toBe(2);
    expect(truncated.html).toBeNull();
    const wrongType = await render("wrong-type", reportData([lease({ scopes: "not-an-array" })]));
    expect(wrongType.code).toBe(2);
    const longText = await render("long-text", reportData([lease({ task_ref: "x".repeat(100_000) })]));
    expect(longText.code).toBe(2);
    expect(longText.html).toBeNull();
    const many = await render("too-many", reportData(Array.from({ length: 5001 }, (_, i) => lease({ id: `lease-${i}` }))));
    expect(many.code, "more leases than the report limit must be refused with an explanation, not crash or render a partial report").toBe(2);
    expect(`${many.stdout}\n${many.stderr}`.length).toBeGreaterThan(20);
    expect(many.html).toBeNull();
    const binary = await render("binary", Buffer.from([0, 255, 254, 1, 2, 3]));
    expect(binary.code).toBe(2);
    const nested = await render("nested", Buffer.from(`${"[".repeat(100_000)}${"]".repeat(100_000)}`));
    expect([2]).toContain(nested.code);
  });

  it("a report with the maximum number of leases renders quickly and completely", async () => {
    const started = Date.now();
    const r = await render("max", reportData(Array.from({ length: 5000 }, (_, i) => lease({ id: `lease-${i}`, task_ref: `TASK-${i}` }))));
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(r.html).toContain("TASK-4999");
  });

  it("does not overwrite an existing report without --force, refuses a symlink target and never follows it", async () => {
    const data = reportData([lease()]);
    const first = await render("overwrite", data);
    expect(first.code).toBe(0);
    const second = await render("overwrite", data);
    expect(second.code).toBe(2);
    const forced = await render("overwrite", data, ["--force"]);
    expect(forced.code).toBe(0);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    const link = join(dir, "link.html");
    symlinkSync(victim, link);
    const input = join(dir, "link.json");
    writeFileSync(input, JSON.stringify(data));
    const viaLink = await runToCompletion(process.execPath, [cli, "report", "--from-data", input, "--out", link, "--force"], {});
    expect(viaLink.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("leaves an existing parent directory's permissions alone", async () => {
    const shared = mkdtempSync(join(tmpdir(), "al-shared-"));
    try {
      const { chmodSync } = await import("node:fs");
      chmodSync(shared, 0o755);
      const input = join(dir, "perm.json");
      writeFileSync(input, JSON.stringify(reportData([lease()])));
      const r = await runToCompletion(process.execPath, [cli, "report", "--from-data", input, "--out", join(shared, "report.html")], {});
      expect(r.code).toBe(0);
      expect(statSync(shared).mode & 0o777, "a directory the tool did not create must not be re-permissioned").toBe(0o755);
      expect(statSync(join(shared, "report.html")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });
});
