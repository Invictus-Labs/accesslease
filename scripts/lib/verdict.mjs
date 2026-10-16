// Pure verdict logic shared by the gate and by the seeded-failure negative control.
// A step is { name, required, status: "PASS" | "FAIL" | "SKIPPED" }. A matrix row is { ac, status }.

export const AC_STATUSES = ["PASS", "PARTIAL", "NOT RUN", "BLOCKED", "PENDING_HUMAN_RECEIPT"];
export const HUMAN_ONLY = "AC-11";

/** Parse docs/qa/ac-matrix.md: a markdown table whose first cell is `AC-NN` and second is the status. */
export function parseMatrix(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const ac = cells[1];
    if (!/^AC-\d\d$/.test(ac ?? "")) continue;
    rows.push({ ac, status: cells[2].replace(/\*/g, "").trim() });
  }
  return rows;
}

/**
 * Release verdict. RED on any failed required step, any required matrix row that is not PASS (AC-11 may only be
 * PENDING_HUMAN_RECEIPT, or PASS when a human receipt exists), or a matrix with missing rows. Skipped required steps are
 * never green. GREEN_PENDING_HUMAN_RECEIPT is the best an agent-run gate can ever report.
 */
export function computeVerdict({ steps, matrix, humanReceiptValid = false, allowIncompleteMatrix = false }) {
  const reasons = [];
  for (const s of steps) {
    if (s.required && s.status === "FAIL") reasons.push(`required step failed: ${s.name}`);
    if (s.required && s.status === "SKIPPED") reasons.push(`required step skipped: ${s.name}`);
  }
  const byAc = new Map(matrix.map((r) => [r.ac, r.status]));
  const expected = Array.from({ length: 13 }, (_, i) => `AC-${String(i + 1).padStart(2, "0")}`);
  let matrixIncomplete = false;
  for (const ac of expected) {
    const status = byAc.get(ac);
    if (status === undefined) {
      matrixIncomplete = true;
      reasons.push(`matrix row missing: ${ac}`);
    } else if (!AC_STATUSES.includes(status)) {
      matrixIncomplete = true;
      reasons.push(`matrix row has unknown status: ${ac} = ${status}`);
    } else if (ac === HUMAN_ONLY) {
      if (status === "PASS" && !humanReceiptValid) reasons.push("AC-11 marked PASS without a valid human receipt");
      else if (status !== "PASS" && status !== "PENDING_HUMAN_RECEIPT") {
        matrixIncomplete = true;
        reasons.push(`AC-11 is ${status}; it must be PENDING_HUMAN_RECEIPT or PASS with a human receipt`);
      }
    } else if (status !== "PASS") {
      matrixIncomplete = true;
      reasons.push(`${ac} is ${status}, not PASS`);
    }
  }
  const mechanicalFail = reasons.some((r) => r.startsWith("required step") || r.startsWith("AC-11 marked PASS"));
  if (mechanicalFail) return { verdict: "RED", reasons };
  if (matrixIncomplete) return { verdict: allowIncompleteMatrix ? "YELLOW_DEVELOPMENT_ONLY" : "RED", reasons };
  return { verdict: byAc.get(HUMAN_ONLY) === "PASS" ? "GREEN" : "GREEN_PENDING_HUMAN_RECEIPT", reasons };
}

export const verdictIsAcceptable = (verdict) => verdict === "GREEN" || verdict === "GREEN_PENDING_HUMAN_RECEIPT";
