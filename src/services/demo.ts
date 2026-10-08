import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderRegistry } from "../connectors/provider.js";
import { SyntheticProvider } from "../connectors/synthetic.js";
import { type Ctx, defaultSettings, fixedClock } from "../context.js";
import { ServerKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { labelForKind } from "../domain/scopes.js";
import type { Principal } from "../domain/types.js";
import { AppError } from "../errors.js";
import { deterministicIds, withIdGenerator } from "../lib/ids.js";
import { silentLogger } from "../lib/log.js";
import { createWorkspace } from "./auth.js";
import type { DemoOptions, DemoResult } from "./contract.js";
import { exportBundle } from "./evidence.js";
import { approveLease, closeLease, requestLease, retrieveCredential, revokeLease } from "./leases.js";
import { getReportData } from "./report.js";
import { unresolvedCount } from "./unresolved.js";
import { runWorkerOnce } from "../workers/index.js";

const DEFAULT_START = "2026-01-01T00:00:00.000Z";

/**
 * Offline synthetic demo: SYNTHETIC provider, fixed (injected) clock, deterministic ids, no network, no telemetry.
 * It runs inside a throwaway schema of the given PostgreSQL database and drops it afterwards. The scenario deliberately leaves one
 * lease REVOCATION_UNCONFIRMED so the report shows an unresolved state (exit code 4 material). Nothing here is live evidence.
 */
export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const schema = `al_demo_${randomBytes(4).toString("hex")}`;
  const control = openDatabase(options.databaseUrl, { max: 1 });
  await control.query(`CREATE SCHEMA "${schema}"`);
  const db = openDatabase(options.databaseUrl, { schema, max: 4 });
  try {
    return await withIdGenerator(deterministicIds("accesslease-demo"), async () => {
      await migrate(db);
      const clock = fixedClock(options.startAt ?? DEFAULT_START);
      const provider = new SyntheticProvider({ clock });
      const ctx: Ctx = {
        db,
        clock,
        key: ServerKey.generate(),
        settings: { ...defaultSettings, secureCookies: false, retryBaseSeconds: 5, retryCapSeconds: 60 },
        providers: new ProviderRegistry([provider], "synthetic"),
        log: silentLogger,
      };
      const workspaceId = await db.transaction((tx) => createWorkspace(tx, ctx, "Demo Workspace (SYNTHETIC)", clock()));
      const principal = (role: Principal["role"]): Principal => ({
        actorRef: `demo:${role}`,
        userId: null,
        email: null,
        workspaceId,
        workspaceName: "Demo Workspace (SYNTHETIC)",
        role,
        sessionId: null,
      });
      const operator = principal("operator");
      const admin = principal("admin");
      const viewer = principal("viewer");
      const iso = (seconds: number) => new Date(clock().getTime() + seconds * 1000).toISOString();
      const drive = async () => {
        for (let i = 0; i < 10; i += 1) if ((await runWorkerOnce(ctx, { workerId: "demo-worker" })).jobsProcessed === 0) break;
      };
      const open = async (task: string, ttl: number, scope = "synthetic:sandbox:read") => {
        const created = await requestLease(ctx, operator, { task_ref: task, subject_ref: "demo-contractor", resource_ref: "sandbox", scopes: [scope], expires_at: iso(ttl) });
        await approveLease(ctx, operator, created.id, { plan_hash: created.plan_hash });
        return created;
      };
      const rejectedRequests: DemoResult["rejectedRequests"] = [];

      // 0. policy rejection: a wildcard scope never reaches the provider
      for (const scope of ["*", "synthetic:admin:read"]) {
        try {
          await requestLease(ctx, operator, { task_ref: "demo-policy-rejected", subject_ref: "demo-contractor", resource_ref: "sandbox", scopes: [scope], expires_at: iso(900) });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          rejectedRequests.push({ scope, code: error.code });
        }
      }

      // 1. happy path: issue, use, expire, sweep, revoke, verify
      const a = await open("demo-expiry", 1800);
      await drive();
      const credential = await retrieveCredential(ctx, operator, a.id);
      provider.openSession(a.id, credential.credential.secret);
      clock.advance(1801);
      await drive();

      // 2. issuance ambiguity: ISSUE_UNKNOWN, then reconciliation, then task closure
      provider.faults.next("issue", "ambiguous");
      const b = await open("demo-ambiguous-issue", 3600);
      await drive();
      clock.advance(6);
      await drive();
      await closeLease(ctx, operator, b.id, { reason: "task finished" });
      await drive();

      // 3. provider outage during revocation: REVOCATION_UNCONFIRMED stays visible
      const c = await open("demo-revocation-outage", 3600);
      await drive();
      provider.faults.always("revoke", "outage");
      provider.faults.always("lookup", "outage");
      await revokeLease(ctx, operator, c.id, { reason: "operator revoked during provider outage" });
      await drive();

      const reportData = await getReportData(ctx, viewer);
      const bundle = await exportBundle(ctx, admin);
      const unresolved = await unresolvedCount(ctx);
      const files: DemoResult["files"] = {};
      if (options.outDir) {
        mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
        chmodSync(options.outDir, 0o700);
        files.reportData = join(options.outDir, "report-data.json");
        files.bundle = join(options.outDir, "evidence-bundle.json");
        writeFileSync(files.reportData, `${JSON.stringify(reportData, null, 2)}\n`, { mode: 0o600 });
        writeFileSync(files.bundle, bundle.bytes, { mode: 0o600 });
      }
      return { provider: labelForKind("synthetic"), reportData, bundle, files, unresolved, rejectedRequests };
    });
  } finally {
    await db.close();
    await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await control.close();
  }
}
