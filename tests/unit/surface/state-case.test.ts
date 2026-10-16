import { describe, expect, it } from "vitest";
import { reportModelFromData } from "../../../src/report/from-data";
import { renderReport } from "../../../src/report/render";
import { lease, reportData } from "./fakes";

describe("report data with lowercase wire states", () => {
  it("normalises states so unresolved leases still show as warnings", () => {
    const l = lease({ state: "revocation_unconfirmed" as never, last_verified_at: null });
    const model = reportModelFromData(reportData([l, lease({ state: "revoked_verified" as never })]));
    expect(model.leases.map((x) => x.state)).toEqual(["REVOCATION_UNCONFIRMED", "REVOKED_VERIFIED"]);
    const html = renderReport(model);
    expect(html).toContain("1 unresolved state: do not read as success");
    expect(html).toContain('data-state="REVOCATION_UNCONFIRMED"');
  });
});
