// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuditTable } from "../../src/web/Report";

afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({ id: "a1", seq: 1, lease_id: "l", actor_ref: "user:u", action: "lease.revoke_requested", occurred_at: "2026-01-01T00:00:00.000Z", metadata: {}, ...over }) as never;

describe("audit trail details", () => {
  it("shows the revocation reason as text and a dash when there is no metadata", () => {
    const { container } = render(<AuditTable events={[row({ metadata: { reason: "<b>smoke</b> explicit revoke" } }), row({ id: "a2", seq: 2 })]} />);
    expect(screen.getByText("reason=<b>smoke</b> explicit revoke")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBe(1);
  });
});
