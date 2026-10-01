import { describe, expect, it } from "vitest";
import { ERROR_CODES, EVENT_TYPES, LEASE_STATES as DOMAIN_STATES, PROVIDER_KINDS, toWireState, UNRESOLVED_STATES, WIRE_STATES } from "../../../src/domain/types";
import { normaliseLeaseStates } from "../../../src/web/api";
import { exitCodeForError } from "../../../src/cli/exit";
import { parseEnvelope } from "../../../src/adapters/envelope";
import { reportModelFromData, unresolvedInReport } from "../../../src/report/from-data";
import { renderReport } from "../../../src/report/render";
import { isLeaseState, isUncertainState, LEASE_STATES, presentState, providerLabel, UNCERTAIN_STATES } from "../../../src/report/status";
import { lease, LIVE, reportData, SYNTH } from "./fakes";

/** These tests fail when the surface and the frozen backend contract drift apart. */
describe("surface follows the frozen backend contract", () => {
  it("knows exactly the backend's lease states and unresolved states", () => {
    expect([...LEASE_STATES]).toEqual([...DOMAIN_STATES]);
    expect([...UNCERTAIN_STATES]).toEqual([...UNRESOLVED_STATES]);
    for (const s of DOMAIN_STATES) expect(isUncertainState(s)).toBe((UNRESOLVED_STATES as readonly string[]).includes(s));
  });

  it("turns every lowercase wire state into exactly one internal state, and normalises report data the same way", () => {
    expect(WIRE_STATES.length).toBe(LEASE_STATES.length);
    for (const wire of WIRE_STATES) {
      const [normalised] = (normaliseLeaseStates("/leases?limit=1", { items: [{ state: wire }] }) as { items: Array<{ state: string }> }).items;
      expect(isLeaseState(normalised?.state), wire).toBe(true);
      expect(normalised?.state).toBe(wire.toUpperCase());
      const model = reportModelFromData(reportData([lease({ state: wire })]));
      expect(isLeaseState(model.leases[0]?.state), wire).toBe(true);
    }
    for (const s of DOMAIN_STATES) expect(WIRE_STATES).toContain(toWireState(s));
  });

  it("labels every backend provider kind", () => {
    for (const kind of PROVIDER_KINDS) expect(providerLabel(kind)).not.toContain("Unrecognised");
  });

  it("maps every registered backend error code to a contract exit code", () => {
    for (const [code, status] of Object.entries(ERROR_CODES)) {
      const exit = exitCodeForError({ code, status });
      if (status === 503) expect(exit, code).toBe(3);
      else if (status === 500) expect(exit, code).toBe(1);
      else if (status === 401 || status === 429) expect(exit, code).toBe(1);
      else expect(exit, code).toBe(2);
    }
  });

  it("accepts every event type the backend emits", () => {
    for (const event_type of EVENT_TYPES) {
      const r = parseEnvelope({ schema_version: 1, event_id: "e", source: "accesslease", resource_id: "r", event_type, occurred_at: "2026-01-01T00:00:00.000Z", revision: 1, evidence_ref: "lease:r@1" });
      expect(r.ok, event_type).toBe(true);
    }
  });

  it("presents every state the backend can report, with REVOKED_VERIFIED green only when verified", () => {
    for (const state of DOMAIN_STATES) {
      const p = presentState(state, "2026-01-01T00:00:00.000Z");
      expect(p.tone === "verified").toBe(state === "REVOKED_VERIFIED");
    }
  });
});

describe("report data adapter", () => {
  it("maps leases, attempts, audit, provider labels, warnings and the revocation-delay statistic", () => {
    const data = reportData([lease({ state: "REVOKING", provider: LIVE, last_verified_at: null, revocation_status: "pending", warning: "Revocation requested; not yet verified" })], { providers: [LIVE], contains_synthetic: false });
    const model = reportModelFromData(data);
    expect(model.provider_kind).toBe("postgres-role");
    expect(model.workspace_label).toBe("Demo (synthetic)");
    expect(model.max_revocation_request_delay_seconds).toBe(5);
    expect(model.leases[0]).toMatchObject({ provider_label: "LIVE_LOCAL_POSTGRES", warning: "Revocation requested; not yet verified", attempts: [{ result: "verified", verification_ref: "introspection+probe:denied" }], audit: [{ action: "revocation_verified" }] });
    const html = renderReport(model);
    expect(model.leases[0]?.close_reason).toBe("expired");
    expect(html).toContain("Why revocation began");
    expect(html).toContain("Revocation requested; not yet verified");
    expect(html).toContain("Longest delay between expiry and the first revocation request: <strong>5 s</strong>");
  });

  it("reports an unmeasured delay and empty verification references honestly", () => {
    const data = reportData([lease({ attempts: [{ id: "a", lease_id: "l", attempt_no: 1, attempted_at: "t", result: "provider_error", verification_ref: "", detail: {}, next_retry_at: null }] })]);
    data.summary.max_revocation_request_delay_seconds = null;
    const model = reportModelFromData(data);
    expect(model.leases[0]?.attempts[0]?.verification_ref).toBeNull();
    expect(renderReport(model)).toContain("not measured");
  });

  it("counts unresolved leases for exit code 4", () => {
    expect(unresolvedInReport(reportData([lease({ state: "ISSUE_UNKNOWN" }), lease({ state: "REVOCATION_UNCONFIRMED" }), lease()]))).toBe(2);
    expect(unresolvedInReport(reportData([lease()]))).toBe(0);
    expect(reportData([lease({ provider: LIVE }), lease({ provider: SYNTH })]).leases.length).toBe(2);
  });
});
