import { type FormEvent, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { api, canOperate, loadSession, signIn, signOut, type User } from "./api";
import { type ProviderInfo, ProviderStatus } from "./components";
import { LeaseDetailPage } from "./pages/LeaseDetail";
import { LeaseListPage } from "./pages/LeaseList";
import { NewLeasePage } from "./pages/NewLease";
import { PolicyPage } from "./pages/Policy";
import { ReportPage } from "./Report";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSession().then(setUser, (e: Error) => setError(e.message));
  }, []);

  if (error)
    return (
      <p className="state-error center" role="alert">
        AccessLease is unreachable: {error}
      </p>
    );
  if (user === undefined)
    return (
      <p className="state-note center" role="status">
        Loading&hellip;
      </p>
    );
  if (user === null) return <Login onSignedIn={setUser} />;
  return (
    <BrowserRouter>
      <header className="topbar">
        <Link to="/leases" className="brand">
          AccessLease
        </Link>
        <nav aria-label="Main">
          <Link to="/leases">Leases</Link> <Link to="/policy">Policy</Link>
        </nav>
        <div className="who">
          <span>
            {user.workspace_name} &middot; {user.email} ({user.role})
          </span>
          <button type="button" className="link" onClick={() => signOut().then(() => setUser(null), (e: Error) => setError(e.message))}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <ProviderBar user={user} />
        <Routes>
          <Route path="/" element={<Navigate to="/leases" replace />} />
          <Route path="/leases" element={<LeaseListPage user={user} />} />
          <Route path="/leases/new" element={<NewLeasePage user={user} />} />
          <Route path="/leases/:id" element={<LeaseDetailPage user={user} />} />
          <Route path="/leases/:id/report" element={<ReportPage />} />
          <Route path="/policy" element={<PolicyPage user={user} />} />
          <Route path="*" element={<p className="state-note">Page not found.</p>} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

/** Provider connection status, refreshed periodically, for roles that may read it. */
export function ProviderBar({ user }: { user: User }) {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const operator = canOperate(user);
  useEffect(() => {
    if (!operator) return undefined;
    let live = true;
    const load = () =>
      api<ProviderInfo>("GET", "/provider").then(
        (i) => live && setInfo(i),
        () => live && setInfo(null),
      );
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [operator]);
  return <ProviderStatus info={info} />;
}

export function Login({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(String(form.get("email")), String(form.get("password"))));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form onSubmit={submit} aria-label="Sign in">
        <h1>AccessLease</h1>
        <p className="muted">Make temporary task access expire, and prove revocation. Accounts are created by an administrator with the bootstrap CLI; there is no open registration and no default password.</p>
        <label>
          Email <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={busy}>
          Sign in
        </button>
        {error ? (
          <p className="state-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
