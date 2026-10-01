import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand, type CommandDeps } from "../../../src/commands";
import { recountUnresolved, unresolvedInReport } from "../../../src/report/from-data";
import { ReportInputError } from "../../../src/report/model";
import { capture, lease, reportData } from "./fakes";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "al-rexit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const noSvc = { services: async () => { throw new Error("must not load services"); } } as CommandDeps;
const fromData = async (data: unknown, extra: string[] = []) => {
  const file = join(dir, "data.json");
  writeFileSync(file, JSON.stringify(data));
  const cap = capture();
  const code = await runCommand(["report", "--from-data", file, ...extra], {}, cap.io, noSvc);
  return { code, out: cap.out.join("\n"), err: cap.err.join("\n") };
};

describe("R-003: report --from-data counts unresolved leases itself", () => {
  it("exits 2 and writes nothing when the summary says nothing is unresolved but a lease is", async () => {
    const data = reportData([lease({ state: "revocation_unconfirmed" as never, last_verified_at: null })]);
    data.summary.unresolved = { issue_unknown: 0, revocation_unconfirmed: 0 };
    const out = join(dir, "out.html");
    const r = await fromData(data, ["--out", out]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("report summary disagrees with its leases");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses the same disagreement for JSON output and the other direction (summary claims more than the leases show)", async () => {
    const hidden = reportData([lease({ state: "ISSUE_UNKNOWN" })]);
    hidden.summary.unresolved = { issue_unknown: 0, revocation_unconfirmed: 0 };
    expect((await fromData(hidden, ["--format", "json"])).code).toBe(2);
    const inflated = reportData([lease()]);
    inflated.summary.unresolved = { issue_unknown: 2, revocation_unconfirmed: 0 };
    const r = await fromData(inflated);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });

  it("counts an unrecognised state as unresolved (exit 4, red alert) even with a clean summary", async () => {
    const data = reportData([lease({ state: "EXPIRED" as never, last_verified_at: null })]);
    data.summary.unresolved = { issue_unknown: 0, revocation_unconfirmed: 0 };
    const r = await fromData(data);
    expect(r.code).toBe(4);
    expect(r.err).toContain("1 lease(s) are in an unresolved state");
    expect(r.out).toContain("Unrecognised state: EXPIRED");
    expect(r.out).toContain('role="alert"');
  });

  it("counts a verified record without a verification time as unresolved", async () => {
    const r = await fromData(reportData([lease({ state: "REVOKED_VERIFIED", last_verified_at: null })]));
    expect(r.code).toBe(4);
    expect(r.out).toContain("Revoked state without verification time");
  });

  it("accepts a consistent report in either case and exits 4 only when something is unresolved", async () => {
    const lowerUnresolved = reportData([lease({ state: "revocation_unconfirmed" as never, last_verified_at: null })]);
    expect((await fromData(lowerUnresolved)).code).toBe(4);
    expect((await fromData(reportData([lease({ state: "revoked_verified" as never })]))).code).toBe(0);
    expect((await fromData(reportData([]))).code).toBe(0);
  });

  it("recounts from the leases", () => {
    const data = reportData([lease({ state: "issue_unknown" as never }), lease({ state: "REVOCATION_UNCONFIRMED" }), lease({ state: "WEIRD" as never }), lease()]);
    expect(recountUnresolved(data)).toEqual({ issueUnknown: 1, revocationUnconfirmed: 1, other: 1 });
    expect(unresolvedInReport(data)).toBe(3);
    const lie = reportData([lease({ state: "ISSUE_UNKNOWN" })]);
    lie.summary.unresolved = { issue_unknown: 0, revocation_unconfirmed: 0 };
    expect(() => unresolvedInReport(lie)).toThrow(ReportInputError);
  });
});
