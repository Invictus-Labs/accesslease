import assert from "node:assert/strict";
import { processIssue } from "../../../src/workers/issue.js";
import { processRevoke } from "../../../src/workers/revoke.js";
import { startRevocation } from "../../../src/services/lifecycle.js";
import { computePlanHash } from "../../../src/services/policy.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PostgresRoleProvider } from "../../../src/connectors/postgres-role.js";
import type { IssueRequest, GrantTarget, RevokeResult } from "../../../src/connectors/provider.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
/** Synthetic transaction/lock model. Exercises shipped provider control flow, not PostgreSQL acceptance. */
function harness() {
  let lockTail = Promise.resolve();
  let fence: { lease_id: string; resource_ref: string } | undefined;
  let role = false;
  let privateAcl = true;
  let noRls = true;
  let missing = false;
  let permissionDenied = false;
  let failFenceCommit = false;
  let controlOwner = "admin";
  let version = "accesslease:terminal-fences:v1";
  let connectGate: ReturnType<typeof deferred> | undefined;
  let fenceCommitGate: ReturnType<typeof deferred> | undefined;
  const fenceCommitReached = deferred();
  let commitGate: ReturnType<typeof deferred> | undefined;
  const commitReached = deferred();
  const lockWaiting = deferred();
  const provider = new PostgresRoleProvider({ adminUrl: "postgres://admin:synthetic@localhost/reporting", allowlist: ["localhost"] });
  const target: GrantTarget = { leaseId: randomUUID(), resource: "reporting" };
  const request = (): IssueRequest => ({ ...target, scopes: ["pg:app.orders:select"], attempt: 1, subject: "synthetic-subject", expiresAt: new Date(Date.now() + 60_000), credentialSecret: "synthetic-password-123456" });
  const connect = async () => {
    const wait = connectGate; connectGate = undefined;
    if (wait) await wait.promise;
    let release: (() => void) | undefined;
    let pendingFence: typeof fence;
    let pendingRole = false;
    // Provider default deliberately models REPEATABLE READ; only explicit READ COMMITTED avoids stale snapshots.
    let readCommitted = false;
    let snapshotCaptured = false;
    let snapshotFence: typeof fence;
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED") readCommitted = true;
      if (sql.includes("FROM pg_namespace") && !snapshotCaptured) { snapshotCaptured = true; snapshotFence = fence; }
      if (permissionDenied && sql.includes("terminal_fences WHERE")) throw Object.assign(new Error("synthetic permission denied"), { code: "42501" });
      if (sql.includes("FROM pg_namespace")) return { rows: missing ? [] : [{ private_acl: privateAcl, no_rls: noRls, durable: true, schema_owner: controlOwner, table_owner: controlOwner, kind: "r", schema_version: "accesslease:provider-control:v1", table_version: version }] };
      if (sql === "SELECT current_user AS name") return { rows: [{ name: "admin" }] };
      if (sql.includes("pg_advisory_xact_lock")) {
        const prior = lockTail; const held = deferred(); lockTail = held.promise;
        lockWaiting.resolve(); await prior; release = held.resolve;
      } else if (sql.startsWith("SELECT lease_id")) return { rows: (readCommitted ? fence : snapshotFence) ? [readCommitted ? fence : snapshotFence] : [] };
      else if (sql.startsWith("INSERT INTO accesslease_control")) pendingFence = { lease_id: String(values[1]), resource_ref: String(values[2]) };
      else if (sql.includes("FROM pg_roles")) return { rows: role ? [{ comment: `accesslease:lease:${target.leaseId}` }] : [] };
      else if (sql.startsWith("CREATE ROLE")) pendingRole = true;
      else if (sql === "COMMIT") {
        if (pendingRole && commitGate) { commitReached.resolve(); await commitGate.promise; }
        if (pendingFence && fenceCommitGate) { fenceCommitReached.resolve(); await fenceCommitGate.promise; }
        if (pendingFence && failFenceCommit) throw Object.assign(new Error("synthetic lost fence commit"), { code: "08006" });
        if (pendingRole) role = true;
        if (pendingFence) fence = pendingFence;
        release?.(); release = undefined;
      } else if (sql === "ROLLBACK") { release?.(); release = undefined; }
      return { rows: [] };
    };
    return { query, escapeIdentifier: pg.escapeIdentifier, escapeLiteral: pg.escapeLiteral, end: async () => { release?.(); } } as unknown as pg.Client;
  };
  const internals = provider as unknown as { connect: typeof connect; revokeFenced: (target: GrantTarget) => Promise<RevokeResult> };
  internals.connect = connect;
  internals.revokeFenced = async () => { role = false; return { steps: [{ step: "role_absent", ok: true }], sessionsTerminated: 0 }; };
  return { provider, target, request, internals, commitReached, lockWaiting, fenceCommitReached,
    get role() { return role; }, get fence() { return fence; },
    delayConnect() { connectGate = deferred(); return connectGate; },
    delayFenceCommit() { fenceCommitGate = deferred(); return fenceCommitGate; },
    delayCommit() { commitGate = deferred(); return commitGate; },
    failCommit() { failFenceCommit = true; },
    restart() {
      const restarted = new PostgresRoleProvider({ adminUrl: "postgres://admin:synthetic@localhost/reporting", allowlist: ["localhost"] });
      (restarted as unknown as { connect: typeof connect }).connect = connect; return restarted;
    },
    badAcl() { privateAcl = false; }, badRls() { noRls = false; }, missingControl() { missing = true; }, denyPermission() { permissionDenied = true; },
    badOwner() { controlOwner = "foreign"; }, badVersion() { version = "unsupported"; },
    collide() { fence = { lease_id: randomUUID(), resource_ref: target.resource }; },
  };
}

describe("provider terminal fence (synthetic control-flow model)", () => {
  it("rejects an issue whose connection resolves after terminal absence commits", async () => {
    const h = harness(); const delayed = h.delayConnect();
    const issue = h.provider.issue(h.request());
    const rejected = expect(issue).rejects.toMatchObject({ code: "grant_terminal" });
    await h.provider.revoke(h.target); expect(h.fence?.lease_id).toBe(h.target.leaseId);
    delayed.resolve(); await rejected; expect(h.role).toBe(false);
    // A fresh provider/process with the same persistent database must see the record too.
    await expect(h.restart().issue(h.request())).rejects.toMatchObject({ code: "grant_terminal" });
  });
  it("waits for prior issuance commit before dropping the role and certifying absence", async () => {
    const h = harness(); const commit = h.delayCommit();
    const issuing = h.provider.issue(h.request()); await h.commitReached.promise;
    let revoked = false;
    const revoking = h.provider.revoke(h.target).then(() => { revoked = true; });
    await new Promise<void>((done) => setImmediate(done)); expect(revoked).toBe(false);
    commit.resolve(); await issuing; await revoking;
    expect(h.role).toBe(false); expect(h.fence).toBeDefined();
    await expect(h.provider.issue(h.request())).rejects.toMatchObject({ code: "grant_terminal" });
  });
  it("uses READ COMMITTED for the post-lock fence read despite a Repeatable Read provider default", async () => {
    const h = harness(); const commit = h.delayFenceCommit();
    const revoking = h.provider.revoke(h.target); await h.fenceCommitReached.promise;
    // Catalog guard executes while revoke owns the lock but its tombstone is still uncommitted.
    const issuing = h.provider.issue(h.request());
    const rejected = expect(issuing).rejects.toMatchObject({ code: "grant_terminal" });
    await new Promise<void>((done) => setImmediate(done));
    commit.resolve(); await revoking; await rejected; expect(h.role).toBe(false);
  });
  it("retains the fence through partial cleanup and retry", async () => {
    const h = harness(); await h.provider.issue(h.request());
    const clean = h.internals.revokeFenced;
    h.internals.revokeFenced = async () => ({ steps: [{ step: "terminate_sessions", ok: false }], sessionsTerminated: 0 });
    const result = await h.provider.revoke(h.target); expect(result.steps[0]?.ok).toBe(false);
    expect(h.role).toBe(true); expect(h.fence).toBeDefined();
    await expect(h.provider.issue(h.request())).rejects.toMatchObject({ code: "grant_terminal" });
    h.internals.revokeFenced = clean; await h.provider.revoke(h.target); expect(h.role).toBe(false);
  });
  it.each(["badOwner", "badVersion", "badAcl", "badRls", "missingControl", "collide"] as const)("fails closed on %s", async (defect) => {
    const h = harness(); h[defect]();
    await expect(h.provider.issue(h.request())).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(h.provider.revoke(h.target)).rejects.toBeDefined(); expect(h.role).toBe(false);
  });
  it("rechecks expiry after delayed connection/lock acquisition", async () => {
    const h = harness(); const delayed = h.delayConnect(); const request = h.request();
    const issuing = h.provider.issue(request); const rejected = expect(issuing).rejects.toMatchObject({ code: "expired" });
    request.expiresAt = new Date(0); delayed.resolve(); await rejected; expect(h.role).toBe(false);
  });
  it("fails closed when control table permissions are unavailable", async () => {
    const h = harness(); h.denyPermission();
    await expect(h.provider.issue(h.request())).rejects.toMatchObject({code:"sql_42501"});
    await expect(h.provider.revoke(h.target)).rejects.toBeDefined();expect(h.role).toBe(false);
  });
  it("never grants the durable control schema", () => {
    expect(harness().provider.validateScope("pg:accesslease_control.terminal_fences:insert").ok).toBe(false);
  });
});

/** Scripted metadata state machine; real issue/revoke handlers and connector wrapper, synthetic cleanup/SQL only. */
function workerHarness(h: ReturnType<typeof harness>) {
const now = new Date();
let lease: any = { id:h.target.leaseId,workspace_id:randomUUID(),task_ref:'task',subject_ref:'subject',resource_ref:'reporting',scopes:['pg:app.orders:select'],expires_at:new Date(+now+3600000),policy_hash:'policy',provider_kind:'postgres-role',state:'APPROVED',version:1 };
lease.plan_hash=computePlanHash(lease);
const issueJob: any = {id:'issue',lease_id:lease.id,locked_by:'worker',attempt:1,state:'running'};
let revokeJob: any;
let grantPresent=false;
const timeline=[];
const db={transaction:async (fn:any)=>fn(db),query:async(sql:string,p:any[]=[])=>{
 const s=sql.replace(/\s+/g,' ').trim();
 if(s.startsWith('SELECT * FROM leases'))return {rows:[{...lease}]};
 if(s.startsWith('SELECT id FROM jobs')){const j=p[0]==='issue'?issueJob:revokeJob;return {rows:j?.state==='running'?[{id:j.id}]:[]};}
 if(s.includes('approval_plan_hash'))return {rows:[{approval_plan_hash:lease.plan_hash,approval_expires_at:new Date(+now+3600000),current_policy_hash:'policy'}]};
 if(s.startsWith('UPDATE leases SET')){assert.equal(lease.state,p[1]);lease={...lease,state:p[2],version:lease.version+1};for(const m of s.matchAll(/(close_reason|close_requested_at|next_retry_at|revoked_at|last_verified_at) = \$(\d+)/g))lease[m[1]]=p[+m[2]-1];timeline.push({state:lease.state,grantPresent});return {rows:[{...lease}]};}
 if(s.startsWith('UPDATE jobs SET')){const j=p[0]==='issue'?issueJob:revokeJob;j.state=s.includes("state = 'done'")?'done':'queued';return {rows:[],rowCount:1};}
 if(s.startsWith('INSERT INTO jobs')){revokeJob={id:'revoke',lease_id:lease.id,locked_by:'worker',attempt:1,state:'queued'};return {rows:[{id:'revoke'}]};}
 if(s.startsWith('SELECT COALESCE(max(attempt_no)'))return {rows:[{n:1}]};
 if(s.startsWith('WITH g AS')||s.startsWith('WITH bump AS')||s.startsWith('INSERT INTO audit_events')||s.startsWith('INSERT INTO revocation_attempts')||s.startsWith('UPDATE provider_grants')||s.startsWith('UPDATE lease_secrets'))return {rows:[],rowCount:1};
 throw Error('Unhandled SQL '+s);
}};
const ctx:any={db,clock:()=>now,key:{derive:()=> 'synthetic-derived-value'.repeat(2),encrypt:()=> 'synthetic-ciphertext'},providers:{get:()=>h.provider},settings:{providerCallTimeoutMs:10,providerRevokeTimeoutMs:10,retryBaseSeconds:1,retryCapSeconds:60}};
h.provider.lookup = async () => ({ state:h.role?'present':'absent',validUntil:null,loginAllowed:h.role,activeSessions:0,scopes:null,detail:{} });
h.provider.probeUse = async () => h.role?'allowed':'denied';
return { ctx,issueJob,get lease(){return lease;},async close(){ await startRevocation(db as any,{...lease},{reason:'task_closed',at:now,actorRef:'operator',action:'lease.close_requested'}); revokeJob.state='running';return revokeJob;},retry(){revokeJob.state='running';return revokeJob;} };
}

describe("terminal fence worker ordering (synthetic)", () => {
  it("does not certify timed-out revoke, then reconciles after late issuance and durable cleanup", async () => {
    const h=harness();const commit=h.delayCommit();const w=workerHarness(h);
    expect(await processIssue(w.ctx,w.issueJob)).toBe('unknown');
    const job=await w.close();
    expect(await processRevoke(w.ctx,job)).toBe('unconfirmed');
    expect(w.lease.state).toBe('REVOCATION_UNCONFIRMED');
    commit.resolve();await new Promise<void>((done)=>setImmediate(done));
    expect(await processRevoke(w.ctx,w.retry())).toBe('verified');
    expect(w.lease.state).toBe('REVOKED_VERIFIED');expect(h.role).toBe(false);
    await expect(h.restart().issue(h.request())).rejects.toMatchObject({code:'grant_terminal'});
  });
  it("leaves failed fence commit unconfirmed even when role is absent and probe denied", async () => {
    const h=harness();const w=workerHarness(h);h.failCommit();const job=await w.close();
    expect(await processRevoke(w.ctx,job)).toBe('unconfirmed');
    expect(w.lease.state).toBe('REVOCATION_UNCONFIRMED');expect(h.role).toBe(false);expect(h.fence).toBeUndefined();
  });
  it("a surviving role is not verified even when every revoke step reports success and the login probe is denied", async () => {
    const h=harness();await h.provider.issue(h.request());const w=workerHarness(h);
    // Steps report success but leave the role in place; the probe alone is denied (e.g. a credential that no longer matches).
    h.internals.revokeFenced=async()=>({steps:[{step:'disable_login',ok:true},{step:'drop_role',ok:true}],sessionsTerminated:0});
    h.provider.probeUse=async()=>'denied';
    expect(await processRevoke(w.ctx,await w.close())).toBe('unconfirmed');
    expect(w.lease.state).toBe('REVOCATION_UNCONFIRMED');expect(h.role).toBe(true);
  });
  it("keeps failed session termination unconfirmed and permanently rejects a late issue", async () => {
    const h=harness();await h.provider.issue(h.request());const w=workerHarness(h);
    h.internals.revokeFenced=async()=>({steps:[{step:'terminate_sessions',ok:false}],sessionsTerminated:0});
    expect(await processRevoke(w.ctx,await w.close())).toBe('unconfirmed');
    expect(w.lease.state).toBe('REVOCATION_UNCONFIRMED');expect(h.fence).toBeDefined();
    await expect(h.restart().issue(h.request())).rejects.toMatchObject({code:'grant_terminal'});
  });
});
