/**
 * Service barrel: everything the CLI, the API and the adapters call. `AccessLeaseServices` (contract.ts) is checked at compile
 * time below, so a signature drift fails `npm run typecheck`.
 */
import { contextFromConfig, loadConfig } from "../config.js";
import type { Ctx } from "../context.js";
import { migrate as migrateDatabase } from "../db/migrate.js";
import { bootstrapAdmin, cliPrincipal } from "./auth.js";
import type { AccessLeaseServices } from "./contract.js";
import { runDemo } from "./demo.js";
import { runDoctor } from "./doctor.js";
import { exportBundle, importBundle, verifyBundle } from "./evidence.js";
import { pullEvents } from "./events.js";
import { approveLease, closeLease, getLease, listLeases, requestLease, retrieveCredential, revokeLease } from "./leases.js";
import { getPolicy, setPolicy } from "./policy.js";
import { getReportData, unresolvedCount } from "./report.js";
import { runWorker, runWorkerOnce, sweepOverdue } from "../workers/index.js";

/** Apply pending migrations (each in its own transaction). A failed, modified or unknown migration throws: startup stops. */
export const migrate = (ctx: Ctx) => migrateDatabase(ctx.db);

export const services: AccessLeaseServices = {
  loadConfig,
  contextFromConfig,
  migrate,
  bootstrapAdmin,
  cliPrincipal,
  requestLease,
  approveLease,
  revokeLease,
  closeLease,
  getLease,
  listLeases,
  retrieveCredential,
  getPolicy,
  setPolicy,
  runWorkerOnce,
  runWorker,
  sweepOverdue,
  exportBundle,
  verifyBundle,
  importBundle,
  pullEvents,
  getReportData,
  unresolvedCount,
  runDoctor,
  runDemo,
};

export {
  approveLease,
  bootstrapAdmin,
  cliPrincipal,
  closeLease,
  contextFromConfig,
  exportBundle,
  getLease,
  getPolicy,
  getReportData,
  importBundle,
  listLeases,
  loadConfig,
  pullEvents,
  requestLease,
  retrieveCredential,
  revokeLease,
  runDemo,
  runDoctor,
  runWorker,
  runWorkerOnce,
  setPolicy,
  sweepOverdue,
  unresolvedCount,
  verifyBundle,
};
export { addMember, createWorkspace, grantUser, listMembers, login, logout, revokeUserSessions } from "./auth.js";
export { getImportedLease, getLeaseEvidence, listImports } from "./evidence.js";
export { listJobs } from "./jobs.js";
export { migrationStatus } from "../db/migrate.js";
export type * from "./contract.js";
