import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { ApiError, api, type Me } from "./api";
import { AccountPages } from "./pages/account";
import { ModerationPages } from "./pages/moderation";
import { SocialPages } from "./pages/social";

type AuthValue = {
  user: Me | null;
  ready: boolean;
  block: string | null;
  refresh: () => Promise<void>;
  setUser: (user: Me | null) => void;
};

const AuthContext = createContext<AuthValue | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Auth is unavailable");
  return value;
}

export function App() {
  const [user, setUser] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [block, setBlock] = useState<string | null>(null);

  async function refresh() {
    try {
      const result = await api<{ user: Me }>("/api/me");
      setUser(result.user);
      setBlock(result.user.accountStatus === "approved" ? null : result.user.accountStatus);
    } catch (error) {
      setUser(null);
      setBlock(error instanceof ApiError && error.code.startsWith("account_") ? error.code.replace("account_", "") : null);
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const value = useMemo(() => ({ user, ready, block, refresh, setUser }), [user, ready, block]);
  return (
    <AuthContext.Provider value={value}>
      <Routes>
        <Route path="/policy" element={<Policy />} />
        {AccountPages()}
        <Route path="/*" element={<ApprovedArea />} />
      </Routes>
    </AuthContext.Provider>
  );
}

function ApprovedArea() {
  const { user, ready, block } = useAuth();
  const location = useLocation();
  if (!ready) return <p className="column note">Loading</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.accountStatus !== "approved" || block) return <Navigate to={`/${user.accountStatus}`} replace />;
  return (
    <div className="app">
      <a className="skip" href="#content">Skip to content</a>
      <header className="mast">
        <Link to="/" className="wordmark">still</Link>
        <nav aria-label="Primary">
          <Nav to="/">Home</Nav>
          <Nav to="/discover">Discover</Nav>
          <Nav to="/new">Publish</Nav>
          <Nav to={`/u/${user.username}`}>Profile</Nav>
          <Nav to="/settings">Settings</Nav>
          {(user.role === "moderator" || user.role === "admin") && <Nav to="/moderation">Editors</Nav>}
        </nav>
      </header>
      <main id="content">
        <Routes>
          {SocialPages()}
          {(user.role === "moderator" || user.role === "admin") && ModerationPages()}
          <Route path="/moderation/*" element={<Denied />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="footer">
        <span>Photographs for people who follow each other.</span>
        <Link to="/policy">Conduct</Link>
      </footer>
    </div>
  );
}

function Nav({ to, children }: { to: string; children: string }) {
  const location = useLocation();
  const current = to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);
  return <Link to={to} aria-current={current ? "page" : undefined}>{children}</Link>;
}

function Policy() {
  return (
    <article className="column">
      <p className="quiet"><Link to="/">still</Link></p>
      <h1>A note on conduct</h1>
      <div className="lede stack">
        <p>still is for individual photographs shared with people you have both chosen to follow. Do not post harassment, sexual content involving anyone under 18, threats, spam, or work you do not have the right to share.</p>
        <p>Editors review new members, reports, and accounts. They can remove a photograph or suspend or ban an account. Those decisions are recorded. A suspension may last 1, 7, or 30 days, or until an editor reinstates it. A ban stays in place until an administrator reinstates the account.</p>
        <p>To appeal a decision, reply to the registration email thread or write to the editor who approved your account. Include your username and the decision you are asking to be reviewed. Appeals are read by an administrator and are not a new public feature of the site.</p>
        <p>Photographs you delete are removed immediately unless a report is already open, in which case the file is retained for the moderation record and then deleted after 90 days. Moderation removals follow the same 90-day retention. Audit records are kept after an account is deleted, without the password or session secrets.</p>
      </div>
    </article>
  );
}

export function NotFound() {
  return (
    <section className="column">
      <h1>Not found</h1>
      <p className="lede">That page is not part of still.</p>
      <Link className="button" to="/">Return home</Link>
    </section>
  );
}

function Denied() {
  return (
    <section className="column">
      <h1>Access denied</h1>
      <p className="lede">This desk is reserved for editors.</p>
    </section>
  );
}
