import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/process.js";

// A real child executes the shipped oracle; only its npx/Vitest process is a local shim.
// These are protocol controls, separate from the gate's actual native clean/seeded Vitest pair.
const SHIM = `
const fs = require("node:fs");
const path = require("node:path");
const seeded = process.env.ACCESSLEASE_SEEDED_FAILURE === "1";
const scenario = process.env.AL_CONTROL_SCENARIO;
const prefix = seeded ? "seeded" : "clean";
if (scenario === prefix + "-signal") process.kill(process.pid, "SIGTERM");
if (scenario === prefix + "-missing") process.exit(seeded ? 1 : 0);
const reportArg = process.argv.find((a) => a.startsWith("--outputFile.json="));
const file = reportArg?.slice("--outputFile.json=".length);
const xmlArg = process.argv.find((a) => a.startsWith("--outputFile.junit="));
const xml = xmlArg?.slice("--outputFile.junit=".length);
if (seeded && scenario === "seeded-invalid-json") { if(file) fs.writeFileSync(file,"{bad"); process.exit(1); }
const name = "seeded mandatory failure (negative control) mandatory control stays green unless a failure is seeded";
const assertion = { fullName: name, title: "mandatory control stays green unless a failure is seeded", ancestorTitles: ["seeded mandatory failure (negative control)"], status: seeded ? "failed" : "passed", failureMessages: seeded ? ['AssertionError: expected \\'seeded-failure-active\\' to be \\'no-failure-seeded\\' // Object.is equality'] : [] };
let status = seeded ? 1 : 0;
if (seeded && scenario === "seeded-pass") { status=0; assertion.status="passed"; assertion.failureMessages=[]; }
if (scenario === "clean-failure") { status=1; assertion.status="failed"; assertion.failureMessages=["AssertionError: clean control failed"]; }
if (seeded && scenario === "seeded-wrong-name") assertion.fullName="unrelated test";
if (seeded && scenario === "seeded-unrelated-assertion") assertion.failureMessages=["AssertionError: expected false to be true"];
if (seeded && scenario === "seeded-exit2") status=2;
const assertions = seeded && scenario === "seeded-setup" ? [] : [assertion];
if (seeded && scenario === "seeded-mixed") assertions.push({ ...assertion, fullName: "unrelated failure", failureMessages: ["AssertionError: expected false to be true"] });
const failed=assertions.filter(a=>a.status==="failed").length;
const report={success:status===0,numTotalTests:assertions.length,numPassedTests:assertions.length-failed,numFailedTests:failed,numPendingTests:0,numTodoTests:0,numRuntimeErrorTestSuites:seeded && scenario==="seeded-setup"?1:0,testResults:[{name:path.resolve("tests/negative-controls/seeded-failure.test.ts"),status:status===0?"passed":"failed",assertionResults:assertions,message:seeded && scenario==="seeded-setup"?"Error: setup failed":""}]};
if(file)fs.writeFileSync(file,JSON.stringify(report));
if(xml)fs.writeFileSync(xml,'<testsuites tests="1" failures="'+failed+'" errors="'+(seeded && scenario === "seeded-unhandled"?1:0)+'"></testsuites>');
if (!seeded && scenario === "seeded-spawn") fs.unlinkSync(process.argv[1]);
process.exit(status);
`;

function run(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), "al-seeded-control-"));
  try {
    const npx = join(dir, "npx");
    writeFileSync(npx, `#!${process.execPath}\n${SHIM}`, { mode: 0o755 });
    chmodSync(npx, 0o755);
    return spawnSync(process.execPath, [join(repoRoot, "scripts/verify-seeded-failure.mjs")], {
      cwd: repoRoot,
      env: { PATH: dir, AL_CONTROL_SCENARIO: scenario },
      encoding: "utf8",
      timeout: 15_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("seeded failure oracle protocol (isolated fake runner)", () => {
  it("accepts the clean assertion and exactly the intended seeded assertion failure", () => {
    const r = run("valid");
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("verdict is RED");
  });

  it.each(["clean-failure", "clean-signal", "clean-missing"])("refuses an unproven baseline: %s", (scenario) => {
    const r = run(scenario);
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).not.toContain("un-seeded run passes");
    expect(r.stdout).not.toContain("verdict is RED");
  });

  it.each(["seeded-signal", "seeded-spawn", "seeded-missing", "seeded-invalid-json", "seeded-setup", "seeded-wrong-name", "seeded-unrelated-assertion", "seeded-mixed", "seeded-unhandled", "seeded-exit2", "seeded-pass"])("refuses an unproven intended assertion kill: %s", (scenario) => {
    const r = run(scenario);
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout, "the baseline must have genuinely passed before the seeded fault").toContain("un-seeded run passes");
    expect(r.stdout).not.toContain("verdict is RED");
  });
});
