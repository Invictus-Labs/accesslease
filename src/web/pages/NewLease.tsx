import { type FormEvent, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, canOperate, createLease, newIdempotencyKey, type User } from "../api";

/** Split a scope list typed one per line or comma separated. Order is preserved; duplicates are dropped. */
export function parseScopes(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const scope = part.trim();
    if (scope) seen.add(scope);
  }
  return [...seen];
}

export function NewLeasePage({ user }: { user: User }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The same key is reused if the operator retries after a network failure, so a retry cannot create a second lease.
  const key = useRef(newIdempotencyKey());

  if (!canOperate(user)) return <p className="state-error" role="alert">Your role (viewer) cannot create leases.</p>;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawMinutes = String(form.get("minutes") ?? "").trim();
    const minutes = rawMinutes === "" ? null : Number(rawMinutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1)) {
      setError("Duration must be a whole number of minutes, or empty for the policy default.");
      return;
    }
    const scopes = parseScopes(String(form.get("scopes") ?? ""));
    if (scopes.length === 0) {
      setError("Enter at least one scope.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Empty duration: the server applies the policy default. Otherwise an absolute UTC expiry is sent.
      const expiresAt = minutes === null ? undefined : new Date(Date.now() + minutes * 60_000).toISOString();
      const created = await createLease(
        {
          task_ref: String(form.get("task_ref") ?? "").trim(),
          subject_ref: String(form.get("subject_ref") ?? "").trim(),
          resource_ref: String(form.get("resource_ref") ?? "").trim(),
          scopes,
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        },
        key.current,
      );
      key.current = newIdempotencyKey();
      navigate(`/leases/${encodeURIComponent(created.id)}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 422 ? `Rejected by policy: ${e.message}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <p className="crumbs">
        <Link to="/leases">Leases</Link> / New lease
      </p>
      <h1>Request a lease</h1>
      <p className="muted">
        A lease grants one narrowly scoped provider permission until a hard expiry. Wildcard and admin scopes, and durations over the policy maximum, are rejected. A human approval is bound to exactly this subject, resource, scopes and expiry.
      </p>
      <form onSubmit={submit} aria-label="New lease">
        <label>
          Task reference <input name="task_ref" required maxLength={200} />
        </label>
        <label>
          Subject (who receives access) <input name="subject_ref" required maxLength={200} />
        </label>
        <label>
          Resource <input name="resource_ref" required maxLength={200} />
        </label>
        <label>
          Scopes, one per line (for example synthetic:reporting:read, or pg:public.orders:select for the PostgreSQL provider)
          <textarea name="scopes" rows={3} required />
        </label>
        <label>
          Duration in minutes (leave empty for the policy default) <input name="minutes" type="number" min={1} step={1} defaultValue={60} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Requesting…" : "Request lease"}
        </button>
        {error ? (
          <p className="state-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
