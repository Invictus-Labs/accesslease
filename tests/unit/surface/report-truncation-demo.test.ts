import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../../src/commands";
import { capture, fakeServices, lease, reportData } from "./fakes";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "al-trunc-demo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("R-002: demo", () => {
  it("exits 4 and says so when the demo report is truncated", async () => {
    const out = join(dir, "demo");
    const { svc } = fakeServices();
    const data = reportData([lease(), lease({ id: "b" })]);
    data.truncated = true;
    data.workspace_total = 5;
    data.summary.by_state = { revoked_verified: 5 } as never;
    (svc.runDemo as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: { kind: "synthetic", label: "SYNTHETIC", live: false },
      reportData: data,
      bundle: { bytes: Buffer.from("{}"), bundle_hash: "h".repeat(64), lease_count: 2, file_count: 3 },
      files: { reportData: join(out, "report-data.json"), bundle: join(out, "evidence-bundle.json") },
      unresolved: { issueUnknown: 0, revocationUnconfirmed: 0 },
    });
    const cap = capture();
    const code = await runCommand(["demo", "--out", out, "--database-url", "postgres://u@localhost:5432/d"], {}, cap.io, { services: async () => svc });
    expect(code).toBe(4);
    expect(cap.err.join("\n")).toContain("the demo report is INCOMPLETE: it lists 2 of 5 leases");
  });
});
