import { expect, test, type Page } from "@playwright/test";
import { openSession, roleFacts, tryConnect } from "../helpers/db.js";
import { pauseProvider, unpauseProvider } from "../helpers/docker.js";
import { HOSTILE_HTML } from "../helpers/hostile.js";
import { providerRoleFor } from "../helpers/oracle.js";
import { startStack, type Stack } from "./stack.js";

/**
 * Browser E2E against a real stack (packaged CLI server, real PostgreSQL, real postgres-role provider on the disposable cluster).
 * No route mocking anywhere. Uncertain states must render as warnings and never as the green verified state.
 */
let stack: Stack;
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  unpauseProvider();
  await stack?.stop();
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(stack.baseUrl);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(stack.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

const badge = (page: Page) => page.locator("main [data-state]").first();
const fillLease = async (page: Page, over: Partial<{ task: string; subject: string; scopes: string; minutes: string }> = {}) => {
  await page.getByLabel("Task reference").fill(over.task ?? "TASK-E2E");
  await page.getByLabel("Subject (who receives access)").fill(over.subject ?? "contractor-e2e@example.invalid");
  await page.getByLabel("Resource").fill(stack.target.database);
  await page.getByLabel(/Scopes/).fill(over.scopes ?? "pg:app.records:select");
  await page.getByLabel(/Duration in minutes/).fill(over.minutes ?? "60");
  await page.getByRole("button", { name: "Request lease" }).click();
};

test("a fresh installation shows the empty lease list and the sign-in failure state", async ({ page }) => {
  await page.goto(stack.baseUrl);
  await page.getByLabel("Email").fill(stack.operator.email);
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await signIn(page, stack.operator.email);
  await expect(page.getByText("No leases yet.")).toBeVisible();
  await expect(page.getByText(`e2e-workspace`)).toBeVisible();
});

test("operator walks a lease from request to verified revocation; access works only while the lease is live", async ({ page }) => {
  await signIn(page, stack.operator.email);
  await page.getByRole("link", { name: "New lease" }).click();
  await fillLease(page, { task: "TASK-E2E-HAPPY" });
  await expect(page.getByRole("heading", { name: "TASK-E2E-HAPPY" })).toBeVisible();
  await expect(badge(page)).toHaveAttribute("data-state", "REQUESTED");
  await page.getByRole("button", { name: "Approve this exact request" }).click();
  await expect(badge(page)).toHaveAttribute("data-state", "ACTIVE", { timeout: 30_000 });
  await expect(badge(page)).not.toHaveAttribute("data-tone", "verified");

  await page.getByRole("button", { name: /Retrieve credential/ }).click();
  const secret = (await page.getByLabel("Issued credential").innerText()).trim();
  const host = await page.getByText("Host", { exact: true }).locator("xpath=following-sibling::dd").innerText();
  const port = await page.getByText("Port", { exact: true }).locator("xpath=following-sibling::dd").innerText();
  const database = await page.getByText("Database", { exact: true }).locator("xpath=following-sibling::dd").innerText();
  const username = await page.getByText("Username", { exact: true }).locator("xpath=following-sibling::dd").innerText();
  const url = `postgres://${username}:${secret}@${host}:${port}/${database}`;
  expect((await tryConnect(url)).ok, "access works while the lease is live").toBe(true);
  const held = await openSession(url);
  // The one-time credential is gone from the UI and from browser storage.
  await page.reload();
  await expect(page.getByRole("button", { name: /Retrieve credential/ })).toBeDisabled();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(secret);

  await page.getByLabel("Reason").fill("task finished");
  await page.getByRole("button", { name: "Revoke now" }).click();
  await expect(badge(page)).toHaveAttribute("data-state", "REVOKED_VERIFIED", { timeout: 60_000 });
  await expect(badge(page)).toHaveAttribute("data-tone", "verified");
  await expect(page.getByText(/introspection|probe/).first()).toBeVisible();
  expect((await tryConnect(url)).ok, "access is denied after revocation").toBe(false);
  expect((await held.query("SELECT 1")).ok, "the open session was terminated").toBe(false);
  await held.close();
  const id = page.url().split("/leases/")[1]!;
  expect(await roleFacts(stack.target.clusterUrl, providerRoleFor(id))).toMatchObject({ exists: false, sessions: 0 });
});

test("a provider outage shows REVOCATION UNCONFIRMED as a warning with the next retry, never as green; recovery then verifies", async ({ page }) => {
  await signIn(page, stack.operator.email);
  await page.getByRole("link", { name: "New lease" }).click();
  await fillLease(page, { task: "TASK-E2E-OUTAGE" });
  await page.getByRole("button", { name: "Approve this exact request" }).click();
  await expect(badge(page)).toHaveAttribute("data-state", "ACTIVE", { timeout: 30_000 });

  pauseProvider();
  try {
    await page.getByLabel("Reason").fill("outage drill");
    await page.getByRole("button", { name: "Revoke now" }).click();
    await expect(badge(page)).toHaveAttribute("data-state", "REVOCATION_UNCONFIRMED", { timeout: 90_000 });
    await expect(badge(page)).toHaveAttribute("data-tone", "uncertain");
    await expect(page.locator("main [data-tone='verified']")).toHaveCount(0);
    const warning = page.getByRole("alert").filter({ hasText: "do not treat this lease as revoked" });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Next retry at (UTC)");
    await page.getByRole("link", { name: "Leases", exact: true }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: "unresolved state" })).toBeVisible();
    await expect(page.locator("tr.unresolved")).toHaveCount(1);
    await expect(page.locator("[data-tone='verified']")).toHaveCount(1); // only the earlier, genuinely verified lease
  } finally {
    unpauseProvider();
  }
  await page.getByRole("link", { name: "TASK-E2E-OUTAGE" }).click();
  await page.getByLabel("Reason").fill("retry after recovery");
  await page.getByRole("button", { name: "Retry revocation now" }).click();
  await expect(badge(page)).toHaveAttribute("data-state", "REVOKED_VERIFIED", { timeout: 90_000 });
  await expect(badge(page)).toHaveAttribute("data-tone", "verified");
});

test("policy rejections are shown as errors and create nothing: wildcard scope and over-long duration", async ({ page }) => {
  await signIn(page, stack.operator.email);
  await page.getByRole("link", { name: "New lease" }).click();
  await fillLease(page, { task: "TASK-E2E-WILD", scopes: "*" });
  await expect(page.getByRole("alert").filter({ hasText: "Rejected by policy" })).toBeVisible();
  await fillLease(page, { task: "TASK-E2E-LONG", scopes: "pg:app.records:select", minutes: "481" });
  await expect(page.getByRole("alert").filter({ hasText: "Rejected by policy" })).toBeVisible();
  await page.getByRole("link", { name: "Leases", exact: true }).first().click();
  await expect(page.getByText("TASK-E2E-WILD")).toHaveCount(0);
  await expect(page.getByText("TASK-E2E-LONG")).toHaveCount(0);
});

test("viewers get a read-only view: no create link, no actions", async ({ page }) => {
  await signIn(page, stack.viewer.email);
  await expect(page.getByRole("link", { name: "New lease" })).toHaveCount(0);
  await page.getByRole("link", { name: "TASK-E2E-HAPPY" }).click();
  await expect(page.getByText("Viewers have read-only access")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Revoke|Close/ })).toHaveCount(0);
});

test("hostile HTML in lease fields renders as inert text in the list and detail views", async ({ page }) => {
  const hostile = await stack.client.post(stack.operator.session, "/leases", {
    task_ref: HOSTILE_HTML[0],
    subject_ref: HOSTILE_HTML[1],
    resource_ref: stack.target.database,
    scopes: ["pg:app.records:select"],
  });
  expect(hostile.status).toBe(201);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await signIn(page, stack.operator.email);
  await expect(page.getByText("<script>window.__al_xss = 1</script>")).toBeVisible();
  await page.getByRole("link", { name: /<script>/ }).click();
  await expect(page.getByRole("heading", { name: "<script>window.__al_xss = 1</script>" })).toBeVisible();
  await expect(page.getByText(/<img src=x onerror=/).first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__al_xss)).toBeUndefined();
  expect(await page.locator("main script, main img[src='x']").count()).toBe(0);
  expect(dialogs).toEqual([]);
});

test("when the server goes away the UI shows an explicit failure with a retry, not stale success", async ({ page }) => {
  await signIn(page, stack.operator.email);
  await page.getByRole("link", { name: "New lease" }).click();
  await expect(page.getByRole("heading", { name: "Request a lease" })).toBeVisible();
  await stack.stopServer();
  // Navigating back mounts the list again; its request now fails against the stopped server.
  await page.getByRole("main").getByRole("link", { name: "Leases", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load leases" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator("main [data-tone='verified']")).toHaveCount(0);
});
