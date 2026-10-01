import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { needsAttention } from "../../report/status";
import { api, canOperate, type LeaseListItem, type LeasePage, type User } from "../api";
import { ErrorBanner, StateBadge, SyntheticBanner } from "../components";

type ListState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: LeaseListItem[]; next: string | null; loadingMore: boolean; moreError: string | null };

export function LeaseListPage({ user }: { user: User }) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [onlyAttention, setOnlyAttention] = useState(false);

  const load = useCallback(() => {
    setState({ status: "loading" });
    api<LeasePage>("GET", "/leases?limit=100").then(
      (page) => setState({ status: "ready", items: page.items, next: page.next_cursor, loadingMore: false, moreError: null }),
      (error: Error) => setState({ status: "error", message: error.message }),
    );
  }, []);
  useEffect(load, [load]);

  const loadMore = () => {
    if (state.status !== "ready" || !state.next) return;
    const { items, next } = state;
    setState({ ...state, loadingMore: true, moreError: null });
    api<LeasePage>("GET", `/leases?limit=100&cursor=${encodeURIComponent(next)}`).then(
      (page) => setState({ status: "ready", items: [...items, ...page.items], next: page.next_cursor, loadingMore: false, moreError: null }),
      (error: Error) => setState({ status: "ready", items, next, loadingMore: false, moreError: error.message }),
    );
  };

  return (
    <section>
      <div className="row">
        <h1>Leases</h1>
        {canOperate(user) ? (
          <Link className="button" to="/leases/new">
            New lease
          </Link>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <p className="state-note" role="status">
          Loading leases&hellip;
        </p>
      ) : null}
      {state.status === "error" ? <ErrorBanner message={`Could not load leases: ${state.message}`} onRetry={load} /> : null}
      {state.status === "ready" ? <LeaseTable state={state} onlyAttention={onlyAttention} setOnlyAttention={setOnlyAttention} loadMore={loadMore} canCreate={canOperate(user)} /> : null}
    </section>
  );
}

function LeaseTable({
  state,
  onlyAttention,
  setOnlyAttention,
  loadMore,
  canCreate,
}: {
  state: Extract<ListState, { status: "ready" }>;
  onlyAttention: boolean;
  setOnlyAttention: (v: boolean) => void;
  loadMore: () => void;
  canCreate: boolean;
}) {
  const unresolved = state.items.filter((l) => needsAttention(l.state, l.last_verified_at));
  const shown = onlyAttention ? unresolved : state.items;
  if (state.items.length === 0 && !state.next) {
    return (
      <p className="state-empty">
        No leases yet. {canCreate ? "Create one to issue a time-limited provider grant." : "An operator creates leases; they appear here."}
      </p>
    );
  }
  return (
    <>
      {unresolved.length > 0 ? (
        <div className="warning" role="alert">
          <strong>
            &#9888; {unresolved.length} lease{unresolved.length === 1 ? "" : "s"} in an unresolved state
          </strong>{" "}
          &mdash; ISSUE UNKNOWN or REVOCATION UNCONFIRMED means access may still exist. This is not success.
        </div>
      ) : null}
      <label className="inline">
        <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} /> Show only unresolved leases
      </label>
      {shown.length === 0 ? (
        <p className="state-empty">No unresolved leases among the {state.items.length} loaded.</p>
      ) : (
        <table>
          <caption className="sr-only">Leases</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">State</th>
              <th scope="col">Expires at (UTC)</th>
              <th scope="col">Last verified (UTC)</th>
              <th scope="col">Revocation status</th>
              <th scope="col">Next retry (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className={needsAttention(l.state, l.last_verified_at) ? "unresolved" : undefined}>
                <td>
                  <Link to={`/leases/${encodeURIComponent(l.id)}`}>{l.task_ref}</Link>
                  {l.provider.kind === "synthetic" ? <span className="badge tone-synthetic"> SYNTHETIC</span> : null}
                </td>
                <td>
                  <StateBadge state={l.state} lastVerifiedAt={l.last_verified_at} />
                </td>
                <td>{l.expires_at}</td>
                <td>{l.last_verified_at ?? "—"}</td>
                <td>{l.revocation_status}</td>
                <td>{l.next_retry_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {state.moreError ? <ErrorBanner message={`Could not load more leases: ${state.moreError}`} onRetry={loadMore} /> : null}
      {state.next ? (
        <button type="button" onClick={loadMore} disabled={state.loadingMore}>
          {state.loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
      <SyntheticBanner synthetic={state.items.some((l) => l.provider.kind === "synthetic")} />
    </>
  );
}
