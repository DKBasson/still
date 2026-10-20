import { useEffect, useState, type FormEvent } from "react";
import { Link, Route, useNavigate, useParams } from "react-router";
import { api, formatDate, type Me, type Post } from "../api";
import { useAuth } from "../App";
import { REPORT_REASONS } from "./reasons";

export function SocialPages() {
  return (
    <>
      <Route path="/" element={<Feed />} />
      <Route path="/discover" element={<Discover />} />
      <Route path="/new" element={<Compose />} />
      <Route path="/u/:username" element={<Profile />} />
      <Route path="/p/:id" element={<Single />} />
      <Route path="/settings" element={<Settings />} />
    </>
  );
}

function Feed() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<{ posts: Post[]; nextCursor: string | null }>("/api/feed")
      .then((result) => {
        setPosts(result.posts);
        setCursor(result.nextCursor);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the feed."))
      .finally(() => setLoading(false));
  }, []);
  return (
    <section className="column">
      <h1>Today</h1>
      <p className="lede">Only photographs from people you and they have both chosen to follow.</p>
      {loading && <p className="note">Loading photographs.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!loading && !error && posts.length === 0 && <p>Nothing here yet. Follow someone who follows you back, or publish a photograph of your own.</p>}
      <div className="feed">
        {posts.map((post, index) => <PostCard key={post.id} post={post} eager={index === 0} onChange={setPosts} />)}
      </div>
      {cursor && (
        <button
          type="button"
          className="secondary"
          onClick={() => api<{ posts: Post[]; nextCursor: string | null }>(`/api/feed?cursor=${encodeURIComponent(cursor)}`).then((result) => {
            setPosts((current) => [...current, ...result.posts]);
            setCursor(result.nextCursor);
          })}
        >
          Earlier photographs
        </button>
      )}
    </section>
  );
}

function Single() {
  const { id } = useParams();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ post: Post }>(`/api/posts/${id}`)
      .then((result) => setPost(result.post))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Not available."));
  }, [id]);
  return (
    <section className="column">
      {error && <p className="error" role="alert">{error}</p>}
      {post && <PostCard post={post} eager onChange={(posts) => setPost(posts[0] ?? null)} />}
    </section>
  );
}

export function PostCard({ post, eager, onChange }: { post: Post; eager?: boolean; onChange?: (posts: Post[]) => void }) {
  const [local, setLocal] = useState(post);
  const [error, setError] = useState("");
  const [reporting, setReporting] = useState(false);
  useEffect(() => setLocal(post), [post]);
  async function toggleLike() {
    const next = !local.likedByMe;
    setLocal({ ...local, likedByMe: next, likeCount: local.likeCount + (next ? 1 : -1) });
    try {
      const result = await api<{ liked: boolean; likeCount: number }>(`/api/posts/${local.id}/like`, { method: next ? "POST" : "DELETE" });
      setLocal({ ...local, likedByMe: result.liked, likeCount: result.likeCount });
    } catch (caught) {
      setLocal(post);
      setError(caught instanceof Error ? caught.message : "Could not update the like.");
    }
  }
  async function remove() {
    if (!confirm("Remove this photograph?")) return;
    await api(`/api/posts/${local.id}`, { method: "DELETE" });
    onChange?.([]);
    location.assign("/");
  }
  return (
    <article className="post">
      <div className="post-head">
        <Link className="who" to={`/u/${local.author.username}`}>
          {local.author.avatarUrl ? <img className="avatar" src={local.author.avatarUrl} alt="" /> : <span className="avatar-fallback" aria-hidden="true">{local.author.username.slice(0, 1).toUpperCase()}</span>}
          <span>{local.author.username}</span>
        </Link>
        <details className="menu">
          <summary>Actions</summary>
          <div className="menu-panel">
            {local.mine ? <button type="button" onClick={() => void remove()}>Delete</button> : <button type="button" onClick={() => setReporting(true)}>Report</button>}
          </div>
        </details>
      </div>
      <figure className="figure">
        <img src={local.imageUrl} width={local.width} height={local.height} alt={local.title} loading={eager ? "eager" : "lazy"} />
      </figure>
      <h2 className="title">{local.title}</h2>
      {local.description && <p className="description">{local.description}</p>}
      <div className="post-meta">
        <button type="button" className="like" aria-pressed={local.likedByMe} onClick={() => void toggleLike()}>
          {local.likedByMe ? "Liked" : "Like"} · {local.likeCount}
        </button>
        <time dateTime={local.createdAt}>{formatDate(local.createdAt)}</time>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {reporting && <ReportForm targetType="post" targetId={local.id} onClose={() => setReporting(false)} />}
    </article>
  );
}

function Discover() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<{ id: string; username: string; bio: string; avatarUrl: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(() => {
      void api<{ users: typeof users }>(`/api/users?q=${encodeURIComponent(q)}`)
        .then((result) => setUsers(result.users))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [q]);
  return (
    <section className="column">
      <h1>Members</h1>
      <p className="lede">Find an approved member by username. Their photographs stay hidden until you follow each other.</p>
      <label>Search<input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Username" /></label>
      <ul className="stack">
        {users.map((user) => (
          <li key={user.id}>
            <Link to={`/u/${user.username}`}>{user.username}</Link>
            {user.bio && <span className="note"> — {user.bio}</span>}
          </li>
        ))}
      </ul>
      {loading && <p className="note">Looking.</p>}
      {!loading && users.length === 0 && <p className="note">No matching members.</p>}
    </section>
  );
}

function Profile() {
  const { username = "" } = useParams();
  const { user } = useAuth();
  const [profile, setProfile] = useState<{ id: string; username: string; bio: string; avatarUrl: string | null; relationship: string; canViewPosts: boolean } | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState("");
  const [reporting, setReporting] = useState(false);
  async function load() {
    const result = await api<{ profile: NonNullable<typeof profile>; posts: Post[] }>(`/api/users/${username}`);
    setProfile(result.profile);
    setPosts(result.posts);
  }
  useEffect(() => {
    load().catch((caught) => setError(caught instanceof Error ? caught.message : "Not available."));
  }, [username]);
  async function follow(method: "POST" | "DELETE") {
    if (!profile) return;
    const result = await api<{ relationship: string }>(`/api/users/${profile.username}/follow`, { method });
    setProfile({ ...profile, relationship: result.relationship, canViewPosts: result.relationship === "mutual" || profile.username === user?.username });
    await load();
  }
  return (
    <section className="wide">
      {error && <p className="error" role="alert">{error}</p>}
      {profile && (
        <>
          <div className="post-head">
            <div className="who">
              {profile.avatarUrl ? <img className="avatar" src={profile.avatarUrl} alt="" /> : <span className="avatar-fallback">{profile.username.slice(0, 1).toUpperCase()}</span>}
              <div>
                <h1>{profile.username}</h1>
                {profile.bio && <p>{profile.bio}</p>}
              </div>
            </div>
            {profile.relationship !== "self" && (
              <div className="row">
                <button type="button" onClick={() => void follow(profile.relationship === "none" ? "POST" : "DELETE")}>
                  {profile.relationship === "none" ? "Follow" : "Unfollow"}
                </button>
                <button type="button" className="secondary" onClick={() => setReporting(true)}>Report</button>
              </div>
            )}
          </div>
          {profile.relationship === "following" && <p className="note">You follow {profile.username}. Their photographs appear if they follow you too.</p>}
          {!profile.canViewPosts && profile.relationship !== "self" && <p>Photographs stay private until the follow is mutual.</p>}
          <div className="grid">
            {posts.map((post) => (
              <Link key={post.id} to={`/p/${post.id}`}>
                <img src={post.imageUrl} alt={post.title} width={post.width} height={post.height} loading="lazy" />
              </Link>
            ))}
          </div>
          {reporting && <ReportForm targetType="account" targetId={profile.id} onClose={() => setReporting(false)} />}
        </>
      )}
    </section>
  );
}

function Compose() {
  const navigate = useNavigate();
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ post: Post }>("/api/posts", { method: "POST", body: form });
      navigate(`/p/${result.post.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish.");
    }
  }
  return (
    <section className="column">
      <h1>Publish</h1>
      <p className="lede">One photograph, a title, and a short note.</p>
      <form className="stack" onSubmit={onSubmit}>
        <label>Photograph<input name="image" type="file" accept="image/jpeg,image/png,image/webp" required onChange={(event) => {
          const file = event.target.files?.[0];
          setPreview(file ? URL.createObjectURL(file) : "");
        }} /></label>
        {preview && <img src={preview} alt="Selected photograph preview" />}
        <label>Title<input name="title" required maxLength={100} /></label>
        <label>Description<textarea name="description" maxLength={300} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="submit">Publish</button>
          <button type="button" className="secondary" onClick={() => navigate(-1)}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

function Settings() {
  const { user, refresh, setUser } = useAuth();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  if (!user) return null;
  async function saveBio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const result = await api<{ user: Me }>("/api/me", { method: "PATCH", body: JSON.stringify({ bio: new FormData(event.currentTarget).get("bio") }) });
    setUser(result.user);
    setMessage("Profile saved.");
  }
  async function uploadAvatar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/me/avatar", { method: "POST", body: form });
    await refresh();
    setMessage("Portrait updated.");
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: form.get("current"), newPassword: form.get("next"), revokeOtherSessions: true }),
      });
      setMessage("Password changed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the password.");
    }
  }
  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirm("Delete your account and photographs?")) return;
    try {
      await api("/api/me", { method: "DELETE", body: JSON.stringify({ password: new FormData(event.currentTarget).get("password") }) });
      setUser(null);
      location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the account.");
    }
  }
  return (
    <section className="column stack">
      <h1>Settings</h1>
      <p>{user.email}</p>
      {message && <p role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <form className="stack" onSubmit={saveBio}>
        <label>Bio<textarea name="bio" maxLength={160} defaultValue={user.bio} /></label>
        <button type="submit">Save bio</button>
      </form>
      <form className="stack" onSubmit={uploadAvatar}>
        <label>Portrait<input name="image" type="file" accept="image/jpeg,image/png,image/webp" required /></label>
        <button type="submit">Update portrait</button>
      </form>
      <form className="stack" onSubmit={changePassword}>
        <h2>Password</h2>
        <label>Current<input name="current" type="password" required /></label>
        <label>New<input name="next" type="password" minLength={10} required /></label>
        <button type="submit">Change password</button>
      </form>
      <form className="stack" onSubmit={deleteAccount}>
        <h2>Delete account</h2>
        <p className="note">Photographs are removed. Moderation records remain, without your password.</p>
        <label>Password<input name="password" type="password" required /></label>
        <button type="submit">Delete account</button>
      </form>
      <button type="button" className="secondary" onClick={() => api("/api/auth/sign-out", { method: "POST" }).finally(() => location.assign("/login"))}>Sign out</button>
    </section>
  );
}

function ReportForm({ targetType, targetId, onClose }: { targetType: "post" | "account"; targetId: string; onClose: () => void }) {
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/reports", {
        method: "POST",
        body: JSON.stringify({ targetType, targetId, reason: form.get("reason"), explanation: form.get("explanation") }),
      });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the report.");
    }
  }
  return (
    <form className="stack" onSubmit={onSubmit}>
      <h2>Report</h2>
      {done ? <p role="status">Report sent.</p> : (
        <>
          <label>Reason
            <select name="reason" required>
              {REPORT_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
            </select>
          </label>
          <label>Explanation<textarea name="explanation" maxLength={500} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button type="submit">Submit report</button>
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </form>
  );
}
