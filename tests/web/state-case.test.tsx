// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, normaliseLeaseStates } from "../../src/web/api";
import { LeaseDetailPage } from "../../src/web/pages/LeaseDetail";
import { LeaseListPage } from "../../src/web/pages/LeaseList";
import { makeLease, mockApi, renderAt, users } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lower = (over: Record<string, unknown> = {}) => ({ ...makeLease(), state: "revocation_unconfirmed", ...over });

describe("lease state case at the client boundary", () => {
  it("uppercases lease and lease-page states and leaves other objects alone", async () => {
    mockApi({
      "GET /leases?limit=1": { body: { items: [lower(), lower({ state: "active" })], next_cursor: null } },
      "GET /leases/x": { body: lower({ state: "issue_unknown" }) },
      "GET /jobs": { body: { items: [{ state: "queued" }] } },
      "GET /leasesx": { body: { state: "queued" } },
    });
    const page = await api<{ items: Array<{ state: string }> }>("GET", "/leases?limit=1");
    expect(page.items.map((i) => i.state)).toEqual(["REVOCATION_UNCONFIRMED", "ACTIVE"]);
    expect((await api<{ state: string }>("GET", "/leases/x")).state).toBe("ISSUE_UNKNOWN");
    expect((await api<{ items: Array<{ state: string }> }>("GET", "/jobs")).items[0]?.state).toBe("queued");
    expect((await api<{ state: string }>("GET", "/leasesx")).state).toBe("queued");
    expect(normaliseLeaseStates("/leases/x", null)).toBeNull();
    expect(normaliseLeaseStates("/leases/x", { state: 5 })).toEqual({ state: 5 });
  });

  it("shows a lowercase wire state as the unresolved warning, in the list and on the detail page", async () => {
    mockApi({ "GET /leases?limit=100": { body: { items: [lower()], next_cursor: null } } });
    const first = renderAt("/leases", "/leases", <LeaseListPage user={users.operator} />);
    expect((await screen.findByRole("alert")).textContent).toContain("1 lease in an unresolved state");
    expect(first.container.querySelectorAll('[data-tone="uncertain"]').length).toBe(1);
    cleanup();
    const l = lower({ state: "issue_unknown" });
    mockApi({ [`GET /leases/${l.id}`]: { body: l } });
    renderAt(`/leases/${l.id}`, "/leases/:id", <LeaseDetailPage user={users.operator} />);
    expect((await screen.findByRole("alert")).textContent).toContain("ISSUE UNKNOWN");
  });
});
