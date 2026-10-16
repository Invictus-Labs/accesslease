import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.js";
import type { WorkerLoopOptions, WorkerPassReport } from "../services/contract.js";
import { claimJob, failUnexpected, LeaseLostError } from "../services/jobs.js";
import { maybePurge } from "../services/retention.js";
import { unresolvedCount } from "../services/unresolved.js";
import { processIssue } from "./issue.js";
import { processRevoke } from "./revoke.js";
import { sweepOverdue } from "./sweep.js";

export { sweepOverdue };

/**
 * One worker pass: (1) sweep overdue leases and reclaim dead jobs BEFORE anything else (AC-06), (2) claim and process
 * up to `maxJobsPerPass` due jobs (bounded claims), (3) report unresolved leases. Deterministic with an injected clock.
 */
export async function runWorkerOnce(ctx: Ctx, options: { workerId?: string } = {}): Promise<WorkerPassReport> {
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const sweep = await sweepOverdue(ctx);
  try {
    await maybePurge(ctx);
  } catch (error) {
    ctx.log({ level: "error", event: "retention.failed", code: (error as { code?: string }).code ?? "internal" });
  }
  const report: WorkerPassReport = {
    sweep,
    jobsProcessed: 0,
    issued: 0,
    reconciled: 0,
    revokeAttempts: 0,
    verified: 0,
    unconfirmed: 0,
    unresolved: { issueUnknown: 0, revocationUnconfirmed: 0 },
  };
  const handle = async (job: NonNullable<Awaited<ReturnType<typeof claimJob>>>) => {
    report.jobsProcessed += 1;
    try {
      if (job.type === "revoke") {
        const outcome = await processRevoke(ctx, job);
        if (outcome !== "skipped") report.revokeAttempts += 1;
        if (outcome === "verified") report.verified += 1;
        if (outcome === "unconfirmed") report.unconfirmed += 1;
        ctx.log({ level: outcome === "unconfirmed" ? "warn" : "info", event: "job.revoke", outcome, job_id: job.id, lease_id: job.lease_id, attempt: job.attempt });
      } else {
        const outcome = await processIssue(ctx, job);
        if (outcome === "issued") report.issued += 1;
        if (outcome === "adopted" || outcome === "unknown") report.reconciled += 1;
        ctx.log({ level: outcome === "unknown" ? "warn" : "info", event: "job.issue", outcome, job_id: job.id, lease_id: job.lease_id, attempt: job.attempt });
      }
    } catch (error) {
      if (error instanceof LeaseLostError) {
        ctx.log({ level: "warn", event: "job.lease_lost", job_id: job.id, lease_id: job.lease_id });
        return;
      }
      // An unexpected failure must not lose the job or any uncertain outcome: requeue with a visible error and back off.
      ctx.log({ level: "error", event: "job.failed", job_id: job.id, lease_id: job.lease_id, code: (error as { code?: string }).code ?? "internal" });
      await failUnexpected(ctx.db, job, (error as { code?: string }).code ?? "internal_error", ctx.clock, ctx.settings.retryBaseSeconds, ctx.settings.retryCapSeconds);
    }
  };
  // Bounded claims: at most maxJobsPerPass per pass, at most maxConcurrentJobs in flight. Jobs whose predecessor on the same lease
  // just finished become claimable in the next round of the same pass.
  const concurrency = Math.max(1, ctx.settings.maxConcurrentJobs);
  let claimed = 0;
  while (claimed < ctx.settings.maxJobsPerPass) {
    const inFlight: Promise<void>[] = [];
    const before = claimed;
    while (claimed < ctx.settings.maxJobsPerPass && inFlight.length < concurrency) {
      const job = await claimJob(ctx.db, workerId, ctx.clock, ctx.settings.jobLeaseSeconds);
      if (!job) break;
      claimed += 1;
      inFlight.push(handle(job));
    }
    await Promise.all(inFlight);
    if (claimed === before) break;
  }
  report.unresolved = await unresolvedCount(ctx);
  return report;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Long-running worker loop (`accesslease worker`). Stops cleanly on the abort signal. */
export async function runWorker(ctx: Ctx, options: WorkerLoopOptions = {}): Promise<void> {
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const pollMs = options.pollMs ?? ctx.settings.workerPollMs;
  while (!options.signal?.aborted) {
    try {
      const report = await runWorkerOnce(ctx, { workerId });
      options.onPass?.(report);
    } catch (error) {
      ctx.log({ level: "error", event: "worker.pass_failed", code: (error as { code?: string }).code ?? "internal" });
    }
    await sleep(pollMs, options.signal);
  }
}
