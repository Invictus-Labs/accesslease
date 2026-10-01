import { describe, expect, it } from "vitest";

/**
 * Seeded mandatory failure. It passes in every normal run. scripts/verify-seeded-failure.mjs re-runs this file with
 * ACCESSLEASE_SEEDED_FAILURE=1 and requires the run (and the release verdict computed from it) to turn RED, which proves
 * the gate cannot silently swallow a failing mandatory test.
 */
describe("seeded mandatory failure (negative control)", () => {
  it("mandatory control stays green unless a failure is seeded", () => {
    const seeded = process.env.ACCESSLEASE_SEEDED_FAILURE === "1";
    expect(seeded ? "seeded-failure-active" : "no-failure-seeded").toBe("no-failure-seeded");
  });
});
