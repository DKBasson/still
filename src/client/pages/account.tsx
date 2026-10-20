import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, Route, useNavigate, useSearchParams } from "react-router";
import { ApiError, api } from "../api";
import { useAuth } from "../App";

export function AccountPages() {
  return (
    <>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/reset-password" element={<Reset />} />
      <Route path="/pending" element={<Status code="pending" title="Awaiting an editor" copy="The email address is confirmed. An editor still has to approve the account before the photographs open." />} />
      <Route path="/rejected" element={<Status code="rejected" title="Not approved" copy="This registration was not approved. You can appeal by writing to the editor who reviewed it." />} />
      <Route path="/suspended" element={<Status code="suspended" title="Account suspended" copy="This account cannot be used until the suspension ends or an editor reinstates it." />} />
      <Route path="/banned" element={<Status code="banned" title="Account banned" copy="This account cannot be used. An administrator can review an appeal." />} />
    </>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="mast">
        <Link to="/" className="wordmark">still</Link>
        <nav aria-label="Account">
          <Link to="/login">Sign in</Link>
          <Link to="/register">Request access</Link>
          <Link to="/policy">Conduct</Link>
        </nav>
      </header>
      <main id="content" className="column status-page">{children}</main>
    </div>
  );
}

function Login() {
  const { user, ready, refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  if (ready && user?.accountStatus === "approved") return <Navigate to="/" replace />;
  if (ready && user && user.accountStatus !== "approved") return <Navigate to={`/${user.accountStatus}`} replace />;
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      await api("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      await refresh();
      navigate("/");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not sign in.");
    }
  }
  return (
    <Gate>
      <h1>Sign in</h1>
      <p className="lede">Only approved members can see photographs.</p>
      <form className="stack" onSubmit={onSubmit}>
        <label>Email<input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="submit">Sign in</button>
          <Link to="/forgot">Forgot password</Link>
        </div>
      </form>
    </Gate>
  );
}

function Register() {
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [mailbox, setMailbox] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    setError("");
    try {
      await api("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          email,
          password: form.get("password"),
          name: form.get("username"),
          username: String(form.get("username") ?? "").trim().toLowerCase(),
          callbackURL: "/pending",
        }),
      });
      setDone(email);
      const dev = await fetch(`/api/dev/mailbox?recipient=${encodeURIComponent(email.toLowerCase())}`);
      if (dev.ok) {
        const data = (await dev.json()) as { messages: { body: string }[] };
        const link = data.messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
        if (link) setMailbox(link);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not submit the request.");
    }
  }
  return (
    <Gate>
      <h1>Request access</h1>
      <p className="lede">Membership is quiet on purpose. An editor approves each account after the email address is verified.</p>
      {done ? (
        <div className="stack">
          <p role="status">Check {done} for a verification link. After that, sign in to see the waiting room. Approval is a separate step.</p>
          {mailbox && <p><a href={mailbox}>Open the development verification link</a></p>}
        </div>
      ) : (
        <form className="stack" onSubmit={onSubmit}>
          <label>Username<input name="username" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" autoComplete="username" /></label>
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          <label>Password<input name="password" type="password" required minLength={10} autoComplete="new-password" /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit">Submit request</button>
        </form>
      )}
    </Gate>
  );
}

function Forgot() {
  const [sent, setSent] = useState("");
  const [mailbox, setMailbox] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    await api("/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email, redirectTo: "/reset-password" }),
    });
    setSent(email);
    const dev = await fetch(`/api/dev/mailbox?recipient=${encodeURIComponent(email.toLowerCase())}`);
    if (dev.ok) {
      const data = (await dev.json()) as { messages: { body: string }[] };
      const link = data.messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
      if (link) setMailbox(link);
    }
  }
  return (
    <Gate>
      <h1>Reset a password</h1>
      {sent ? (
        <div className="stack">
          <p role="status">If an account exists for {sent}, a reset link is on its way.</p>
          {mailbox && <p><a href={mailbox}>Open the development reset link</a></p>}
        </div>
      ) : (
        <form className="stack" onSubmit={onSubmit}>
          <label>Email<input name="email" type="email" required /></label>
          <button type="submit">Send link</button>
        </form>
      )}
    </Gate>
  );
}

function Reset() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [error, setError] = useState(params.get("error") ? "That link is no longer valid." : "");
  const [done, setDone] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ newPassword: new FormData(event.currentTarget).get("password"), token }),
      });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not reset the password.");
    }
  }
  return (
    <Gate>
      <h1>Choose a new password</h1>
      {done ? <p role="status">Password updated. <Link to="/login">Sign in</Link></p> : (
        <form className="stack" onSubmit={onSubmit}>
          <label>New password<input name="password" type="password" minLength={10} required autoComplete="new-password" /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={!token}>Update password</button>
        </form>
      )}
    </Gate>
  );
}

function Status({ code, title, copy }: { code: string; title: string; copy: string }) {
  const { user, ready } = useAuth();
  if (ready && user?.accountStatus === "approved") return <Navigate to="/" replace />;
  const waitingOnEmail = user?.accountStatus === "pending" && !user.emailVerified;
  const message = waitingOnEmail
    ? "Open the verification link from your email, then sign in again."
    : user?.statusReason || copy;
  return (
    <Gate>
      <h1>{title}</h1>
      <p className="lede">{message}</p>
      <p className="note">Status: {user?.accountStatus ?? code}</p>
      {user ? (
        <button type="button" className="secondary" onClick={() => api("/api/auth/sign-out", { method: "POST" }).finally(() => location.assign("/login"))}>Sign out</button>
      ) : (
        <Link className="button" to="/login">Sign in</Link>
      )}
    </Gate>
  );
}
