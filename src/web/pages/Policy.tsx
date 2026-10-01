import { type FormEvent, useState } from "react";
import { ApiError, isAdmin, type Policy, savePolicy, type User } from "../api";
import { Field, LoadState } from "../components";
import { useResource } from "../hooks";

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const duration = (seconds: number): string => (seconds % 60 === 0 ? `${seconds} s (${seconds / 60} min)` : `${seconds} s`);

/** Workspace policy view. Only admins may change it; operators and viewers see it read-only. */
export function PolicyPage({ user }: { user: User }) {
  const [state, reload] = useResource<Policy>("/policy");
  return (
    <section>
      <h1>Policy</h1>
      <LoadState state={state} onRetry={reload} label="the policy">
        {(policy) => <PolicyView policy={policy} editable={isAdmin(user)} onSaved={reload} />}
      </LoadState>
    </section>
  );
}

function PolicyView({ policy, editable, onSaved }: { policy: Policy; editable: boolean; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const seconds = (name: string) => Number(form.get(name));
    setError(null);
    setSaved(false);
    try {
      await savePolicy({
        default_ttl_seconds: seconds("default_ttl_seconds"),
        max_ttl_seconds: seconds("max_ttl_seconds"),
        min_ttl_seconds: seconds("min_ttl_seconds"),
        approval_ttl_seconds: seconds("approval_ttl_seconds"),
        retention_days: seconds("retention_days"),
        scope_allow_prefixes: lines(String(form.get("scope_allow_prefixes") ?? "")),
        scope_deny_prefixes: lines(String(form.get("scope_deny_prefixes") ?? "")),
        expected_version: policy.version,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "Only an administrator can change the policy." : e instanceof ApiError && e.status === 409 ? `The policy changed since you opened it. Reload and try again. ${e.message}` : (e as Error).message);
    }
  };

  return (
    <>
      <p className="muted">
        Wildcard and admin-class scopes are always rejected. The default lease duration is one hour and the default hard maximum is eight hours; only administrators can change these values.
      </p>
      <dl className="facts">
        <Field label="Default duration">{duration(policy.default_ttl_seconds)}</Field>
        <Field label="Maximum duration">{duration(policy.max_ttl_seconds)}</Field>
        <Field label="Minimum duration">{duration(policy.min_ttl_seconds)}</Field>
        <Field label="Approval validity">{duration(policy.approval_ttl_seconds)}</Field>
        <Field label="Evidence retention">{policy.retention_days} days</Field>
        <Field label="Scope allow prefixes">{policy.scope_allow_prefixes.length ? policy.scope_allow_prefixes.join(", ") : "none configured (any valid scope not denied)"}</Field>
        <Field label="Scope deny prefixes">{policy.scope_deny_prefixes.length ? policy.scope_deny_prefixes.join(", ") : "none configured"}</Field>
        <Field label="Policy hash">
          <span className="mono">{policy.policy_hash}</span>
        </Field>
        <Field label="Version">{policy.version}</Field>
      </dl>
      {editable ? (
        <form onSubmit={submit} aria-label="Edit policy">
          <label>
            Default duration (seconds) <input name="default_ttl_seconds" type="number" min={1} defaultValue={policy.default_ttl_seconds} required />
          </label>
          <label>
            Maximum duration (seconds) <input name="max_ttl_seconds" type="number" min={1} defaultValue={policy.max_ttl_seconds} required />
          </label>
          <label>
            Minimum duration (seconds) <input name="min_ttl_seconds" type="number" min={1} defaultValue={policy.min_ttl_seconds} required />
          </label>
          <label>
            Approval validity (seconds) <input name="approval_ttl_seconds" type="number" min={1} defaultValue={policy.approval_ttl_seconds} required />
          </label>
          <label>
            Evidence retention (days) <input name="retention_days" type="number" min={1} max={3650} defaultValue={policy.retention_days} required />
          </label>
          <label>
            Scope allow prefixes (one per line)
            <textarea name="scope_allow_prefixes" rows={3} defaultValue={policy.scope_allow_prefixes.join("\n")} />
          </label>
          <label>
            Scope deny prefixes (one per line)
            <textarea name="scope_deny_prefixes" rows={3} defaultValue={policy.scope_deny_prefixes.join("\n")} />
          </label>
          <button type="submit">Save policy</button>
          {saved ? <p role="status">Policy saved.</p> : null}
          {error ? (
            <p className="state-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="state-note">Read-only: ask an administrator to change the policy.</p>
      )}
    </>
  );
}
