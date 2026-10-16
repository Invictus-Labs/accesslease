import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("SECURITY-005: CLI diagnostic boundary redacts reflected input", () => {
  const validationSecret = "PLANTED_SECRET_TOKEN_cli_validation_04";
  const invalidData = (key: string) => {
    const data = reportData();
    return { ...data, summary: { ...data.summary, by_state: { ...data.summary.by_state, [key]: "invalid" } } };
  };

  it("redacts an invalid report record key while preserving the validation error and exit 2", async () => {
    const input = join(dir, "invalid.json");
    const output = join(dir, "rejected.json");
    writeFileSync(input, JSON.stringify(invalidData(validationSecret)));
    const cap = capture();
    const code = await runCommand(["report", "--from-data", input, "--format", "json", "--out", output], {}, cap.io, noServices);
    expect(code).toBe(2);
    expect(cap.out).toEqual([]);
    expect(existsSync(output)).toBe(false);
    expect(cap.err.join("\n")).not.toContain(validationSecret);
    expect(cap.err.join("\n")).toContain("invalid report data at summary.by_state.");
    expect(cap.err.join("\n")).toMatch(/redacted/i);
    expect(cap.err.join("\n")).toContain("expected number");
  });

  it.each([[validationSecret], ["help", validationSecret]])("redacts an unknown command or help topic: %j", async (...argv) => {
    const cap = capture();
    const code = await runCommand(argv, {}, cap.io, noServices);
    expect(code).toBe(2);
    expect(cap.out).toEqual([]);
    expect(cap.err.join("\n")).not.toContain(validationSecret);
    expect(cap.err.join("\n")).toMatch(/unknown command \[redacted\]/i);
    expect(cap.err.join("\n")).toContain("usage: accesslease <command> [options]");
  });

  it("redacts the same invalid report diagnostic through the packaged CLI subprocess", () => {
    const input = join(dir, "packaged-invalid.json");
    writeFileSync(input, JSON.stringify(invalidData(validationSecret)));
    const cli = fileURLToPath(new URL("../../../dist/src/cli.js", import.meta.url));
    expect(existsSync(cli), "build the packaged server CLI before this test").toBe(true);
    const result = spawnSync(process.execPath, [cli, "report", "--from-data", input, "--format", "json"], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(validationSecret);
    expect(result.stderr).toContain("invalid report data at summary.by_state.");
    expect(result.stderr).toMatch(/redacted/i);
  });

  it("preserves a benign unknown-command diagnostic and usage", async () => {
    const cap = capture();
    expect(await runCommand(["ordinary-missing-command"], {}, cap.io, noServices)).toBe(2);
    expect(cap.err.join("\n")).toContain("unknown command ordinary-missing-command\nusage: accesslease <command> [options]");
    expect(cap.err.join("\n")).not.toContain("[redacted]");
  });

  it("preserves a benign invalid report path and validation meaning", async () => {
    const input = join(dir, "ordinary-invalid.json");
    writeFileSync(input, JSON.stringify(invalidData("ordinary_state")));
    const cap = capture();
    expect(await runCommand(["report", "--from-data", input, "--format", "json"], {}, cap.io, noServices)).toBe(2);
    expect(cap.err.join("\n")).toContain("invalid report data at summary.by_state.ordinary_state");
    expect(cap.err.join("\n")).toContain("expected number");
    expect(cap.err.join("\n")).not.toMatch(/redacted/i);
  });
});
