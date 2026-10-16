// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBar } from "../../src/web/App";
import { ProviderStatus } from "../../src/web/components";
import { apiError, mockApi, users } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const info = (over: Record<string, unknown> = {}) => ({ provider: { kind: "synthetic", label: "SYNTHETIC", live: false }, connected: true, code: null, ...over }) as never;

describe("provider status", () => {
  it("shows a disconnected provider as an alert and a connected one as a status line", () => {
    const { container, rerender } = render(<ProviderStatus info={info({ connected: false, code: "provider_disconnected" })} />);
    expect(screen.getByRole("alert").textContent).toContain("disconnected (provider_disconnected)");
    expect(screen.getByRole("alert").textContent).toContain("fails explicitly");
    rerender(<ProviderStatus info={info({ connected: false })} />);
    expect(screen.getByRole("alert").textContent).not.toContain("(");
    rerender(<ProviderStatus info={info()} />);
    expect(screen.getByRole("status").textContent).toBe("Provider: SYNTHETIC, connected (not live evidence)");
    rerender(<ProviderStatus info={info({ provider: { kind: "postgres-role", label: "LIVE_LOCAL_POSTGRES", live: true } })} />);
    expect(screen.getByRole("status").textContent).toBe("Provider: LIVE_LOCAL_POSTGRES, connected");
    rerender(<ProviderStatus info={null} />);
    expect(container.textContent).toBe("");
  });

  it("loads for operators, refreshes, and tolerates failures", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reply: { status?: number; body?: unknown } = { body: info() };
    const { calls } = mockApi({ "GET /provider": () => reply });
    render(<ProviderBar user={users.operator} />);
    expect(await screen.findByRole("status")).toBeTruthy();
    reply = { body: info({ connected: false, code: "provider_disconnected" }) };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("disconnected");
    reply = apiError(500, "boom", "x");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("does not call the operator-only route for viewers", () => {
    const { calls } = mockApi({ "GET /provider": { body: info() } });
    render(<ProviderBar user={users.viewer} />);
    expect(calls.length).toBe(0);
  });
});
