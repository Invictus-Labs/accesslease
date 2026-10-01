import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportBundle, verifyBundle } from "../../../src/services/evidence.js";
import { approveLease, requestLease } from "../../../src/services/leases.js";
import { getReportData } from "../../../src/services/report.js";
import { runWorkerOnce } from "../../../src/workers/index.js";
import { type Env, goodRequest, iso, makeEnv } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await makeEnv({ settings: { maxJobsPerPass: 100 } });
});
afterAll(async () => {
  await env.drop();
});

/**
 * Performance experiment (PRD section 6: 1,000 records within 30 s on 2 CPU / 4 GB, excluding provider I/O). The synthetic
 * provider is in-process, so this measures the deterministic core: request, approve, issue, expire, revoke, verify, report, export.
 * It is a measurement with a generous ceiling, not an SLA. Latency to the database dominates: the statements per lease are fixed
 * (about 90 round trips), so on a host where a round trip costs 8 ms (a loaded Docker Desktop port forward) 1,000 leases take minutes,
 * and on a host with sub-millisecond round trips they take seconds. The test prints the measured figures.
 */
describe("deterministic core throughput (experiment)", () => {
  it("handles a batch of leases end to end (BENCH_N=1000 for the full experiment)", async () => {
    const started = Date.now();
    const N = Number(process.env.BENCH_N ?? 100);
    for (let i = 0; i < N; i += 1) {
      const created = await requestLease(env.ctx, env.operator, goodRequest({ task_ref: `bench-${i}`, expires_at: iso(env.clock, 600) }));
      await approveLease(env.ctx, env.operator, created.id, { plan_hash: created.plan_hash });
    }
    const requested = Date.now();
    for (let guard = 0; guard < 100; guard += 1) if ((await runWorkerOnce(env.ctx, { workerId: "bench" })).jobsProcessed === 0) break;
    const issued = Date.now();
    env.clock.advance(700);
    for (let guard = 0; guard < 100; guard += 1) if ((await runWorkerOnce(env.ctx, { workerId: "bench" })).jobsProcessed === 0) break;
    const revoked = Date.now();
    const report = await getReportData(env.ctx, env.viewer);
    const reported = Date.now();
    const bundle = await exportBundle(env.ctx, env.admin, {});
    const exported = Date.now();
    expect(verifyBundle(bundle.bytes, { maxFiles: 2000 }).ok).toBe(true);
    const verified = Date.now();
    console.info(
      `BENCH leases=${N} request+approve=${requested - started}ms issue=${issued - requested}ms revoke+verify=${revoked - issued}ms report=${reported - revoked}ms export=${exported - reported}ms verify=${verified - exported}ms total=${verified - started}ms bytes=${bundle.bytes.length}`,
    );
    expect(report.summary.by_state.revoked_verified).toBe(N);
    expect((verified - started) / N).toBeLessThan(1000); // generous ceiling per lease: a measurement, not an SLA
  }, 900_000);
});
