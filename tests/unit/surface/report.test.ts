import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetPath, loadReportTemplate, packageRoot } from "../../../src/report/assets";
import { parseReportModel, REPORT_LIMITS, ReportInputError, type ReportLease, type ReportModelInput } from "../../../src/report/model";
import { redactText, REDACTED } from "../../../src/report/redact";
import { escapeHtml, fillTemplate, renderErrorReport, renderReport } from "../../../src/report/render";
import { isLeaseState, isUncertainState, LEASE_STATES, needsAttention, presentState, providerLabel, UNCERTAIN_STATES } from "../../../src/report/status";

const lease = (over: Partial<ReportLease> = {}): ReportLease => ({
  id: "lease-synthetic-0001",
  task_ref: "TASK-1",
  subject_ref: "contractor-a",
  resource_ref: "pg:reporting",
  scopes: ["pg:public.orders:select"],
  state: "ACTIVE",
  expires_at: "2026-01-01T01:00:00.000Z",
  last_verified_at: null,
  revocation_status: "not_requested",
  next_retry_at: null,
  attempts: [],
  audit: [],
  ...over,
});

const model = (leases: ReportLease[], over: Partial<ReportModelInput> = {}) =>
  parseReportModel({ schema_version: 1, generated_at: "2026-01-01T00:00:00.000Z", provider_kind: "synthetic", leases, ...over });

describe("state presentation", () => {
  it("covers every contract state and never marks an uncertain state verified", () => {
    for (const state of LEASE_STATES) {
      const p = presentState(state, "2026-01-01T00:00:00Z");
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.explanation.length).toBeGreaterThan(10);
      if (isUncertainState(state)) {
        expect(p.uncertain).toBe(true);
        expect(p.tone).toBe("uncertain");
      }
    }
    expect(UNCERTAIN_STATES).toEqual(["ISSUE_UNKNOWN", "REVOCATION_UNCONFIRMED"]);
  });

  it("allows the verified tone only for REVOKED_VERIFIED with a verification time", () => {
    const tones = LEASE_STATES.filter((s) => presentState(s, "2026-01-01T00:00:00Z").tone === "verified");
    expect(tones).toEqual(["REVOKED_VERIFIED"]);
    const unverified = presentState("REVOKED_VERIFIED", null);
    expect(unverified.tone).toBe("invalid");
    expect(unverified.uncertain).toBe(true);
    expect(needsAttention("REVOKED_VERIFIED", null)).toBe(true);
    expect(needsAttention("REVOKED_VERIFIED", "2026-01-01T00:00:00Z")).toBe(false);
  });

  it("treats unknown states as unresolved, not success", () => {
    expect(isLeaseState("EXPIRED")).toBe(false);
    expect(isLeaseState(42)).toBe(false);
    const p = presentState("EXPIRED");
    expect(p.tone).toBe("invalid");
    expect(p.uncertain).toBe(true);
    expect(needsAttention("EXPIRED")).toBe(true);
    expect(needsAttention("ACTIVE")).toBe(false);
  });

  it("labels the synthetic provider and unknown providers", () => {
    expect(providerLabel("synthetic")).toContain("SYNTHETIC");
    expect(providerLabel("postgres-role")).toContain("PostgreSQL");
    expect(providerLabel("mystery")).toContain("Unrecognised provider");
  });
});

describe("redaction", () => {
  it("masks credential-shaped values and keeps ordinary text", () => {
    expect(redactText("connect postgres://admin:hunter2@localhost/db now")).toBe(`connect postgres://${REDACTED}@localhost/db now`);
    expect(redactText("Authorization: Bearer abcdefghijklmnop")).toContain(REDACTED);
    expect(redactText("password=planted-fake-secret-123")).toBe(`password=${REDACTED}`);
    expect(redactText('api_key: "FAKE-KEY-VALUE"')).toBe(`api_key: ${REDACTED}`);
    expect(redactText("-----BEGIN PRIVATE KEY-----\nMIIFAKE\n-----END PRIVATE KEY-----")).toBe(REDACTED);
    expect(redactText("close ticket TASK-1 for contractor-a")).toBe("close ticket TASK-1 for contractor-a");
  });
});

describe("escaping", () => {
  it("escapes the HTML metacharacters", () => {
    expect(escapeHtml(`<img src=x onerror="a()"> & 'q' \``)).toBe("&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39; &#96;");
  });
});

describe("static report", () => {
  it("renders hostile HTML in every free-text field as text", () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const html = renderReport(
      model(
        [
          lease({
            task_ref: hostile,
            subject_ref: hostile,
            resource_ref: hostile,
            scopes: [hostile],
            revocation_status: hostile,
            id: hostile,
            attempts: [{ attempted_at: "t", result: hostile, verification_ref: hostile }],
            audit: [{ occurred_at: "t", actor_ref: hostile, action: hostile }],
          }),
        ],
        { title: hostile, workspace_label: hostile, errors: [hostile] },
      ),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    // The only script-like token allowed in the whole page is escaped text; there is no executable script tag at all.
    expect(html.match(/<script/gi)).toBeNull();
  });

  it("never prints planted credentials from free text", () => {
    const html = renderReport(model([lease({ task_ref: "ticket password=PLANTED-FAKE-SECRET-1", audit: [{ occurred_at: "t", actor_ref: "a", action: "token: PLANTED-FAKE-TOKEN-2" }] })]));
    expect(html).not.toContain("PLANTED-FAKE");
    expect(html).toContain(REDACTED);
  });

  it("shows uncertain states as warnings with the next retry and never as verified", () => {
    const html = renderReport(
      model([
        lease({ id: "a", task_ref: "T-unconfirmed", state: "REVOCATION_UNCONFIRMED", revocation_status: "provider_unreachable", next_retry_at: "2026-01-01T00:05:00.000Z" }),
        lease({ id: "b", task_ref: "T-unknown", state: "ISSUE_UNKNOWN", revocation_status: "not_requested" }),
        lease({ id: "c", task_ref: "T-ok", state: "REVOKED_VERIFIED", last_verified_at: "2026-01-01T00:10:00.000Z", revocation_status: "verified" }),
      ]),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("2 unresolved states: do not read as success");
    expect(html).toContain("REVOCATION UNCONFIRMED");
    expect(html).toContain("ISSUE UNKNOWN");
    expect(html).toContain("2026-01-01T00:05:00.000Z");
    expect(html).toContain("No retry is scheduled");
    // exactly one lease may carry the green tone: the verified one
    expect(html.match(/class="badge tone-verified"/g)?.length).toBe(3); // summary row, overview row, detail
    for (const m of html.matchAll(/class="badge tone-uncertain" data-state="([A-Z_]+)"/g)) expect(["ISSUE_UNKNOWN", "REVOCATION_UNCONFIRMED"]).toContain(m[1]);
    expect(html.includes('data-state="REVOCATION_UNCONFIRMED"') && !/tone-verified" data-state="REVOCATION_UNCONFIRMED"/.test(html)).toBe(true);
    expect(html).toContain("not scheduled");
  });

  it("flags an inconsistent verified record instead of showing it green", () => {
    const html = renderReport(model([lease({ state: "REVOKED_VERIFIED", last_verified_at: null })]));
    expect(html).toContain("Revoked state without verification time");
    expect(html).toContain('class="badge tone-invalid"');
    expect(html).toContain("1 unresolved state");
  });

  it("renders the empty state, the synthetic banner and readable tables", () => {
    const html = renderReport(model([]));
    expect(html).toContain("No leases in this report.");
    expect(html).toContain("No lease in this report is in an unresolved state");
    expect(html).toContain("SYNTHETIC");
    expect(html).toContain("Leases by state");
    const withData = renderReport(model([lease()], { provider_kind: "postgres-role" }));
    expect(withData).toContain("<th scope=\"col\">State</th>");
    expect(withData).toContain("No revocation attempts recorded.");
    expect(withData).toContain("No audit events recorded.");
    expect(withData).toContain("PostgreSQL role (local provider)");
    expect(withData).not.toContain("banner synthetic");
  });

  it("renders attempts, audit rows, scopes and load problems", () => {
    const html = renderReport(
      model(
        [
          lease({
            attempts: [{ attempted_at: "2026-01-01T00:00:01.000Z", result: "provider_error", verification_ref: null }],
            audit: [{ occurred_at: "2026-01-01T00:00:02.000Z", actor_ref: "system", action: "revocation_requested" }],
            last_verified_at: "2026-01-01T00:00:03.000Z",
            state: "ACTIVE",
          }),
        ],
        { errors: ["audit trail could not be read for 1 lease"], workspace_label: "Demo" },
      ),
    );
    expect(html).toContain("provider_error");
    expect(html).toContain("revocation_requested");
    expect(html).toContain("<code>pg:public.orders:select</code>");
    expect(html).toContain("Report problems");
    expect(html).toContain("audit trail could not be read for 1 lease");
    expect(html).toContain("Demo");
    expect(html).toContain("Generated at 2026-01-01T00:00:00.000Z (UTC)");
  });

  it("lists unrecognised states in the summary", () => {
    const html = renderReport(model([lease({ state: "EXPIRED" })]));
    expect(html).toContain("Unrecognised state: EXPIRED");
  });

  it("is a static page: no scripts, no external resources, restrictive CSP", () => {
    const html = renderReport(model([lease()]));
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//i);
  });

  it("states why nothing is shown when the data is unavailable", () => {
    const html = renderErrorReport("database unavailable <b>x</b>", "2026-01-01T00:00:00.000Z");
    expect(html).toContain("Report unavailable");
    expect(html).toContain("database unavailable &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Do not treat this page as evidence of revocation");
    expect(html).not.toContain("Leases by state");
  });

  it("fills placeholders in one pass and leaves unknown ones", () => {
    expect(fillTemplate("{{a}}|{{b}}|{{c}}", { a: "{{b}}", b: "B" })).toBe("{{b}}|B|{{c}}");
  });

  it("is deterministic for a fixed model and clock", () => {
    const m = model([lease(), lease({ id: "x", state: "ISSUE_UNKNOWN" })]);
    expect(renderReport(m)).toBe(renderReport(m));
  });
});

describe("report input validation", () => {
  it("rejects wrong versions, unknown fields and oversize input before rendering", () => {
    expect(() => parseReportModel({ schema_version: 2, generated_at: "t", provider_kind: "synthetic", leases: [] })).toThrow(ReportInputError);
    expect(() => parseReportModel({ schema_version: 1, generated_at: "t", provider_kind: "synthetic", leases: [], extra: 1 })).toThrow(/extra|Unrecognized/i);
    expect(() => parseReportModel(null)).toThrow(/invalid report input/);
    const big = Array.from({ length: REPORT_LIMITS.maxLeases + 1 }, () => lease());
    expect(() => parseReportModel({ schema_version: 1, generated_at: "t", provider_kind: "synthetic", leases: big })).toThrow(/leases/);
    expect(() => model([lease({ task_ref: "x".repeat(REPORT_LIMITS.maxTextLength + 1) })])).toThrow(/task_ref/);
  });
});

describe("package assets", () => {
  it("finds the package root and the report template", () => {
    expect(packageRoot()).toBeTruthy();
    expect(loadReportTemplate()).toContain("{{leases}}");
    expect(readFileSync(assetPath("package.json"), "utf8")).toContain('"accesslease"');
  });

  it("fails clearly when assets are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-assets-"));
    try {
      writeFileSync(join(dir, "package.json"), "{not json");
      expect(() => readFileSync(join(dir, "templates", "report.html"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
