import { describe, expect, it } from "vitest";
import { parseReportData } from "../../../src/report/data-schema";
import { reportModelFromData } from "../../../src/report/from-data";
import { renderReport } from "../../../src/report/render";
import { formatMetadata } from "../../../src/report/status";
import { lease, reportData } from "./fakes";

describe("audit metadata is shown, escaped and bounded", () => {
  it("formats scalar metadata only, sorted, bounded", () => {
    expect(formatMetadata({ reason: "task done", count: 2, ok: true, nested: { x: 1 }, list: [1] })).toBe("count=2; ok=true; reason=task done");
    expect(formatMetadata({})).toBe("");
    expect(formatMetadata(null)).toBe("");
    expect(formatMetadata([1, 2])).toBe("");
    expect(formatMetadata({ a: "x".repeat(300) }).length).toBe(200);
  });

  it("puts the revocation reason in the static report and escapes hostile metadata", () => {
    const l = lease();
    l.audit = [{ ...l.audit[0]!, action: "lease.revoke_requested", metadata: { reason: "<script>alert(1)</script> token=planted-fake-secret-1" } }];
    const html = renderReport(reportModelFromData(reportData([l])));
    expect(html).toContain("<th scope=\"col\">Details</th>");
    expect(html).toContain("reason=&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("planted-fake");
  });

  it("accepts saved report data whose audit rows carry metadata and rejects non-object metadata", () => {
    const data = reportData([lease()]);
    expect(() => parseReportData(JSON.stringify(data))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(data));
    bad.leases[0].audit[0].metadata = "nope";
    expect(() => parseReportData(JSON.stringify(bad))).toThrow(/metadata/);
  });
});
