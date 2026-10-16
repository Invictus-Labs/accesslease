import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand, type CommandDeps } from "../../../src/commands";
import { reportModelFromData, unresolvedInReport } from "../../../src/report/from-data";
import { renderReport } from "../../../src/report/render";
import type { ReportData } from "../../../src/services/contract";
import { capture, fakeServices, lease, reportData } from "./fakes";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "al-trunc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const noSvc = { services: async () => { throw new Error("must not load services"); } } as CommandDeps;
const run = async (data: unknown, extra: string[] = []) => {
  const file = join(dir, "data.json");
  writeFileSync(file, JSON.stringify(data));
  const cap = capture();
  const code = await runCommand(["report", "--from-data", file, ...extra], {}, cap.io, noSvc);
  return { code, out: cap.out.join("\n"), err: cap.err.join("\n") };
};

/** A truncated report: 2 listed leases out of 5 in the workspace, whole-workspace summary. */
const truncated = (over: { unresolvedHidden?: boolean } = {}): ReportData => {
  const d = reportData([lease(), lease({ id: "b" })]);
  d.truncated = true;
  d.workspace_total = 5;
  d.summary.total = 5;
  d.summary.by_state = { revoked_verified: over.unresolvedHidden ? 3 : 5 } as never;
  if (over.unresolvedHidden) {
    (d.summary.by_state as Record<string, number>).revocation_unconfirmed = 2;
    d.summary.unresolved = { issue_unknown: 0, revocation_unconfirmed: 2 };
  }
  return d;
};

describe("R-002: truncated reports are never success", () => {
  it("shows a prominent banner and whole-workspace counts, and exits 4 even when nothing listed is unresolved", async () => {
    const r = await run(truncated());
    expect(r.code).toBe(4);
    expect(r.err).toContain("the report is INCOMPLETE: it lists 2 of 5 leases");
    expect(r.err).toContain("Exiting with code 4");
    expect(r.out).toContain("Incomplete report: showing 2 of 5 leases");
    expect(r.out).toContain('role="alert"');
    expect(r.out).toContain("Leases by state (whole workspace)");
    expect(r.out).toContain("this says nothing about the leases that are not listed");
    expect(r.out).not.toContain("No lease in this report is in an unresolved state");
  });

  it("exits 4 for JSON output too", async () => {
    expect((await run(truncated(), ["--format", "json"])).code).toBe(4);
  });

  it("reports hidden unresolved leases from the whole-workspace summary and counts them", async () => {
    const data = truncated({ unresolvedHidden: true });
    expect(unresolvedInReport(data)).toBe(2);
    const r = await run(data);
    expect(r.code).toBe(4);
    expect(r.err).toContain("2 lease(s) are in an unresolved state");
    expect(r.out).toContain("The workspace has 2 unresolved leases in total");
    expect(renderReport(reportModelFromData(data))).toContain("<th scope=\"col\">Count</th>");
  });

  it("singularises and refuses a truncated summary that is smaller than what is listed", async () => {
    const one = truncated({ unresolvedHidden: true });
    one.summary.unresolved = { issue_unknown: 0, revocation_unconfirmed: 1 };
    expect(renderReport(reportModelFromData(one))).toContain("1 unresolved lease in total");
    const lie = truncated();
    lie.leases[0] = lease({ state: "REVOCATION_UNCONFIRMED", last_verified_at: null });
    const r = await run(lie);
    expect(r.code).toBe(2);
    expect(r.err).toContain("report summary disagrees with its leases");
  });

  it("accepts an older file without the field only if its own summary total equals the listed leases", async () => {
    const old = JSON.parse(JSON.stringify(reportData([lease()])));
    delete old.truncated;
    delete old.workspace_total;
    const ok = await run(old);
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain("Incomplete report");
    const mismatch = JSON.parse(JSON.stringify(old));
    mismatch.summary.total = 7;
    const bad = await run(mismatch);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("does not say whether it is complete");
    const noTotal = JSON.parse(JSON.stringify(old));
    delete noTotal.summary.total;
    expect((await run(noTotal)).code).toBe(2);
    const conflicting = JSON.parse(JSON.stringify(old));
    conflicting.workspace_total = 9;
    expect((await run(conflicting)).code).toBe(2);
  });

  it("refuses a present truncated flag without a workspace total, and a truncated report without by_state", async () => {
    const noTotal = JSON.parse(JSON.stringify(truncated()));
    delete noTotal.workspace_total;
    expect((await run(noTotal)).err).toContain("workspace_total: required");
    const noByState = JSON.parse(JSON.stringify(truncated()));
    delete noByState.summary.by_state;
    expect((await run(noByState)).err).toContain("summary.by_state");
  });

  it("refuses reports whose totals are inconsistent", async () => {
    const notTruncatedButMore = reportData([lease()]);
    notTruncatedButMore.workspace_total = 4;
    const a = await run(notTruncatedButMore);
    expect(a.code).toBe(2);
    expect(a.err).toContain("workspace_total");
    const tooSmall = truncated();
    tooSmall.workspace_total = 1;
    expect((await run(tooSmall)).code).toBe(2);
  });

  it("a complete report has no banner and no whole-workspace counts", async () => {
    const r = await run(reportData([lease()]));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Incomplete report");
    expect(r.out).not.toContain("whole workspace");
  });
});
