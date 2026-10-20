import { useEffect, useState, type FormEvent } from "react";
import { Link, Route, useParams } from "react-router";
import { api, formatDate } from "../api";
import { useAuth } from "../App";

type Overview = {
  registered: number;
  pending: number;
  approved: number;
  suspended: number;
  banned: number;
  posts: number;
  reportsPending: number;
  reportsReview: number;
  reportsClosed: number;
};

export function ModerationPages() {
  return (
    <>
      <Route path="/moderation" element={<OverviewPage />} />
      <Route path="/moderation/registrations" element={<Registrations />} />
      <Route path="/moderation/reports" element={<Reports />} />
      <Route path="/moderation/reports/:id" element={<ReportDetail />} />
      <Route path="/moderation/users" element={<Users />} />
      <Route path="/moderation/users/:id" element={<UserDetail />} />
      <Route path="/moderation/audit" element={<Audit />} />
    </>
  );
}

function Desk({ children }: { children: React.ReactNode }) {
  return (
    <section className="wide stack">
      <h1>Editors</h1>
      <nav className="subnav" aria-label="Moderation">
        <Link to="/moderation">Overview</Link>
        <Link to="/moderation/registrations">Registrations</Link>
        <Link to="/moderation/reports">Reports</Link>
        <Link to="/moderation/users">Members</Link>
        <Link to="/moderation/audit">Record</Link>
      </nav>
      {children}
    </section>
  );
}

function OverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => {
    void api<{ overview: Overview }>("/api/moderation/overview").then((result) => setOverview(result.overview));
  }, []);
  if (!overview) return <Desk><p>Loading</p></Desk>;
  const items = [
    ["Registered", overview.registered],
    ["Pending", overview.pending],
    ["Approved", overview.approved],
    ["Suspended", overview.suspended],
    ["Banned", overview.banned],
    ["Photographs", overview.posts],
    ["Reports waiting", overview.reportsPending],
    ["Under review", overview.reportsReview],
    ["Closed reports", overview.reportsClosed],
  ];
  return (
    <Desk>
      <div className="stats">
        {items.map(([label, value]) => (
          <div className="stat" key={label}><b>{value}</b>{label}</div>
        ))}
      </div>
    </Desk>
  );
}

function Registrations() {
  const [status, setStatus] = useState("pending");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Record<string, string | number>[]>([]);
  function load(nextStatus = status, nextQ = q) {
    void api<{ registrations: Record<string, string | number>[] }>(`/api/moderation/registrations?status=${nextStatus}&q=${encodeURIComponent(nextQ)}`).then((result) => setRows(result.registrations));
  }
  useEffect(() => { load(); }, [status]);
  return (
    <Desk>
      <div className="row">
        <label>Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {["pending", "approved", "rejected", "suspended", "banned", "all"].map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <form onSubmit={(event) => { event.preventDefault(); load(); }}>
          <label>Search<input value={q} onChange={(event) => setQ(event.target.value)} /></label>
        </form>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Username</th><th>Email</th><th>Verified</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                <td>{row.username}</td>
                <td>{row.email}</td>
                <td>{row.emailVerified ? "Yes" : "No"}</td>
                <td>{row.accountStatus}</td>
                <td>{formatDate(String(row.createdAt))}</td>
                <td><Link to={`/moderation/users/${row.id}`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Desk>
  );
}

function Reports() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  useEffect(() => {
    void api<{ reports: Record<string, string>[] }>(`/api/moderation/reports?status=${status}`).then((result) => setRows(result.reports));
  }, [status]);
  return (
    <Desk>
      <label>Status
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {["pending", "under_review", "resolved", "dismissed", "all"].map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Reason</th><th>Reporter</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><Link to={`/moderation/reports/${row.id}`}>{formatDate(row.createdAt)}</Link></td>
                <td>{row.targetType}</td>
                <td>{row.reason}</td>
                <td>{row.reporterUsername}</td>
                <td>{row.targetUsername}</td>
                <td>{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Desk>
  );
}

function ReportDetail() {
  const { id } = useParams();
  const [report, setReport] = useState<Record<string, string | null> | null>(null);
  const [message, setMessage] = useState("");
  async function load() {
    const result = await api<{ report: Record<string, string | null> }>(`/api/moderation/reports/${id}`);
    setReport(result.report);
  }
  useEffect(() => { void load(); }, [id]);
  async function act(path: string, reason: string) {
    await api(path, { method: "POST", body: JSON.stringify({ reason }) });
    setMessage("Recorded.");
    await load();
  }
  if (!report) return <Desk><p>Loading</p></Desk>;
  return (
    <Desk>
      <h2>{report.reason}</h2>
      <p>{report.explanation}</p>
      <p>Status: {report.status}. Reporter: {report.reporterUsername}. Subject: {report.targetUsername}</p>
      {report.postTitle && (
        <article>
          {report.imageUrl && <img src={report.imageUrl} alt={report.postTitle} />}
          <h2 className="title">{report.postTitle}</h2>
          <p>{report.postDescription}</p>
          <p className="note">{report.postAuthorUsername} · {report.postRemovedAt ? "Removed" : "Visible to members with access"}</p>
          {report.targetPostId && !report.postRemovedAt && (
            <ActionForm label="Remove photograph" onSubmit={(reason) => act(`/api/moderation/posts/${report.targetPostId}/remove`, reason)} />
          )}
        </article>
      )}
      {message && <p role="status">{message}</p>}
      {report.status !== "resolved" && report.status !== "dismissed" && (
        <div className="stack">
          <ActionForm label="Mark under review" optional onSubmit={(reason) => act(`/api/moderation/reports/${id}/review`, reason)} />
          <ActionForm label="Resolve" onSubmit={(reason) => act(`/api/moderation/reports/${id}/resolve`, reason)} />
          <ActionForm label="Dismiss" onSubmit={(reason) => act(`/api/moderation/reports/${id}/dismiss`, reason)} />
        </div>
      )}
      {report.targetUserId && <p><Link to={`/moderation/users/${report.targetUserId}`}>Open the account</Link></p>}
    </Desk>
  );
}

function Users() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<Record<string, string | number>[]>([]);
  return (
    <Desk>
      <form className="row" onSubmit={(event) => {
        event.preventDefault();
        void api<{ users: typeof users }>(`/api/moderation/users?q=${encodeURIComponent(q)}`).then((result) => setUsers(result.users));
      }}>
        <label>Username, email, or id<input value={q} onChange={(event) => setQ(event.target.value)} /></label>
        <button type="submit">Search</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Username</th><th>Email</th><th>Status</th><th>Role</th><th>Posts</th></tr></thead>
          <tbody>
            {users.map((user) => (
              <tr key={String(user.id)}>
                <td><Link to={`/moderation/users/${user.id}`}>{user.username}</Link></td>
                <td>{user.email}</td>
                <td>{user.accountStatus}</td>
                <td>{user.role}</td>
                <td>{user.postCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Desk>
  );
}

function UserDetail() {
  const { id } = useParams();
  const { user: actor } = useAuth();
  const [record, setRecord] = useState<Record<string, string | number | null> | null>(null);
  const [history, setHistory] = useState<Record<string, string | null>[]>([]);
  const [message, setMessage] = useState("");
  async function load() {
    const result = await api<{ user: Record<string, string | number | null>; history: Record<string, string | null>[] }>(`/api/moderation/users/${id}`);
    setRecord(result.user);
    setHistory(result.history);
  }
  useEffect(() => { void load(); }, [id]);
  function act(path: string, extra: Record<string, unknown> = {}) {
    return async (reason: string) => {
      await api(path, { method: "POST", body: JSON.stringify({ reason, ...extra }) });
      setMessage("Recorded.");
      await load();
    };
  }
  if (!record) return <Desk><p>Loading</p></Desk>;
  return (
    <Desk>
      <h2>{record.username}</h2>
      <p>{record.email} · {record.accountStatus} · {record.role} · {record.postCount} photographs</p>
      {record.statusReason && <p>Last note: {record.statusReason}</p>}
      {message && <p role="status">{message}</p>}
      {(record.accountStatus === "pending" || record.accountStatus === "rejected") && (
        <ActionForm label="Approve" optional onSubmit={act(`/api/moderation/users/${id}/approve`)} />
      )}
      {record.accountStatus === "pending" && (
        <ActionForm label="Reject" onSubmit={act(`/api/moderation/users/${id}/reject`)} />
      )}
      {record.accountStatus === "approved" && (
        <>
          <ActionForm label="Suspend 7 days" onSubmit={act(`/api/moderation/users/${id}/suspend`, { days: 7 })} />
          <ActionForm label="Suspend indefinitely" onSubmit={act(`/api/moderation/users/${id}/suspend`, { days: null })} />
          <ActionForm label="Ban" onSubmit={act(`/api/moderation/users/${id}/ban`)} />
        </>
      )}
      {record.accountStatus === "suspended" && (
        <>
          <ActionForm label="Reinstate" onSubmit={act(`/api/moderation/users/${id}/reinstate`)} />
          <ActionForm label="Ban" onSubmit={act(`/api/moderation/users/${id}/ban`)} />
        </>
      )}
      {record.accountStatus === "banned" && actor?.role === "admin" && (
        <ActionForm label="Reinstate" onSubmit={act(`/api/moderation/users/${id}/reinstate`)} />
      )}
      {actor?.role === "admin" && record.id !== actor.id && (
        <>
          <ActionForm label="Make moderator" onSubmit={act(`/api/moderation/users/${id}/role`, { role: "moderator" })} />
          <ActionForm label="Make member" onSubmit={act(`/api/moderation/users/${id}/role`, { role: "user" })} />
          <ActionForm label="Make administrator" onSubmit={act(`/api/moderation/users/${id}/role`, { role: "admin" })} />
        </>
      )}
      <h2>History</h2>
      <ul>{history.map((entry) => <li key={String(entry.id)}>{formatDate(String(entry.createdAt))} — {entry.actorLabel} — {entry.action} {entry.reason ? `— ${entry.reason}` : ""}</li>)}</ul>
    </Desk>
  );
}

function Audit() {
  const [entries, setEntries] = useState<Record<string, string | null>[]>([]);
  useEffect(() => {
    void api<{ entries: Record<string, string | null>[] }>("/api/moderation/audit").then((result) => setEntries(result.entries));
  }, []);
  return (
    <Desk>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Editor</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={String(entry.id)}>
                <td>{formatDate(String(entry.createdAt))}</td>
                <td>{entry.actorLabel}</td>
                <td>{entry.action}</td>
                <td>{entry.targetType} {entry.targetId}</td>
                <td>{entry.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Desk>
  );
}

function ActionForm({ label, onSubmit, optional = false }: { label: string; onSubmit: (reason: string) => Promise<void>; optional?: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirm(`${label}?`)) return;
    setError("");
    try {
      await onSubmit(String(new FormData(event.currentTarget).get("reason") ?? ""));
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    }
  }
  if (!open) return <button type="button" className="secondary" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form className="stack" onSubmit={submit}>
      <label>{label} reason<textarea name="reason" required={!optional} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit">Confirm {label.toLowerCase()}</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
