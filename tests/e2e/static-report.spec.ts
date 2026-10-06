import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { HOSTILE_HTML } from "../helpers/hostile.js";
import { leakedSecrets, plantedCarrier } from "../helpers/secrets.js";
import { repoRoot, runToCompletion } from "../helpers/process.js";
import { startStack, type Stack } from "./stack.js";

/**
 * Static-report browser smoke: the report produced by the packaged CLI is opened in a real browser. It must escape hostile text,
 * show readable tables, flag unresolved states, state the provider honestly and render the empty and error cases.
 */
let stack: Stack;
let dir: string;
const cli = join(repoRoot, "dist/src/cli.js");

test.beforeAll(async () => {
  // The embedded worker passes once at start, then sleeps for the poll interval. With the default 250 ms it could verify the
  // revoked lease before the report is generated, legitimately turning it green; the maximum interval keeps it unresolved.
  stack = await startStack({ workerPollMs: 60_000 });
  dir = mkdtempSync(join(tmpdir(), "al-report-"));
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("an empty installation renders an explicit empty report", async ({ page }) => {
  const out = join(dir, "empty.html");
  const r = await runToCompletion(process.execPath, [cli, "report", "--out", out], stack.env);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  await page.goto(`file://${out}`);
  await expect(page.getByText("No leases in this report.")).toBeVisible();
  await expect(page.getByText(/No lease in this report is in an unresolved state/)).toBeVisible();
  expect(await page.locator("script").count()).toBe(0);
});

test("hostile fields and planted secrets render as inert, redacted text in a table-based report; unresolved states are flagged", async ({ page }) => {
  const created = await stack.client.post(stack.operator.session, "/leases", {
    task_ref: `${HOSTILE_HTML[0]} ${plantedCarrier("report")}`.slice(0, 190),
    subject_ref: HOSTILE_HTML[2],
    resource_ref: stack.target.database,
    scopes: ["pg:app.records:select"],
  });
  expect(created.status).toBe(201);
  await stack.client.post(stack.operator.session, `/leases/${created.body.id}/revoke`, { reason: HOSTILE_HTML[3] });
  const out = join(dir, "hostile.html");
  const r = await runToCompletion(process.execPath, [cli, "report", "--out", out], stack.env);
  expect([0, 4]).toContain(r.code);
  const html = readFileSync(out, "utf8");
  expect(leakedSecrets(html)).toEqual([]);
  expect(html).not.toContain("<script>window.__al_xss");
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/https?:\/\/(?!localhost)/i); // no external resources
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.goto(`file://${out}`);
  await expect(page.locator("h3").first()).toContainText("<script>window.__al_xss = 1</script>");
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__al_xss)).toBeUndefined();
  expect(await page.locator("script, img[src='x'], svg[onload], iframe").count()).toBe(0);
  expect(dialogs).toEqual([]);
  // Readable tables: captions, header cells with scope, and at least the overview and summary tables.
  const headers = page.locator("table thead th[scope='col']");
  expect(await headers.count()).toBeGreaterThan(4);
  expect(await page.locator("table caption").count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/SYNTHETIC|PostgreSQL role/).first()).toBeVisible();
  // Nothing is green unless verified: no verified badge exists for a lease that was never revoked and verified.
  await expect(page.locator("section.lease .tone-verified, #overview-h ~ table .tone-verified")).toHaveCount(0);
  await expect(page.locator("section.lease.unresolved, section.lease")).not.toHaveCount(0);
});

test("a corrupt report-data file produces an error exit and no report claiming success", async () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, '{"schema_version": 1, "leases": "nope"');
  const out = join(dir, "bad.html");
  const r = await runToCompletion(process.execPath, [cli, "report", "--from-data", bad, "--out", out], stack.env);
  expect(r.code).not.toBe(0);
  expect(r.code).not.toBeNull();
  expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/report written/);
});
