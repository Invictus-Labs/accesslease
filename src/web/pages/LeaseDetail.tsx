import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { approveLease, ApiError, canOperate, closeLease, formatTime, type CredentialDelivery, type Lease, newIdempotencyKey, retrieveCredential, revokeLease, type User } from "../api";
import { Field, LoadState, StateBadge, SyntheticBanner, UncertaintyWarning } from "../components";
import { useResource } from "../hooks";
import { AttemptsTable, AuditTable } from "../Report";

/** Keep refreshing until verified revocation is recorded: issuing, expiry, revocation and reconciliation all change state without user action. */
export const shouldPollLease = (lease: Lease): boolean => !(lease.state === "REVOKED_VERIFIED" && lease.last_verified_at);

/** How long a retrieved credential stays on screen before it is cleared from memory. */
export const CREDENTIAL_VISIBLE_MS = 60_000;

const REVOCABLE = new Set(["APPROVED", "ISSUING", "ACTIVE", "ISSUE_UNKNOWN", "REVOCATION_UNCONFIRMED"]);

export function LeaseDetailPage({ user }: { user: User }) {
  const { id = "" } = useParams();
  const [state, reload] = useResource<Lease>(`/leases/${encodeURIComponent(id)}`, shouldPollLease);
  return (
    <section>
      <p className="crumbs">
        <Link to="/leases">Leases</Link> / Lease
      </p>
      <LoadState state={state} onRetry={reload} label="the lease">
        {(lease) => <LeaseDetail lease={lease} user={user} onChanged={reload} />}
      </LoadState>
    </section>
  );
}

export function LeaseDetail({ lease, user, onChanged }: { lease: Lease; user: User; onChanged: () => void }) {
  return (
    <>
      <div className="row">
        <h1>{lease.task_ref}</h1>
        <StateBadge state={lease.state} lastVerifiedAt={lease.last_verified_at} />
      </div>
      <SyntheticBanner synthetic={lease.provider.kind === "synthetic"} />
      <UncertaintyWarning state={lease.state} lastVerifiedAt={lease.last_verified_at} nextRetryAt={lease.next_retry_at} warning={lease.warning} />
      <dl className="facts">
        <Field label="Subject">{lease.subject_ref}</Field>
        <Field label="Resource">{lease.resource_ref}</Field>
        <Field label="Provider">{lease.provider.label}</Field>
        <Field label="Scopes">
          {lease.scopes.length === 0 ? (
            "none"
          ) : (
            <ul className="scopes">
              {lease.scopes.map((s) => (
                <li key={s}>
                  <code>{s}</code>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Expires at (UTC)">{formatTime(lease.expires_at)}</Field>
        <Field label="Last verified at (UTC)">{formatTime(lease.last_verified_at)}</Field>
        <Field label="Revocation status">{lease.revocation_status}</Field>
        <Field label="Why revocation began">{lease.close_reason ?? "—"}</Field>
        <Field label="Next retry at (UTC)">{lease.next_retry_at ? formatTime(lease.next_retry_at) : "—"}</Field>
        <Field label="Plan hash">
          <span className="mono">{lease.plan_hash}</span>
        </Field>
        <Field label="Lease id">
          <span className="mono">{lease.id}</span>
        </Field>
      </dl>
      <p className="muted">An expiry time is not a revocation. A lease is shown as revoked only after independent verification.</p>
      {canOperate(user) ? <LeaseActions lease={lease} onChanged={onChanged} /> : <p className="state-note">Viewers have read-only access to redacted lease records.</p>}
      <AttemptsTable attempts={lease.attempts ?? []} />
      <AuditTable events={lease.audit ?? []} />
      <p>
        <Link to={`/leases/${encodeURIComponent(lease.id)}/report`}>Evidence report</Link>
      </p>
    </>
  );
}

type Notice = { kind: "ok" | "error"; text: string } | null;

function LeaseActions({ lease, onChanged }: { lease: Lease; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // One idempotency key per action, reused when the operator retries after a failure and rotated after success.
  const keys = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (keys.current[action] ??= newIdempotencyKey());

  const run = async (action: string, okText: string, fn: (key: string) => Promise<unknown>) => {
    setBusy(action);
    setNotice(null);
    try {
      await fn(keyFor(action));
      delete keys.current[action];
      setNotice({ kind: "ok", text: okText });
      onChanged();
    } catch (e) {
      setNotice({ kind: "error", text: explain(action, e) });
    } finally {
      setBusy(null);
    }
  };

  const canApprove = lease.state === "REQUESTED";
  const canRevoke = REVOCABLE.has(lease.state);
  const canClose = lease.state === "ACTIVE";

  const onRevoke = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (!reason) {
      setNotice({ kind: "error", text: "Enter a reason for the revocation." });
      return;
    }
    void run("revoke", "Revocation requested. The state changes to revoked only after it is independently verified.", (key) => revokeLease(lease.id, reason, key));
  };

  return (
    <div className="card" aria-label="Lease actions">
      {canApprove ? (
        <div>
          <h2>Approve</h2>
          <p>
            Approving binds to exactly: subject <strong>{lease.subject_ref}</strong>, resource <strong>{lease.resource_ref}</strong>, scopes <strong>{lease.scopes.join(", ")}</strong>, expiry <strong>{lease.expires_at}</strong>. If anything changes, the approval is refused.
          </p>
          <button type="button" disabled={busy !== null} onClick={() => void run("approve", "Approved. Issuance is queued.", (key) => approveLease(lease.id, lease.plan_hash, lease.version, key))}>
            Approve this exact request
          </button>
        </div>
      ) : null}
      {canClose ? (
        <div>
          <h2>Close task</h2>
          <p>Closing the task requests revocation immediately.</p>
          <button type="button" disabled={busy !== null} onClick={() => void run("close", "Task closed. Revocation was requested and is not yet verified.", (key) => closeLease(lease.id, key))}>
            Close task and revoke access
          </button>
        </div>
      ) : null}
      {canRevoke ? (
        <form onSubmit={onRevoke} aria-label="Revoke lease">
          <h2>{lease.state === "REVOCATION_UNCONFIRMED" ? "Retry revocation" : "Revoke"}</h2>
          <label>
            Reason <input name="reason" required maxLength={500} />
          </label>
          <button type="submit" disabled={busy !== null}>
            {lease.state === "REVOCATION_UNCONFIRMED" ? "Retry revocation now" : "Revoke now"}
          </button>
        </form>
      ) : null}
      {lease.state === "ACTIVE" ? <CredentialPanel leaseId={lease.id} available={lease.credential_available} /> : null}
      {!canApprove && !canClose && !canRevoke ? <p className="state-note">No actions are available in this state.</p> : null}
      {notice ? (
        <p className={notice.kind === "ok" ? "state-note" : "state-error"} role={notice.kind === "ok" ? "status" : "alert"}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

function explain(action: string, error: unknown): string {
  if (error instanceof ApiError) {
    if (action === "approve" && error.status === 409) return `The request changed, the plan is stale or the approval expired, so nothing was issued. Reload and review the request again. ${error.message}`;
    if (error.status === 403) return `Your role is not allowed to do this. ${error.message}`;
    if (error.status === 404) return "This lease is not available to you.";
  }
  return (error as Error).message;
}

type CredentialState = { status: "idle" } | { status: "loading" } | { status: "shown"; value: CredentialDelivery["credential"] } | { status: "hidden" } | { status: "error"; message: string };

/**
 * One-time credential retrieval. The value exists only in this component's state: it is not written to any
 * browser storage, URL or log, is hidden after a minute and on unmount, and the server will not return it twice.
 */
export function CredentialPanel({ leaseId, available }: { leaseId: string; available: boolean }) {
  const [cred, setCred] = useState<CredentialState>({ status: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (cred.status !== "shown") return undefined;
    const timer = setTimeout(() => setCred({ status: "hidden" }), CREDENTIAL_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [cred]);

  const retrieve = async () => {
    setCred({ status: "loading" });
    try {
      const result = await retrieveCredential(leaseId);
      if (alive.current) setCred({ status: "shown", value: result.credential });
    } catch (e) {
      if (alive.current) setCred({ status: "error", message: e instanceof ApiError && (e.status === 409 || e.status === 410) ? `This credential was already retrieved or is not available, and cannot be shown again. ${e.message}` : (e as Error).message });
    }
  };

  return (
    <div aria-label="Credential">
      <h2>Credential</h2>
      {cred.status === "shown" ? (
        <>
          <p className="warning" role="alert">
            Copy this credential now. It is shown once, is not stored in your browser and is hidden automatically.
          </p>
          <dl className="facts">
            <Field label="Host">{cred.value.host}</Field>
            <Field label="Port">{cred.value.port}</Field>
            <Field label="Database">{cred.value.database}</Field>
            <Field label="Username">{cred.value.username}</Field>
          </dl>
          <pre className="credential" aria-label="Issued credential">
            {cred.value.secret}
          </pre>
          <button type="button" onClick={() => setCred({ status: "hidden" })}>
            Hide credential
          </button>
        </>
      ) : (
        <>
          <p>{available ? "The credential can be retrieved once, by an authorised operator." : "The credential was already retrieved or is not available."}</p>
          <button type="button" disabled={!available || cred.status === "loading" || cred.status === "hidden"} onClick={() => void retrieve()}>
            {cred.status === "loading" ? "Retrieving…" : "Retrieve credential (shown once)"}
          </button>
        </>
      )}
      {cred.status === "hidden" ? <p className="state-note" role="status">Credential hidden. It cannot be retrieved again.</p> : null}
      {cred.status === "error" ? (
        <p className="state-error" role="alert">
          {cred.message}
        </p>
      ) : null}
    </div>
  );
}
