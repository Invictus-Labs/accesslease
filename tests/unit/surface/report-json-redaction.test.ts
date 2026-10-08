import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand, type CommandDeps } from "../../../src/commands";
import { capture, lease, reportData } from "./fakes";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "al-json-redaction-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const noServices: CommandDeps = { services: async () => { throw new Error("offline report must not load services"); } };
const planted = "PLANTED_SECRET_TOKEN_security_03";
const nestedPlanted = "PLANTED_SECRET_TOKEN_nested_03";
const secretKey = "PLANTED_SECRET_TOKEN_metadata_key_03";

async function report(data: unknown, toFile = false) {
  const input = join(dir, "input.json");
  const output = join(dir, "report.json");
  writeFileSync(input, JSON.stringify(data));
  const cap = capture();
  const code = await runCommand(["report", "--from-data", input, "--format", "json", ...(toFile ? ["--out", output] : [])], {}, cap.io, noServices);
  const body = toFile ? readFileSync(output, "utf8") : cap.out.join("\n");
  return { code, body, stdout: cap.out.join("\n"), stderr: cap.err.join("\n"), output };
}

describe("SECURITY-003: offline JSON reports share the report redaction boundary", () => {
  it.each([false, true])("redacts task text, nested metadata values and secret-bearing metadata keys (file=%s)", async (toFile) => {
    const item = lease({ task_ref: planted });
    item.audit[0]!.metadata = {
      password: "opaque-example-credential",
      nested: [{ note: nestedPlanted, benign: "keep this note", [secretKey]: "ordinary value" }],
      count: 3,
      verified: false,
    };
    const data = reportData([item]);
    const r = await report(data, toFile);
    expect(r.code).toBe(0);
    for (const sensitive of [planted, nestedPlanted, secretKey, "opaque-example-credential"]) {
      expect(`${r.body}\n${r.stdout}\n${r.stderr}`).not.toContain(sensitive);
    }
    const parsed = JSON.parse(r.body);
    expect(parsed.leases[0].task_ref).toMatch(/redacted/i);
    expect(parsed.leases[0].audit[0].metadata.password).toMatch(/redacted/i);
    expect(parsed.leases[0].audit[0].metadata.nested[0].benign).toBe("keep this note");
    expect(parsed.leases[0].audit[0].metadata).toMatchObject({ count: 3, verified: false });
    expect(parsed.summary).toEqual(data.summary);
    expect(parsed).toMatchObject({ truncated: false, workspace_total: 1, contains_synthetic: true });
    expect(parsed.leases[0]).toMatchObject({ state: item.state, revocation_status: item.revocation_status, last_verified_at: item.last_verified_at });
    if (toFile) expect(statSync(r.output).mode & 0o777).toBe(0o600);
  });

  it("preserves a benign complete JSON report exactly", async () => {
    const data = reportData();
    const r = await report(data);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.body)).toEqual(data);
    expect(r.stderr).toBe("");
  });

  it("retains distinct metadata counts when secret-bearing keys share a masked name", async () => {
    const item = lease();
    item.audit[0]!.metadata = { "[redacted]": 4, [secretKey]: 5, [nestedPlanted]: 6 };
    const r = await report(reportData([item]));
    expect(r.code).toBe(0);
    expect(r.body).not.toContain(secretKey);
    expect(r.body).not.toContain(nestedPlanted);
    const metadata = JSON.parse(r.body).leases[0].audit[0].metadata;
    expect(Object.keys(metadata)).toHaveLength(3);
    expect(metadata["[redacted]"]).toBe(4);
    expect(Object.values(metadata).sort()).toEqual([4, 5, 6]);
  });

  it.each(["unknown", "truncated"])("keeps %s reports unresolved without changing status, counts or completeness", async (kind) => {
    const item = lease({ state: kind === "unknown" ? "FUTURE_STATE" as never : "REVOCATION_UNCONFIRMED", last_verified_at: null, warning: planted });
    const data = reportData([item]);
    if (kind === "truncated") {
      data.truncated = true;
      data.workspace_total = 7;
      data.summary.total = 7;
      data.summary.by_state = { revoked_verified: 4, revocation_unconfirmed: 3 } as typeof data.summary.by_state;
      data.summary.unresolved.revocation_unconfirmed = 3;
    }
    const r = await report(data);
    expect(r.code).toBe(4);
    expect(r.body).not.toContain(planted);
    const parsed = JSON.parse(r.body);
    expect(parsed.summary).toEqual(data.summary);
    expect(parsed.leases[0].state).toBe(item.state);
    expect(parsed.leases[0].last_verified_at).toBeNull();
    expect(parsed.truncated).toBe(data.truncated);
    expect(parsed.workspace_total).toBe(data.workspace_total);
    expect(r.stderr).toContain("this is not success");
  });
});
