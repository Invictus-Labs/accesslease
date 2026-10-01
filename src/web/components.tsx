import { type ReactNode } from "react";
import { presentState } from "../report/status";
import { type Loadable } from "./hooks";

/**
 * State badge. The text always carries the meaning (colour is a second channel) and uncertain states add an
 * explicit warning marker. Only REVOKED_VERIFIED with a verification time is ever green.
 */
export function StateBadge({ state, lastVerifiedAt }: { state: string; lastVerifiedAt?: string | null }) {
  const p = presentState(state, lastVerifiedAt);
  return (
    <span className={`badge tone-${p.tone}`} data-state={state} data-tone={p.tone}>
      {p.uncertain ? <span aria-hidden="true">&#9888; </span> : null}
      {p.uncertain ? <span className="sr-only">Warning: </span> : null}
      {p.label}
    </span>
  );
}

/**
 * Shown for ISSUE_UNKNOWN, REVOCATION_UNCONFIRMED and inconsistent records, with the server's warning text and the
 * next retry time. In-progress states (REVOKING) show the server warning as a notice. Never styled as success.
 */
export function UncertaintyWarning({ state, lastVerifiedAt, nextRetryAt, warning }: { state: string; lastVerifiedAt?: string | null; nextRetryAt?: string | null; warning?: string | null }) {
  const p = presentState(state, lastVerifiedAt);
  if (!p.uncertain) {
    return warning ? (
      <p className="notice" role="status">
        {warning}
      </p>
    ) : null;
  }
  return (
    <div className="warning" role="alert">
      <strong>&#9888; {p.label}: do not treat this lease as revoked or safe.</strong>
      <p>{p.explanation}</p>
      {warning ? <p>Server note: {warning}</p> : null}
      <p>{nextRetryAt ? <>Next retry at (UTC): <time dateTime={nextRetryAt}>{nextRetryAt}</time></> : "No retry is scheduled. An operator must investigate."}</p>
    </div>
  );
}

/** Banner for leases issued by the synthetic provider. They are never live evidence. */
export function SyntheticBanner({ synthetic }: { synthetic: boolean }) {
  if (!synthetic) return null;
  return (
    <p className="banner synthetic" role="note">
      <strong>SYNTHETIC</strong> &mdash; issued by the synthetic provider. Not live evidence.
    </p>
  );
}

export interface ProviderInfo {
  provider: { kind: string; label: string; live: boolean };
  connected: boolean;
  code: string | null;
}

/**
 * Provider status for operators (`GET /provider`). A disconnected provider is a visible alert: live operations
 * fail explicitly until it is reachable. Viewers cannot read the route, so nothing is shown for them.
 */
export function ProviderStatus({ info }: { info: ProviderInfo | null }) {
  if (!info) return null;
  if (!info.connected) {
    return (
      <p className="warning" role="alert">
        &#9888; Provider {info.provider.label} is <strong>disconnected</strong>
        {info.code ? ` (${info.code})` : ""}. Approving or issuing against it fails explicitly until it is reachable; leases already issued still need verified revocation.
      </p>
    );
  }
  return (
    <p className="muted provider-line" role="status">
      Provider: {info.provider.label}, connected{info.provider.live ? "" : " (not live evidence)"}
    </p>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <p className="state-error" role="alert">
      {message}{" "}
      {onRetry ? (
        <button type="button" className="link" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </p>
  );
}

/** Loading, failure and ready rendering in one place. Empty handling is the caller's `render`. */
export function LoadState<T>({ state, onRetry, label, children }: { state: Loadable<T>; onRetry?: () => void; label: string; children: (data: T) => ReactNode }) {
  if (state.status === "loading")
    return (
      <p className="state-note" role="status">
        Loading {label}&hellip;
      </p>
    );
  if (state.status === "error") return <ErrorBanner message={`Could not load ${label}: ${state.message}`} onRetry={onRetry} />;
  return <>{children(state.data)}</>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
