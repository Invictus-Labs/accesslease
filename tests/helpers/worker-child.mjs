// Runs the real AccessLease worker loop in its own OS process so tests can kill it with SIGKILL while it holds a job lease
// (AC-06, AC-13). It imports the built package (`npm run build:server` first), exactly as the packaged CLI does.
// Environment: the normal ACCESSLEASE_* variables, plus
//   QA_JOB_LEASE_SECONDS  job lease length (default 120)       QA_POLL_MS  poll interval (default 200)
//   QA_WORKER_ID          label for this worker                 QA_HOLD_AFTER_CLAIM_MS  optional pause after each pass starts
// Every pass report is printed as one JSON line on stdout; "READY" is printed once the first pass is about to start.
import { contextFromConfig, loadConfig, runWorker } from "../../dist/src/services/index.js";

const config = loadConfig(process.env);
const ctx = contextFromConfig(config);
ctx.settings.jobLeaseSeconds = Number(process.env.QA_JOB_LEASE_SECONDS ?? 120);
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
console.log("READY");
await runWorker(ctx, {
  workerId: process.env.QA_WORKER_ID ?? "qa-child",
  pollMs: Number(process.env.QA_POLL_MS ?? 200),
  signal: abort.signal,
  onPass: (report) => console.log(JSON.stringify(report)),
});
await ctx.providers.closeAll();
process.exit(0);
