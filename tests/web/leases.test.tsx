// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseDetailPage, shouldPollLease, CREDENTIAL_VISIBLE_MS } from "../../src/web/pages/LeaseDetail";
import { LeaseListPage } from "../../src/web/pages/LeaseList";
import { NewLeasePage, parseScopes } from "../../src/web/pages/NewLease";
import { PolicyPage } from "../../src/web/pages/Policy";
import { ReportPage } from "../../src/web/Report";
import { apiError, LIVE, makeLease, makePolicy, mockApi, renderAt, SYNTHETIC, users } from "./helpers";

const attempt = (over: Record<string, unknown> = {}) => ({ id: "att-1", lease_id: "l", attempt_no: 1, attempted_at: "2026-01-01T00:59:00.000Z", result: "provider_error", verification_ref: "", detail: {}, next_retry_at: null, ...over }) as never;
const auditRow = (over: Record<string, unknown> = {}) => ({ id: "aud-1", seq: 1, lease_id: "l", actor_ref: "user:u2", action: "lease_requested", occurred_at: "2026-01-01T00:00:00.000Z", metadata: {}, ...over }) as never;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const LIST = "GET /leases?limit=100";
const detailPath = (id: string) => `GET /leases/${id}`;
const A = makeLease();
const CRED = { lease_id: A.id, provider: LIVE, expires_at: "2026-01-01T01:00:00.000Z", credential: { kind: "postgres-role", host: "localhost", port: 5433, database: "reporting", username: "al_abc", secret: "FAKE-ONE-TIME-SECRET-123" }, delivered_at: "2026-01-01T00:10:00.000Z" };

describe("lease list", () => {
  const renderList = (user = users.operator) => renderAt("/leases", "/leases", <LeaseListPage user={user} />);

  it("shows loading, then the leases with state, expiry, verification and revocation status", async () => {
    mockApi({ [LIST]: { body: { items: [makeLease({ state: "REVOKED_VERIFIED", last_verified_at: "2026-01-01T00:30:00.000Z", revocation_status: "verified" })], next_cursor: null } } });
    renderList();
    expect(screen.getByRole("status").textContent).toContain("Loading leases");
    expect(await screen.findByText("TASK-1")).toBeTruthy();
    expect(screen.getByText("Revoked (verified)")).toBeTruthy();
    expect(screen.getByText("2026-01-01T01:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("2026-01-01T00:30:00.000Z")).toBeTruthy();
    expect(screen.getByText("verified")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("New lease")).toBeTruthy();
  });

  it("renders the empty state for operators and for viewers", async () => {
    mockApi({ [LIST]: { body: { items: [], next_cursor: null } } });
    renderList();
    expect(await screen.findByText(/No leases yet\. Create one/)).toBeTruthy();
    cleanup();
    mockApi({ [LIST]: { body: { items: [], next_cursor: null } } });
    renderList(users.viewer);
    expect(await screen.findByText(/An operator creates leases/)).toBeTruthy();
    expect(screen.queryByText("New lease")).toBeNull();
  });

  it("renders the failure state and recovers on retry", async () => {
    let ok = false;
    mockApi({ [LIST]: () => (ok ? { body: { items: [A], next_cursor: null } } : apiError(503, "not_ready", "Database unavailable")) });
    renderList();
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load leases: Database unavailable (reference req-1)");
    ok = true;
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("TASK-1")).toBeTruthy();
  });

  it("warns about unresolved leases, never shows them as verified, and can filter to them", async () => {
    mockApi({
      [LIST]: {
        body: {
          items: [
            makeLease({ id: "a", task_ref: "ok-task", state: "ACTIVE" }),
            makeLease({ id: "b", task_ref: "stuck-revoke", state: "REVOCATION_UNCONFIRMED", revocation_status: "unconfirmed", next_retry_at: "2026-01-01T00:05:00.000Z" }),
            makeLease({ id: "c", task_ref: "stuck-issue", state: "ISSUE_UNKNOWN", provider: SYNTHETIC }),
          ],
          next_cursor: null,
        },
      },
    });
    const { container } = renderList();
    expect((await screen.findByRole("alert")).textContent).toContain("2 leases in an unresolved state");
    expect(container.querySelectorAll('[data-tone="verified"]').length).toBe(0);
    expect(container.querySelectorAll('[data-tone="uncertain"]').length).toBe(2);
    expect(screen.getByText("2026-01-01T00:05:00.000Z")).toBeTruthy();
    expect(screen.getAllByText(/SYNTHETIC/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText(/Show only unresolved/));
    expect(screen.queryByText("ok-task")).toBeNull();
    expect(screen.getByText("stuck-revoke")).toBeTruthy();
  });

  it("says so when the filter leaves nothing and singularises the warning", async () => {
    mockApi({ [LIST]: { body: { items: [makeLease({ state: "ISSUE_UNKNOWN" })], next_cursor: null } } });
    renderList();
    expect((await screen.findByRole("alert")).textContent).toContain("1 lease in an unresolved state");
    cleanup();
    mockApi({ [LIST]: { body: { items: [A], next_cursor: null } } });
    renderList();
    await screen.findByText("TASK-1");
    fireEvent.click(screen.getByLabelText(/Show only unresolved/));
    expect(screen.getByText(/No unresolved leases among the 1 loaded/)).toBeTruthy();
  });

  it("pages with the cursor and reports a failed page without losing the loaded ones", async () => {
    let fail = true;
    const { calls } = mockApi({
      [LIST]: { body: { items: [makeLease({ id: "a", task_ref: "first" })], next_cursor: "c 1" } },
      "GET /leases?limit=100&cursor=c%201": () => (fail ? apiError(500, "boom", "page failed") : { body: { items: [makeLease({ id: "b", task_ref: "second" })], next_cursor: null } }),
    });
    renderList();
    await screen.findByText("first");
    fireEvent.click(screen.getByText("Load more"));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load more leases: page failed");
    expect(screen.getByText("first")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("second")).toBeTruthy();
    expect(screen.queryByText("Load more")).toBeNull();
    expect(calls.filter((c) => c.path.includes("cursor=")).length).toBe(2);
  });

  it("does nothing when asked to load more with no cursor", async () => {
    mockApi({ [LIST]: { body: { items: [A], next_cursor: null } } });
    renderList();
    await screen.findByText("TASK-1");
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("shows an empty first page that still has a cursor as a table, not the empty state", async () => {
    mockApi({ [LIST]: { body: { items: [], next_cursor: "more" } } });
    renderList();
    expect(await screen.findByText("Load more")).toBeTruthy();
    expect(screen.queryByText(/No leases yet/)).toBeNull();
  });

  it("renders hostile text as text", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    mockApi({ [LIST]: { body: { items: [makeLease({ task_ref: hostile, revocation_status: hostile })], next_cursor: null } } });
    const { container } = renderList();
    await screen.findAllByText(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("lease detail", () => {
  const renderDetail = (lease = A, user = users.operator) => renderAt(`/leases/${lease.id}`, "/leases/:id", <LeaseDetailPage user={user} />);

  it("shows loading, then every required field, attempts and the audit trail", async () => {
    const lease = makeLease({
      attempts: [attempt()],
      audit: [auditRow({ actor_ref: "operator@example.test" })],
    });
    mockApi({ [detailPath(lease.id)]: { body: lease } });
    renderDetail(lease);
    expect(screen.getByRole("status").textContent).toContain("Loading the lease");
    expect(await screen.findByRole("heading", { name: "TASK-1" })).toBeTruthy();
    for (const text of ["contractor-a", "pg:reporting", "pg:public.orders:select", "2026-01-01T01:00:00.000Z", "none", "provider_error (not verified)", "lease_requested", "operator@example.test"]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/An expiry time is not a revocation/)).toBeTruthy();
    expect(screen.getByText("Evidence report").getAttribute("href")).toBe(`/leases/${lease.id}/report`);
  });

  it("renders the failure state and 404s", async () => {
    mockApi({ [detailPath(A.id)]: apiError(404, "not_found", "Lease not found") });
    renderDetail();
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the lease: Lease not found");
  });

  it("shows REVOCATION_UNCONFIRMED and ISSUE_UNKNOWN as warnings with next retry, never green", async () => {
    const unconfirmed = makeLease({ state: "REVOCATION_UNCONFIRMED", revocation_status: "unconfirmed", next_retry_at: "2026-01-01T00:05:00.000Z" });
    mockApi({ [detailPath(unconfirmed.id)]: { body: unconfirmed } });
    const first = renderDetail(unconfirmed);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("REVOCATION UNCONFIRMED: do not treat this lease as revoked or safe");
    expect(alert.textContent).toContain("2026-01-01T00:05:00.000Z");
    expect(first.container.querySelectorAll('[data-tone="verified"]').length).toBe(0);
    expect(screen.getByText("Retry revocation now")).toBeTruthy();
    cleanup();
    const unknown = makeLease({ state: "ISSUE_UNKNOWN" });
    mockApi({ [detailPath(unknown.id)]: { body: unknown } });
    renderDetail(unknown);
    expect((await screen.findByRole("alert")).textContent).toContain("ISSUE UNKNOWN");
    expect(screen.getByText(/No retry is scheduled/)).toBeTruthy();
  });

  it("shows verified revocation green only with a verification time", async () => {
    const verified = makeLease({ state: "REVOKED_VERIFIED", last_verified_at: "2026-01-01T00:30:00.000Z", revocation_status: "verified", close_reason: "task_closed" });
    mockApi({ [detailPath(verified.id)]: { body: verified } });
    const { container } = renderDetail(verified);
    await screen.findByRole("heading", { name: "TASK-1" });
    expect(screen.getByText("task_closed")).toBeTruthy();
    expect(container.querySelectorAll('[data-tone="verified"]').length).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No actions are available in this state.")).toBeTruthy();
    cleanup();
    const inconsistent = makeLease({ state: "REVOKED_VERIFIED", last_verified_at: null });
    mockApi({ [detailPath(inconsistent.id)]: { body: inconsistent } });
    const second = renderDetail(inconsistent);
    expect((await screen.findByRole("alert")).textContent).toContain("Revoked state without verification time");
    expect(second.container.querySelectorAll('[data-tone="verified"]').length).toBe(0);
  });

  it("renders hostile lease text as text, not markup", async () => {
    const hostile = '<script>alert("x")</script><b onclick="y()">bold</b>';
    const lease = makeLease({ task_ref: hostile, subject_ref: hostile, resource_ref: hostile, scopes: [hostile], revocation_status: hostile, audit: [auditRow({ actor_ref: hostile, action: hostile })] });
    mockApi({ [detailPath(lease.id)]: { body: lease } });
    const { container } = renderDetail(lease);
    await screen.findByRole("heading", { name: hostile });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });

  it("approves exactly the displayed request with its plan hash and idempotency key", async () => {
    const requested = makeLease({ state: "REQUESTED" });
    let current = requested;
    const { calls } = mockApi({
      [detailPath(requested.id)]: () => ({ body: current }),
      [`POST /leases/${requested.id}/approve`]: () => {
        current = makeLease({ state: "APPROVED" });
        return { status: 202, body: {} };
      },
    });
    renderDetail(requested);
    expect(await screen.findByText(/Approving binds to exactly/)).toBeTruthy();
    fireEvent.click(screen.getByText("Approve this exact request"));
    expect(await screen.findByText("Approved. Issuance is queued.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ plan_hash: "a".repeat(64), expected_version: 3 });
    expect(post?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("Approved")).toBeTruthy();
  });

  it("explains a stale approval (409) and keeps the same idempotency key for the retry", async () => {
    const requested = makeLease({ state: "REQUESTED" });
    let attempts = 0;
    const { calls } = mockApi({
      [detailPath(requested.id)]: { body: requested },
      [`POST /leases/${requested.id}/approve`]: () => (++attempts === 1 ? apiError(409, "conflict", "plan_hash does not match") : { status: 202, body: {} }),
    });
    renderDetail(requested);
    fireEvent.click(await screen.findByText("Approve this exact request"));
    expect((await screen.findByRole("alert")).textContent).toContain("nothing was issued");
    fireEvent.click(screen.getByText("Approve this exact request"));
    await screen.findByText("Approved. Issuance is queued.");
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("requires a reason to revoke, sends it, and states that revocation is not yet verified", async () => {
    const { calls } = mockApi({
      [detailPath(A.id)]: { body: A },
      [`POST /leases/${A.id}/revoke`]: { status: 202, body: {} },
    });
    renderDetail();
    await screen.findByRole("form", { name: "Revoke lease" });
    fireEvent.submit(screen.getByRole("form", { name: "Revoke lease" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a reason");
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "task done early" } });
    fireEvent.submit(screen.getByRole("form", { name: "Revoke lease" }));
    expect((await screen.findByRole("status")).textContent).toContain("only after it is independently verified");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "task done early" });
  });

  it("closes the task and reports permission and not-found errors plainly", async () => {
    let reply: { status?: number; body?: unknown } = { status: 202, body: {} };
    mockApi({ [detailPath(A.id)]: { body: A }, [`POST /leases/${A.id}/close`]: () => reply });
    renderDetail();
    fireEvent.click(await screen.findByText("Close task and revoke access"));
    expect((await screen.findByRole("status")).textContent).toContain("Revocation was requested and is not yet verified");
    reply = apiError(403, "forbidden", "viewers cannot close");
    fireEvent.click(screen.getByText("Close task and revoke access"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Your role is not allowed to do this"));
    reply = apiError(404, "not_found", "x");
    fireEvent.click(screen.getByText("Close task and revoke access"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not available to you"));
    reply = { status: 500, body: "no" };
    fireEvent.click(screen.getByText("Close task and revoke access"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toContain("not available to you"));
  });

  it("hides every mutation from viewers", async () => {
    mockApi({ [detailPath(A.id)]: { body: A } });
    renderDetail(A, users.viewer);
    await screen.findByRole("heading", { name: "TASK-1" });
    expect(screen.getByText(/Viewers have read-only access/)).toBeTruthy();
    expect(screen.queryByText("Revoke now")).toBeNull();
    expect(screen.queryByText(/Retrieve credential/)).toBeNull();
  });

  it("polls while a lease is changing and stops once verified revocation is recorded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sequence = [makeLease({ state: "REVOKING" }), makeLease({ state: "REVOCATION_UNCONFIRMED", next_retry_at: "2026-01-01T00:05:00.000Z" }), makeLease({ state: "REVOKED_VERIFIED", last_verified_at: "2026-01-01T00:06:00.000Z" })];
    let i = 0;
    const { calls } = mockApi({ [detailPath(A.id)]: () => ({ body: sequence[Math.min(i++, 2)] }) });
    renderDetail();
    await screen.findByText("Revoking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText("REVOCATION UNCONFIRMED")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText("Revoked (verified)")).toBeTruthy();
    const settled = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls.length).toBe(settled);
    expect(shouldPollLease(makeLease({ state: "REVOKED_VERIFIED", last_verified_at: null }))).toBe(true);
    expect(shouldPollLease(makeLease({ state: "ACTIVE" }))).toBe(true);
  });

  describe("one-time credential", () => {
    it("shows the credential once, never stores it, hides it on request and after a timeout", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      let served = false;
      mockApi({
        [detailPath(A.id)]: { body: A },
        [`POST /leases/${A.id}/credential`]: () => {
          if (served) return apiError(409, "credential_already_retrieved", "already retrieved");
          served = true;
          return { body: CRED };
        },
      });
      renderDetail();
      fireEvent.click(await screen.findByText("Retrieve credential (shown once)"));
      const pre = await screen.findByLabelText("Issued credential");
      expect(pre.textContent).toBe("FAKE-ONE-TIME-SECRET-123");
      expect(screen.getByText(/shown once, is not stored in your browser/)).toBeTruthy();
      expect(setItem).not.toHaveBeenCalled();
      expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
      expect(window.location.href).not.toContain("FAKE-ONE-TIME");
      fireEvent.click(screen.getByText("Hide credential"));
      expect(screen.queryByText("FAKE-ONE-TIME-SECRET-123")).toBeNull();
      expect(screen.getByText(/Credential hidden\. It cannot be retrieved again/)).toBeTruthy();
      expect((screen.getByText("Retrieve credential (shown once)") as HTMLButtonElement).disabled).toBe(true);
    });

    it("clears the credential automatically", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockApi({ [detailPath(A.id)]: { body: A }, [`POST /leases/${A.id}/credential`]: { body: CRED } });
      renderDetail();
      fireEvent.click(await screen.findByText("Retrieve credential (shown once)"));
      await screen.findByLabelText("Issued credential");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CREDENTIAL_VISIBLE_MS + 100);
      });
      expect(screen.queryByText("FAKE-ONE-TIME-SECRET-123")).toBeNull();
      expect(screen.getByText(/Credential hidden/)).toBeTruthy();
    });

    it("reports an already-consumed credential and other failures", async () => {
      let reply: { status?: number; body?: unknown } = apiError(409, "credential_already_retrieved", "already retrieved");
      mockApi({ [detailPath(A.id)]: { body: A }, [`POST /leases/${A.id}/credential`]: () => reply });
      renderDetail();
      fireEvent.click(await screen.findByText("Retrieve credential (shown once)"));
      expect((await screen.findByRole("alert")).textContent).toContain("already retrieved or is not available");
      reply = apiError(403, "forbidden", "not allowed");
      fireEvent.click(screen.getByText("Retrieve credential (shown once)"));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not allowed"));
    });

    it("drops the credential when the page is left", async () => {
      mockApi({ [detailPath(A.id)]: { body: A }, [`POST /leases/${A.id}/credential`]: { body: CRED } });
      const { unmount, container } = renderDetail();
      fireEvent.click(await screen.findByText("Retrieve credential (shown once)"));
      await screen.findByLabelText("Issued credential");
      unmount();
      expect(container.textContent).toBe("");
      expect(document.body.textContent).not.toContain("FAKE-ONE-TIME");
    });

    it("ignores a late response after the page was left", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (String(input).endsWith("/credential")) {
            await gate;
            return new Response(JSON.stringify({ ...CRED, credential: { ...CRED.credential, secret: "FAKE-LATE-SECRET" } }), { status: 200 });
          }
          return new Response(JSON.stringify(A), { status: 200 });
        }),
      );
      const { unmount } = renderDetail();
      fireEvent.click(await screen.findByText("Retrieve credential (shown once)"));
      unmount();
      release();
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.body.textContent).not.toContain("FAKE-LATE-SECRET");
    });
  });
});

describe("new lease", () => {
  const fill = (values: Record<string, string>) => {
    for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value } });
  };
  const valid = { "Task reference": "TASK-9", "Subject": "contractor-z", Resource: "pg:reporting", Scopes: "pg:public.orders:select\npg:public.orders:select, pg:public.items:select" };

  it("parses scope lists, preserving order and dropping duplicates", () => {
    expect(parseScopes("a\nb, a ,, c\n")).toEqual(["a", "b", "c"]);
    expect(parseScopes("  ")).toEqual([]);
  });

  it("submits the request with an expiry derived from the duration and navigates to the lease", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { calls } = mockApi({ "POST /leases": { status: 201, body: { id: "new-id", state: "REQUESTED", plan_hash: "h" } } });
    renderAt("/leases/new", "/leases/new", <NewLeasePage user={users.operator} />);
    fill({ ...valid, Duration: "90" });
    fireEvent.submit(screen.getByRole("form", { name: "New lease" }));
    expect(await screen.findByText("navigated")).toBeTruthy();
    const post = calls[0];
    expect(post?.body).toEqual({ task_ref: "TASK-9", subject_ref: "contractor-z", resource_ref: "pg:reporting", scopes: ["pg:public.orders:select", "pg:public.items:select"], expires_at: "2026-01-01T01:30:00.000Z" });
    expect(post?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows policy rejections (422) and other failures, and validates locally first", async () => {
    let reply: { status?: number; body?: unknown } = apiError(422, "policy_rejected", "wildcard scopes are not allowed");
    const { calls } = mockApi({ "POST /leases": () => reply });
    renderAt("/leases/new", "/leases/new", <NewLeasePage user={users.admin} />);
    fill({ ...valid, Scopes: "pg:*", Duration: "0" });
    fireEvent.submit(screen.getByRole("form", { name: "New lease" }));
    expect((await screen.findByRole("alert")).textContent).toContain("whole number of minutes");
    fill({ Duration: "60", Scopes: " , " });
    fireEvent.submit(screen.getByRole("form", { name: "New lease" }));
    expect((await screen.findByRole("alert")).textContent).toContain("at least one scope");
    expect(calls.length).toBe(0);
    fill({ Scopes: "pg:*" });
    fireEvent.submit(screen.getByRole("form", { name: "New lease" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Rejected by policy: wildcard scopes are not allowed"));
    reply = apiError(503, "provider_unavailable", "later");
    fireEvent.submit(screen.getByRole("form", { name: "New lease" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("later"));
    // the retry after the failure reuses the idempotency key so it cannot create a second lease
    expect(calls[0]?.headers["idempotency-key"]).toBe(calls[1]?.headers["idempotency-key"]);
  });

  it("omits expires_at when the duration is empty so the server applies the policy default", async () => {
    const { calls } = mockApi({ "POST /leases": { status: 201, body: { id: "new-id", state: "REQUESTED", plan_hash: "h" } } });
    renderAt("/leases/new", "/leases/new", <NewLeasePage user={users.operator} />);
    fill({ ...valid, Duration: "" });
    fireEvent.submit(screen.getByRole("form", { name: "New lease" }));
    expect(await screen.findByText("navigated")).toBeTruthy();
    expect(calls[0]?.body).not.toHaveProperty("expires_at");
  });

  it("blocks viewers", () => {
    renderAt("/leases/new", "/leases/new", <NewLeasePage user={users.viewer} />);
    expect(screen.getByRole("alert").textContent).toContain("cannot create leases");
  });
});

describe("policy", () => {
  const policy = makePolicy({ scope_allow_prefixes: ["pg:public."] });

  it("lets an admin read and change the policy with the version it saw", async () => {
    const { calls } = mockApi({ "GET /policy": { body: policy }, "PUT /policy": { body: policy } });
    renderAt("/policy", "/policy", <PolicyPage user={users.admin} />);
    expect(screen.getByRole("status").textContent).toContain("Loading the policy");
    expect(await screen.findByText("28800 s (480 min)")).toBeTruthy();
    expect(screen.getAllByText("pg:public.").length).toBeGreaterThan(0);
    expect(screen.getByText("none configured")).toBeTruthy();
    expect(screen.getByText("90 days")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Maximum duration \(seconds\)/), { target: { value: "14400" } });
    fireEvent.change(screen.getByLabelText(/Scope deny prefixes/), { target: { value: "pg:secret.\n\n pg:audit. " } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit policy" }));
    expect(await screen.findByText("Policy saved.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      default_ttl_seconds: 3600,
      max_ttl_seconds: 14400,
      min_ttl_seconds: 60,
      approval_ttl_seconds: 900,
      retention_days: 90,
      scope_allow_prefixes: ["pg:public."],
      scope_deny_prefixes: ["pg:secret.", "pg:audit."],
      expected_version: 2,
    });
  });

  it("is read-only for operators and viewers", async () => {
    mockApi({ "GET /policy": { body: makePolicy({ default_ttl_seconds: 90 }) } });
    renderAt("/policy", "/policy", <PolicyPage user={users.operator} />);
    expect(await screen.findByText(/Read-only: ask an administrator/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Edit policy" })).toBeNull();
    expect(screen.getByText("90 s")).toBeTruthy();
    expect(screen.getByText(/none configured \(any valid scope not denied\)/)).toBeTruthy();
  });

  it("reports save failures, permission and version conflicts, and load failures", async () => {
    let reply: { status?: number; body?: unknown } = apiError(403, "forbidden", "admin only");
    mockApi({ "GET /policy": { body: policy }, "PUT /policy": () => reply });
    renderAt("/policy", "/policy", <PolicyPage user={users.admin} />);
    await screen.findByRole("form", { name: "Edit policy" });
    fireEvent.submit(screen.getByRole("form", { name: "Edit policy" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only an administrator can change the policy");
    reply = apiError(409, "version_conflict", "stale version");
    fireEvent.submit(screen.getByRole("form", { name: "Edit policy" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The policy changed since you opened it"));
    reply = apiError(422, "policy_invalid", "max above hard limit");
    fireEvent.submit(screen.getByRole("form", { name: "Edit policy" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("max above hard limit"));
    cleanup();
    mockApi({ "GET /policy": apiError(500, "boom", "policy unavailable") });
    renderAt("/policy", "/policy", <PolicyPage user={users.admin} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the policy: policy unavailable");
  });
});

describe("evidence report page", () => {
  it("renders attempts, audit trail, warnings and the empty tables", async () => {
    const lease = makeLease({
      state: "REVOCATION_UNCONFIRMED",
      provider: SYNTHETIC,
      next_retry_at: "2026-01-01T00:05:00.000Z",
      attempts: [attempt({ attempted_at: "2026-01-01T00:01:00.000Z", verification_ref: "probe-1", next_retry_at: "2026-01-01T00:05:00.000Z" })],
      audit: [],
    });
    mockApi({ [detailPath(lease.id)]: { body: lease } });
    renderAt(`/leases/${lease.id}/report`, "/leases/:id/report", <ReportPage />);
    expect(await screen.findByLabelText("Lease evidence report")).toBeTruthy();
    expect(screen.getByText("provider_error (not verified)")).toBeTruthy();
    expect(screen.getByText("probe-1")).toBeTruthy();
    expect(screen.getByText("No audit events recorded.")).toBeTruthy();
    expect(screen.getAllByRole("alert").length).toBe(1);
    expect(screen.getAllByText(/SYNTHETIC/).length).toBeGreaterThan(0);
    cleanup();
    mockApi({ [detailPath(A.id)]: { body: A } });
    renderAt(`/leases/${A.id}/report`, "/leases/:id/report", <ReportPage />);
    expect(await screen.findByText("No revocation attempts recorded.")).toBeTruthy();
    expect(within(screen.getByLabelText("Lease evidence report")).getByText("No audit events recorded.")).toBeTruthy();
  });

  it("renders the failure state", async () => {
    mockApi({ [detailPath(A.id)]: apiError(500, "boom", "report failed") });
    renderAt(`/leases/${A.id}/report`, "/leases/:id/report", <ReportPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the lease report: report failed");
  });
});
