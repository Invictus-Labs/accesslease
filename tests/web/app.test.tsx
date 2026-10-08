// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, canOperate, closeLease, formatTime, hasCsrfToken, isAdmin, loadSession, newIdempotencyKey, retrieveCredential } from "../../src/web/api";
import { App } from "../../src/web/App";
import { ErrorBanner, LoadState, StateBadge, SyntheticBanner, UncertaintyWarning } from "../../src/web/components";
import { apiError, mockApi, users } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("App shell: session, login and sign out", () => {
  it("shows the login form without a session, reports bad credentials, then signs in and out with CSRF", async () => {
    let signedIn = false;
    const { calls } = mockApi({
      "GET /auth/session": () => (signedIn ? { body: { user: users.operator, csrf_token: "csrf-1" } } : apiError(401, "unauthorized", "Authentication required")),
      "POST /auth/login": (call) => {
        if ((call.body as { password: string }).password !== "right-password") return apiError(401, "invalid_credentials", "Email or password is incorrect");
        signedIn = true;
        return { body: { user: users.operator, csrf_token: "csrf-1" } };
      },
      "POST /auth/logout": { body: { ok: true } },
      "GET /leases?limit=100": { body: { items: [], next_cursor: null } },
    });
    render(<App />);
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText(/no default password/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "operator@example.test" } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "wrong" } });
    fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Email or password is incorrect (reference req-1)");
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "right-password" } });
    fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
    expect(await screen.findByText(/Demo · operator@example.test \(operator\)/)).toBeTruthy();
    expect(await screen.findByText(/No leases yet/)).toBeTruthy();
    expect(hasCsrfToken()).toBe(true);
    fireEvent.click(screen.getByText("Sign out"));
    await screen.findByRole("form", { name: "Sign in" });
    expect(calls.find((c) => c.path === "/auth/logout")?.headers["x-csrf-token"]).toBe("csrf-1");
    expect(hasCsrfToken()).toBe(false);
  });

  it("reports an unreachable server instead of an empty screen", async () => {
    mockApi({ "GET /auth/session": apiError(503, "not_ready", "Database or schema unavailable") });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("AccessLease is unreachable: Database or schema unavailable");
  });

  it("shows the loading state before the session resolves", async () => {
    mockApi({ "GET /auth/session": () => ({ body: { user: users.viewer, csrf_token: "c" } }) });
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(await screen.findByText(/viewer@example.test/)).toBeTruthy();
  });

  it("routes by path and reports unknown pages", async () => {
    mockApi({ "GET /auth/session": { body: { user: users.operator, csrf_token: "c" } } });
    window.history.pushState({}, "", "/nowhere");
    render(<App />);
    expect(await screen.findByText("Page not found.")).toBeTruthy();
  });

  it("surfaces a sign-out failure", async () => {
    mockApi({
      "GET /auth/session": { body: { user: users.operator, csrf_token: "c" } },
      "GET /leases?limit=100": { body: { items: [], next_cursor: null } },
      "POST /auth/logout": apiError(500, "boom", "Could not sign out"),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("Sign out"));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not sign out");
  });
});

describe("API client", () => {
  it("maps network failures, unreadable bodies and error bodies to ApiError", async () => {
    const fail = (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => [e instanceof ApiError, e.code, e.status, e.message]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await fail(api("GET", "/leases"))).toEqual([true, "network_error", 0, "AccessLease is unreachable; check your connection and retry"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect((await fail(api("GET", "/leases")))?.[1]).toBe("invalid_response");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await fail(api("GET", "/leases"))).toEqual([true, "error", 500, "HTTP 500"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    expect(await api("GET", "/leases")).toBeNull();
  });

  it("returns null from loadSession on 401 and rethrows other failures", async () => {
    mockApi({ "GET /auth/session": apiError(401, "unauthorized", "no") });
    expect(await loadSession()).toBeNull();
    mockApi({ "GET /auth/session": apiError(500, "boom", "down") });
    await expect(loadSession()).rejects.toThrow(/down/);
  });

  it("sends the CSRF token and an Idempotency-Key on mutations and never on reads", async () => {
    const { calls } = mockApi({
      "GET /auth/session": { body: { user: users.operator, csrf_token: "csrf-9" } },
      "POST /leases/abc/close": { body: {} },
      "GET /leases": { body: {} },
    });
    await loadSession();
    await closeLease("abc", "key-1");
    await api("GET", "/leases");
    const close = calls.find((c) => c.path === "/leases/abc/close");
    expect(close?.headers["x-csrf-token"]).toBe("csrf-9");
    expect(close?.headers["idempotency-key"]).toBe("key-1");
    expect(calls.find((c) => c.method === "GET" && c.path === "/leases")?.headers["x-csrf-token"]).toBeUndefined();
  });

  it("retrieves credentials with no-store caching and never touches browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { calls } = mockApi({ "POST /leases/abc/credential": { body: { credential: "FAKE-ONE-TIME-SECRET" } } });
    const result = await retrieveCredential("abc");
    expect(result.credential).toBe("FAKE-ONE-TIME-SECRET");
    expect(calls[0]?.init.cache).toBe("no-store");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(calls[0]?.path).toBe("/leases/abc/credential");
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it("helpers", () => {
    expect(canOperate(users.viewer)).toBe(false);
    expect(canOperate(users.operator)).toBe(true);
    expect(isAdmin(users.operator)).toBe(false);
    expect(formatTime(null)).toBe("—");
    expect(formatTime("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("shared components", () => {
  it("never renders an uncertain state as verified and always carries text", () => {
    const { container } = render(
      <>
        <StateBadge state="REVOCATION_UNCONFIRMED" />
        <StateBadge state="ISSUE_UNKNOWN" />
        <StateBadge state="REVOKED_VERIFIED" lastVerifiedAt="2026-01-01T00:00:00Z" />
        <StateBadge state="REVOKED_VERIFIED" lastVerifiedAt={null} />
        <StateBadge state="EXPIRED" />
      </>,
    );
    const tones = [...container.querySelectorAll("[data-state]")].map((n) => [n.getAttribute("data-state"), n.getAttribute("data-tone")]);
    expect(tones).toEqual([
      ["REVOCATION_UNCONFIRMED", "uncertain"],
      ["ISSUE_UNKNOWN", "uncertain"],
      ["REVOKED_VERIFIED", "verified"],
      ["REVOKED_VERIFIED", "invalid"],
      ["EXPIRED", "invalid"],
    ]);
    expect(container.textContent).toContain("REVOCATION UNCONFIRMED");
    expect(container.textContent).toContain("Warning: ");
  });

  it("warns for uncertain states with the next retry and stays silent otherwise", () => {
    const { container, rerender } = render(<UncertaintyWarning state="REVOCATION_UNCONFIRMED" nextRetryAt="2026-01-01T00:05:00Z" />);
    expect(screen.getByRole("alert").textContent).toContain("do not treat this lease as revoked");
    expect(container.textContent).toContain("2026-01-01T00:05:00Z");
    rerender(<UncertaintyWarning state="ISSUE_UNKNOWN" />);
    expect(container.textContent).toContain("No retry is scheduled");
    rerender(<UncertaintyWarning state="ACTIVE" />);
    expect(container.textContent).toBe("");
    rerender(<UncertaintyWarning state="REVOKING" warning="Revocation is not yet verified." />);
    expect(screen.getByRole("status").textContent).toBe("Revocation is not yet verified.");
    rerender(<UncertaintyWarning state="ISSUE_UNKNOWN" warning="Provider timed out." />);
    expect(container.textContent).toContain("Server note: Provider timed out.");
  });

  it("labels the synthetic provider and renders load and error states", () => {
    const { container, rerender } = render(<SyntheticBanner synthetic />);
    expect(container.textContent).toContain("SYNTHETIC");
    rerender(<SyntheticBanner synthetic={false} />);
    expect(container.textContent).toBe("");
    const retry = vi.fn();
    rerender(<LoadState state={{ status: "loading" }} label="things">{() => null}</LoadState>);
    expect(screen.getByRole("status").textContent).toBe("Loading things…");
    rerender(<LoadState state={{ status: "error", message: "nope" }} label="things" onRetry={retry}>{() => null}</LoadState>);
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Could not load things: nope");
    rerender(<ErrorBanner message="plain" />);
    expect(screen.queryByText("Retry")).toBeNull();
  });
});
