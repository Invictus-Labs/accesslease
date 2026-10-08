import { Link, useParams } from "react-router-dom";
import type { AuditEventRecord, RevocationAttemptRecord } from "../domain/types";
import { formatMetadata } from "../report/status";
import { type Lease } from "./api";
import { Field, LoadState, StateBadge, SyntheticBanner, UncertaintyWarning } from "./components";
import { useResource } from "./hooks";

/** Revocation attempts in the order recorded. History is append-only, so failures stay visible. */
export function AttemptsTable({ attempts }: { attempts: RevocationAttemptRecord[] }) {
  if (attempts.length === 0) return <p className="state-empty">No revocation attempts recorded.</p>;
  return (
    <table>
      <caption>Revocation attempts</caption>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Attempted at (UTC)</th>
          <th scope="col">Result</th>
          <th scope="col">Verification reference</th>
          <th scope="col">Next retry (UTC)</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((a) => (
          <tr key={a.id} className={a.result === "verified" ? undefined : "unresolved"}>
            <td>{a.attempt_no}</td>
            <td>{a.attempted_at}</td>
            <td>{a.result === "verified" ? "verified" : `${a.result} (not verified)`}</td>
            <td className="mono">{a.verification_ref || "—"}</td>
            <td>{a.next_retry_at ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditTable({ events }: { events: AuditEventRecord[] }) {
  if (events.length === 0) return <p className="state-empty">No audit events recorded.</p>;
  return (
    <table>
      <caption>Audit trail</caption>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Occurred at (UTC)</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td>{e.seq}</td>
            <td>{e.occurred_at}</td>
            <td>{e.actor_ref}</td>
            <td>{e.action}</td>
            <td>{formatMetadata(e.metadata) || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Evidence summary for one lease: state, verification, attempts and audit trail. Printable. */
export function LeaseReport({ lease }: { lease: Lease }) {
  return (
    <article className="card" aria-label="Lease evidence report">
      <h2>Evidence report: {lease.task_ref}</h2>
      <SyntheticBanner synthetic={!lease.provider.live} />
      <UncertaintyWarning state={lease.state} lastVerifiedAt={lease.last_verified_at} nextRetryAt={lease.next_retry_at} warning={lease.warning} />
      <dl className="facts">
        <Field label="State">
          <StateBadge state={lease.state} lastVerifiedAt={lease.last_verified_at} />
        </Field>
        <Field label="Provider">{lease.provider.label}</Field>
        <Field label="Expires at (UTC)">{lease.expires_at}</Field>
        <Field label="Last verified at (UTC)">{lease.last_verified_at ?? "—"}</Field>
        <Field label="Revocation status">{lease.revocation_status}</Field>
        <Field label="Lease id">
          <span className="mono">{lease.id}</span>
        </Field>
      </dl>
      <AttemptsTable attempts={lease.attempts} />
      <AuditTable events={lease.audit} />
    </article>
  );
}

/** Route page: `/leases/:id/report`. */
export function ReportPage() {
  const { id = "" } = useParams();
  const [state, reload] = useResource<Lease>(`/leases/${encodeURIComponent(id)}`);
  return (
    <section>
      <p className="crumbs">
        <Link to="/leases">Leases</Link> / <Link to={`/leases/${encodeURIComponent(id)}`}>Lease</Link> / Report
      </p>
      <LoadState state={state} onRetry={reload} label="the lease report">
        {(lease) => <LeaseReport lease={lease} />}
      </LoadState>
    </section>
  );
}
