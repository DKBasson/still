import { Hono, type Context } from "hono";
import { verifyPassword } from "better-auth/crypto";
import { createAuth } from "./auth";
import type { AppEnv, Env } from "./env";
import { ImageRejected, processImage } from "./images";
import { sendEmail } from "./mail";
import { purgeRemovedContent } from "./purge";
import {
  LIMITS,
  canAssignRole,
  canOpenReport,
  canTransition,
  cleanText,
  effectiveStatus,
  isAccountStatus,
  isReportReason,
  isRole,
  isStaff,
  likePattern,
  mailboxEnabled,
  type AccountStatus,
  type Role,
} from "../shared/domain";

type Actor = {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  bio: string;
  avatarKey: string | null;
  accountStatus: AccountStatus;
  role: Role;
  statusReason: string | null;
  suspendedUntil: string | null;
};

type PostRecord = {
  id: string;
  authorId: string;
  title: string;
  description: string;
  createdAt: string;
  width: number;
  height: number;
  contentType: string;
  imageKey: string;
  username: string;
  avatarKey: string | null;
  likeCount: number;
  likedByMe: number;
  removedAt: string | null;
};

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && c.env.DEV_MAILBOX === "1") {
    return c.text("The server is misconfigured.", 500);
  }
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  if (new URL(c.req.url).pathname.startsWith("/api/")) c.header("Cache-Control", "private, no-store");
});

app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/auth/") || path === "/api/internal/bootstrap") return next();
  if (c.req.header("x-still-request") !== "1" || c.req.header("origin") !== c.env.APP_ORIGIN) {
    return fail(c, 403, "csrf", "The request could not be verified.");
  }
  return next();
});

app.onError((error, c) => {
  console.error(error);
  return fail(c, 500, "server_error", "Something went wrong.");
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/internal/bootstrap", async (c) => {
  if (!c.env.BOOTSTRAP_TOKEN) return fail(c, 404, "not_found", "Not found.");
  const header = c.req.header("authorization") ?? "";
  if (!timingSafeEqual(header, `Bearer ${c.env.BOOTSTRAP_TOKEN}`)) return fail(c, 404, "not_found", "Not found.");
  const existing = await c.env.DB.prepare("SELECT id FROM \"user\" WHERE role = 'admin' LIMIT 1").first();
  if (existing) return fail(c, 409, "conflict", "An administrator already exists.");
  const body = await readJson(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(c, 400, "invalid", "Enter a valid email address.");
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail(c, 400, "invalid", "Usernames use 3 to 20 lowercase letters, numbers, or underscores.");
  if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) {
    return fail(c, 400, "invalid", "Use a password of at least 10 characters.");
  }
  try {
    await createAuth(c.env).api.signUpEmail({
      body: { email, password, name: username, username },
      headers: c.req.raw.headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create the administrator.";
    return fail(c, 400, "bootstrap_failed", message);
  }
  const now = new Date().toISOString();
  const updated = await c.env.DB.prepare(
    "UPDATE \"user\" SET emailVerified = 1, accountStatus = 'approved', role = 'admin', updatedAt = ? WHERE email = ?",
  )
    .bind(now, email)
    .run();
  if (!updated.meta.changes) return fail(c, 500, "bootstrap_failed", "The administrator record was not created.");
  const admin = await c.env.DB.prepare("SELECT id, username FROM \"user\" WHERE email = ?").bind(email).first<{ id: string; username: string }>();
  if (!admin) return fail(c, 500, "bootstrap_failed", "The administrator record was not created.");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(admin.id),
    auditStatement(c.env, { id: admin.id, username: admin.username }, "bootstrap.admin", "user", admin.id, null),
  ]);
  return c.json({ ok: true, username: admin.username });
});

app.all("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.get("/api/dev/mailbox", async (c) => {
  if (!mailboxEnabled(c.env)) return fail(c, 404, "not_found", "Not found.");
  const recipient = (c.req.query("recipient") ?? "").trim().toLowerCase();
  if (!recipient) return fail(c, 400, "invalid", "A recipient is required.");
  const rows = await c.env.DB.prepare(
    "SELECT subject, body, createdAt FROM dev_mailbox WHERE recipient = ? ORDER BY createdAt DESC LIMIT 10",
  )
    .bind(recipient)
    .all<{ subject: string; body: string; createdAt: string }>();
  return c.json({ messages: rows.results });
});

app.get("/api/me", async (c) => {
  const actor = await loadActor(c.env, c.req.raw.headers);
  if (!actor) return fail(c, 401, "unauthenticated", "Sign in to continue.");
  if (actor.accountStatus === "suspended" || actor.accountStatus === "banned") {
    await c.env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(actor.id).run();
    return fail(c, 403, `account_${actor.accountStatus}`, statusMessage(actor.accountStatus));
  }
  return c.json({ user: meJson(actor) });
});

app.patch("/api/me", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const body = await readJson(c);
  const bio = cleanText(body.bio, LIMITS.bio, { allowEmpty: true, multiline: true });
  if (bio === null) return fail(c, 400, "invalid", "The bio is too long.");
  if (!(await consumeRate(c.env, `profile:${actor.id}`, 30, 60 * 60 * 1000))) {
    return fail(c, 429, "rate_limited", "Try again later.");
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE \"user\" SET bio = ?, updatedAt = ? WHERE id = ?").bind(bio, now, actor.id).run();
  return c.json({ user: meJson({ ...actor, bio }) });
});

app.post("/api/me/avatar", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const body = await c.req.parseBody();
  const file = asFile(body.image);
  if (!file) return fail(c, 400, "invalid", "Choose an image.");
  let image;
  try {
    image = processImage(new Uint8Array(await file.arrayBuffer()), LIMITS.avatarBytes);
  } catch (error) {
    if (error instanceof ImageRejected) return fail(c, 400, "invalid_image", error.message);
    throw error;
  }
  const key = `avatars/${actor.id}`;
  await c.env.IMAGES.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  await c.env.DB.prepare("UPDATE \"user\" SET avatarKey = ?, updatedAt = ? WHERE id = ?")
    .bind(key, new Date().toISOString(), actor.id)
    .run();
  return c.json({ avatarUrl: `/api/media/avatars/${actor.id}` });
});

app.delete("/api/me/avatar", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  if (actor.avatarKey) await c.env.IMAGES.delete(actor.avatarKey);
  await c.env.DB.prepare("UPDATE \"user\" SET avatarKey = NULL, updatedAt = ? WHERE id = ?")
    .bind(new Date().toISOString(), actor.id)
    .run();
  return c.json({ avatarUrl: null });
});

app.delete("/api/me", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const body = await readJson(c);
  const password = typeof body.password === "string" ? body.password : "";
  const credential = await c.env.DB.prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'")
    .bind(actor.id)
    .first<{ password: string | null }>();
  if (!credential?.password || !(await verifyPassword({ hash: credential.password, password }))) {
    return fail(c, 400, "invalid", "The password is incorrect.");
  }
  if (actor.role === "admin") {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM \"user\" WHERE role = 'admin'").first<{ count: number }>();
    if ((admins?.count ?? 0) <= 1) return fail(c, 409, "last_admin", "Promote another administrator before deleting this account.");
  }
  const posts = await c.env.DB.prepare("SELECT imageKey FROM posts WHERE authorId = ?").bind(actor.id).all<{ imageKey: string }>();
  for (const post of posts.results) await c.env.IMAGES.delete(post.imageKey);
  if (actor.avatarKey) await c.env.IMAGES.delete(actor.avatarKey);
  await c.env.DB.batch([
    auditStatement(c.env, actor, "account.delete", "user", actor.id, null),
    c.env.DB.prepare("DELETE FROM \"user\" WHERE id = ?").bind(actor.id),
  ]);
  return c.json({ ok: true });
});

app.get("/api/users", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  if (q.length > LIMITS.usernameMax) return fail(c, 400, "invalid", "That search is too long.");
  const pattern = likePattern(q);
  const rows = await c.env.DB.prepare(
    `SELECT id, username, bio, avatarKey FROM "user"
     WHERE accountStatus = 'approved' AND id <> ? AND (? = '' OR username LIKE ? ESCAPE '\\')
     ORDER BY username ASC LIMIT 20`,
  )
    .bind(actor.id, q, pattern)
    .all<{ id: string; username: string; bio: string; avatarKey: string | null }>();
  return c.json({
    users: rows.results.map((user) => ({
      id: user.id,
      username: user.username,
      bio: user.bio,
      avatarUrl: user.avatarKey ? `/api/media/avatars/${user.id}` : null,
    })),
  });
});

app.get("/api/users/:username", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const username = c.req.param("username").toLowerCase();
  const user = await c.env.DB.prepare(
    "SELECT id, username, bio, avatarKey, accountStatus FROM \"user\" WHERE username = ?",
  )
    .bind(username)
    .first<{ id: string; username: string; bio: string; avatarKey: string | null; accountStatus: string }>();
  if (!user || !isAccountStatus(user.accountStatus)) return fail(c, 404, "not_found", "That member could not be found.");
  const self = user.id === actor.id;
  if (!self && user.accountStatus !== "approved") return fail(c, 404, "not_found", "That member could not be found.");
  const relation = self ? "self" : await relationship(c.env, actor.id, user.id);
  const canViewPosts = self || (relation === "mutual" && user.accountStatus === "approved");
  const cursor = decodeCursor(c.req.query("cursor"));
  const posts = canViewPosts ? await listPosts(c.env, actor.id, { authorId: user.id, cursor }) : { posts: [], nextCursor: null };
  return c.json({
    profile: {
      id: user.id,
      username: user.username,
      bio: user.bio,
      avatarUrl: user.avatarKey ? `/api/media/avatars/${user.id}` : null,
      relationship: relation,
      canViewPosts,
    },
    ...posts,
  });
});

app.post("/api/users/:username/follow", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  if (!(await consumeRate(c.env, `follow:${actor.id}`, 60, 60 * 60 * 1000))) return fail(c, 429, "rate_limited", "Try again later.");
  const target = await approvedByUsername(c.env, c.req.param("username"));
  if (!target) return fail(c, 404, "not_found", "That member could not be found.");
  if (target.id === actor.id) return fail(c, 400, "invalid", "You cannot follow yourself.");
  await c.env.DB.prepare("INSERT OR IGNORE INTO follows (followerId, followeeId, createdAt) VALUES (?, ?, ?)")
    .bind(actor.id, target.id, new Date().toISOString())
    .run();
  return c.json({ relationship: await relationship(c.env, actor.id, target.id) });
});

app.delete("/api/users/:username/follow", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const target = await approvedByUsername(c.env, c.req.param("username"));
  if (!target) return fail(c, 404, "not_found", "That member could not be found.");
  await c.env.DB.prepare("DELETE FROM follows WHERE followerId = ? AND followeeId = ?").bind(actor.id, target.id).run();
  return c.json({ relationship: await relationship(c.env, actor.id, target.id) });
});

app.get("/api/feed", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  return c.json(await listPosts(c.env, actor.id, { cursor: decodeCursor(c.req.query("cursor")) }));
});

app.post("/api/posts", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  if (!(await consumeRate(c.env, `upload:${actor.id}`, 20, 24 * 60 * 60 * 1000))) {
    return fail(c, 429, "rate_limited", "You have published enough photographs for today.");
  }
  const body = await c.req.parseBody();
  const title = cleanText(body.title, LIMITS.title, { allowEmpty: false, multiline: false });
  const description = cleanText(typeof body.description === "string" ? body.description : "", LIMITS.description, {
    allowEmpty: true,
    multiline: true,
  });
  if (!title) return fail(c, 400, "invalid", "Add a title of 100 characters or fewer.");
  if (description === null) return fail(c, 400, "invalid", "The description is too long.");
  const file = asFile(body.image);
  if (!file) return fail(c, 400, "invalid", "Choose one photograph.");
  let image;
  try {
    image = processImage(new Uint8Array(await file.arrayBuffer()), LIMITS.imageBytes);
  } catch (error) {
    if (error instanceof ImageRejected) return fail(c, 400, "invalid_image", error.message);
    throw error;
  }
  const id = crypto.randomUUID();
  const key = `posts/${id}`;
  const createdAt = new Date().toISOString();
  await c.env.IMAGES.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO posts (id, authorId, title, description, imageKey, contentType, byteSize, width, height, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, actor.id, title, description, key, image.contentType, image.bytes.byteLength, image.width, image.height, createdAt)
      .run();
  } catch (error) {
    await c.env.IMAGES.delete(key);
    throw error;
  }
  const listed = await listPosts(c.env, actor.id, { postId: id });
  return c.json({ post: listed.posts[0] }, 201);
});

app.get("/api/posts/:id", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const listed = await listPosts(c.env, actor.id, { postId: c.req.param("id") });
  if (!listed.posts[0]) return fail(c, 404, "not_found", "That photograph could not be found.");
  return c.json({ post: listed.posts[0] });
});

app.delete("/api/posts/:id", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const post = await c.env.DB.prepare("SELECT id, authorId, imageKey, removedAt FROM posts WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; authorId: string; imageKey: string; removedAt: string | null }>();
  if (!post || post.removedAt || post.authorId !== actor.id) return fail(c, 404, "not_found", "That photograph could not be found.");
  const open = await c.env.DB.prepare(
    "SELECT id FROM reports WHERE targetPostId = ? AND status IN ('pending', 'under_review') LIMIT 1",
  )
    .bind(post.id)
    .first();
  if (open) {
    await c.env.DB.prepare(
      "UPDATE posts SET removedAt = ?, removedBy = ?, removalReason = ?, removalKind = 'user' WHERE id = ?",
    )
      .bind(new Date().toISOString(), actor.id, "Removed by the author while a report was open.", post.id)
      .run();
  } else {
    await c.env.IMAGES.delete(post.imageKey);
    await c.env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(post.id).run();
  }
  return c.json({ ok: true });
});

app.post("/api/posts/:id/like", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  return likeChange(c, actor, true);
});

app.delete("/api/posts/:id/like", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  return likeChange(c, actor, false);
});

app.get("/api/media/posts/:id", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const post = await visiblePost(c.env, actor.id, c.req.param("id"));
  if (!post) return fail(c, 404, "not_found", "That photograph could not be found.");
  return streamImage(c.env, post.imageKey, post.contentType);
});

app.get("/api/media/avatars/:id", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  const user = await c.env.DB.prepare("SELECT id, avatarKey, accountStatus FROM \"user\" WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; avatarKey: string | null; accountStatus: string }>();
  if (!user?.avatarKey) return fail(c, 404, "not_found", "That portrait could not be found.");
  if (user.id !== actor.id && user.accountStatus !== "approved") return fail(c, 404, "not_found", "That portrait could not be found.");
  const object = await c.env.IMAGES.get(user.avatarKey);
  if (!object) return fail(c, 404, "not_found", "That portrait could not be found.");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

app.post("/api/reports", async (c) => {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  if (!(await consumeRate(c.env, `report:${actor.id}`, 10, 24 * 60 * 60 * 1000))) {
    return fail(c, 429, "rate_limited", "You have sent enough reports for today.");
  }
  const body = await readJson(c);
  if (body.targetType !== "post" && body.targetType !== "account") return fail(c, 400, "invalid", "Choose a photograph or a member.");
  if (typeof body.reason !== "string" || !isReportReason(body.reason)) return fail(c, 400, "invalid", "Choose a reason.");
  const explanation = cleanText(typeof body.explanation === "string" ? body.explanation : "", LIMITS.explanation, {
    allowEmpty: true,
    multiline: true,
  });
  if (explanation === null) return fail(c, 400, "invalid", "The explanation is too long.");
  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  let targetPostId: string | null = null;
  let targetUserId: string | null = null;
  if (body.targetType === "post") {
    const post = await visiblePost(c.env, actor.id, targetId);
    if (!post || post.authorId === actor.id) return fail(c, 404, "not_found", "That photograph could not be found.");
    targetPostId = post.id;
    targetUserId = post.authorId;
  } else {
    const user = await c.env.DB.prepare("SELECT id FROM \"user\" WHERE id = ? AND accountStatus = 'approved'")
      .bind(targetId)
      .first<{ id: string }>();
    if (!user || user.id === actor.id) return fail(c, 404, "not_found", "That member could not be found.");
    targetUserId = user.id;
  }
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM reports
     WHERE reporterId = ? AND status IN ('pending', 'under_review')
       AND ((? = 'post' AND targetPostId = ?) OR (? = 'account' AND targetUserId = ? AND targetType = 'account'))
     LIMIT 1`,
  )
    .bind(actor.id, body.targetType, targetPostId, body.targetType, targetUserId)
    .first();
  if (duplicate) return fail(c, 409, "duplicate", "You already have an open report for this.");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO reports (id, reporterId, targetType, targetPostId, targetUserId, reason, explanation, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(id, actor.id, body.targetType, targetPostId, targetUserId, body.reason, explanation || null, now, now)
    .run();
  return c.json({ id }, 201);
});

app.get("/api/moderation/overview", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const row = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM "user") AS registered,
      (SELECT COUNT(*) FROM "user" WHERE accountStatus = 'pending') AS pending,
      (SELECT COUNT(*) FROM "user" WHERE accountStatus = 'approved') AS approved,
      (SELECT COUNT(*) FROM "user" WHERE accountStatus = 'suspended') AS suspended,
      (SELECT COUNT(*) FROM "user" WHERE accountStatus = 'banned') AS banned,
      (SELECT COUNT(*) FROM posts WHERE removedAt IS NULL) AS posts,
      (SELECT COUNT(*) FROM reports WHERE status = 'pending') AS reportsPending,
      (SELECT COUNT(*) FROM reports WHERE status = 'under_review') AS reportsReview,
      (SELECT COUNT(*) FROM reports WHERE status IN ('resolved', 'dismissed')) AS reportsClosed`,
  ).first();
  return c.json({ overview: row });
});

app.get("/api/moderation/registrations", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const status = c.req.query("status") ?? "pending";
  if (status !== "all" && !isAccountStatus(status)) return fail(c, 400, "invalid", "Unknown status.");
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 80);
  const rows = await c.env.DB.prepare(
    `SELECT id, username, email, emailVerified, accountStatus, createdAt, statusReason
     FROM "user"
     WHERE (? = 'all' OR accountStatus = ?)
       AND (? = '' OR username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
     ORDER BY createdAt DESC LIMIT 50`,
  )
    .bind(status, status, q, likePattern(q), likePattern(q))
    .all();
  return c.json({ registrations: rows.results });
});

app.post("/api/moderation/users/:id/approve", (c) => moderateStatus(c, "approved"));
app.post("/api/moderation/users/:id/reject", (c) => moderateStatus(c, "rejected"));
app.post("/api/moderation/users/:id/suspend", (c) => moderateStatus(c, "suspended"));
app.post("/api/moderation/users/:id/reinstate", (c) => moderateStatus(c, "approved"));
app.post("/api/moderation/users/:id/ban", (c) => moderateStatus(c, "banned"));

app.post("/api/moderation/users/:id/role", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  if (!canAssignRole(actor.role, "admin") && actor.role !== "admin") return fail(c, 403, "forbidden", "Only an administrator can change roles.");
  const body = await readJson(c);
  if (typeof body.role !== "string" || !isRole(body.role) || !canAssignRole(actor.role, body.role)) {
    return fail(c, 403, "forbidden", "Only an administrator can change roles.");
  }
  const reason = requiredReason(body.reason);
  if (!reason) return fail(c, 400, "invalid", "Record a reason for this decision.");
  const target = await userById(c.env, c.req.param("id"));
  if (!target) return fail(c, 404, "not_found", "That account could not be found.");
  if (target.id === actor.id) return fail(c, 400, "invalid", "You cannot change your own role.");
  if (target.role === "admin" && body.role !== "admin") {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM \"user\" WHERE role = 'admin'").first<{ count: number }>();
    if ((admins?.count ?? 0) <= 1) return fail(c, 409, "last_admin", "The last administrator cannot be demoted.");
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE \"user\" SET role = ?, updatedAt = ? WHERE id = ?").bind(body.role, now, target.id),
    auditStatement(c.env, actor, "role.assign", "user", target.id, reason),
  ]);
  return c.json({ ok: true, role: body.role });
});

app.get("/api/moderation/users/:id", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const user = await c.env.DB.prepare(
    `SELECT id, username, email, emailVerified, accountStatus, role, bio, createdAt, statusReason, suspendedUntil,
      (SELECT COUNT(*) FROM posts WHERE authorId = "user".id AND removedAt IS NULL) AS postCount
     FROM "user" WHERE id = ?`,
  )
    .bind(c.req.param("id"))
    .first();
  if (!user) return fail(c, 404, "not_found", "That account could not be found.");
  const history = await c.env.DB.prepare(
    "SELECT id, actorLabel, action, reason, createdAt FROM audit_log WHERE targetId = ? ORDER BY createdAt DESC LIMIT 30",
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ user, history: history.results });
});

app.get("/api/moderation/users", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 80);
  if (!q) return c.json({ users: [] });
  const rows = await c.env.DB.prepare(
    `SELECT id, username, email, accountStatus, role, createdAt,
      (SELECT COUNT(*) FROM posts WHERE authorId = "user".id AND removedAt IS NULL) AS postCount
     FROM "user"
     WHERE username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR id = ?
     ORDER BY username ASC LIMIT 20`,
  )
    .bind(likePattern(q), likePattern(q), q)
    .all();
  return c.json({ users: rows.results });
});

app.get("/api/moderation/reports", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const status = c.req.query("status") ?? "pending";
  if (status !== "all" && status !== "pending" && status !== "under_review" && status !== "resolved" && status !== "dismissed") {
    return fail(c, 400, "invalid", "Unknown status.");
  }
  const rows = await c.env.DB.prepare(
    `SELECT reports.id, reports.targetType, reports.reason, reports.status, reports.createdAt, reports.explanation,
        reporter.username AS reporterUsername, target.username AS targetUsername
     FROM reports
     LEFT JOIN "user" reporter ON reporter.id = reports.reporterId
     LEFT JOIN "user" target ON target.id = reports.targetUserId
     WHERE (? = 'all' OR reports.status = ?)
     ORDER BY reports.createdAt DESC LIMIT 50`,
  )
    .bind(status, status)
    .all();
  return c.json({ reports: rows.results });
});

app.get("/api/moderation/reports/:id", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const report = await c.env.DB.prepare(
    `SELECT reports.*, reporter.username AS reporterUsername, target.username AS targetUsername,
        posts.title AS postTitle, posts.description AS postDescription, posts.createdAt AS postCreatedAt,
        posts.removedAt AS postRemovedAt, posts.authorId AS postAuthorId, author.username AS postAuthorUsername
     FROM reports
     LEFT JOIN "user" reporter ON reporter.id = reports.reporterId
     LEFT JOIN "user" target ON target.id = reports.targetUserId
     LEFT JOIN posts ON posts.id = reports.targetPostId
     LEFT JOIN "user" author ON author.id = posts.authorId
     WHERE reports.id = ?`,
  )
    .bind(c.req.param("id"))
    .first<Record<string, unknown>>();
  if (!report) return fail(c, 404, "not_found", "That report could not be found.");
  await c.env.DB.prepare("INSERT INTO audit_log (id, actorId, actorLabel, action, targetType, targetId, reason, createdAt) VALUES (?, ?, ?, 'moderation.view_report', 'report', ?, NULL, ?)")
    .bind(crypto.randomUUID(), actor.id, actor.username, String(report.id), new Date().toISOString())
    .run();
  const imageUrl = report.targetPostId ? `/api/moderation/media/posts/${String(report.targetPostId)}` : null;
  return c.json({ report: { ...report, imageUrl } });
});

app.post("/api/moderation/reports/:id/review", (c) => closeReport(c, "under_review"));
app.post("/api/moderation/reports/:id/resolve", (c) => closeReport(c, "resolved"));
app.post("/api/moderation/reports/:id/dismiss", (c) => closeReport(c, "dismissed"));

app.post("/api/moderation/posts/:id/remove", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const body = await readJson(c);
  const reason = requiredReason(body.reason);
  if (!reason) return fail(c, 400, "invalid", "Record a reason for this decision.");
  const post = await c.env.DB.prepare("SELECT id, removedAt FROM posts WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; removedAt: string | null }>();
  if (!post || post.removedAt) return fail(c, 404, "not_found", "That photograph could not be found.");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE posts SET removedAt = ?, removedBy = ?, removalReason = ?, removalKind = 'moderation' WHERE id = ?").bind(
      now,
      actor.id,
      reason,
      post.id,
    ),
    auditStatement(c.env, actor, "post.remove", "post", post.id, reason),
  ]);
  return c.json({ ok: true });
});

app.get("/api/moderation/media/posts/:id", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const post = await c.env.DB.prepare(
    `SELECT posts.imageKey, posts.contentType FROM posts
     WHERE posts.id = ? AND (
       posts.removedAt IS NOT NULL OR EXISTS (SELECT 1 FROM reports WHERE targetPostId = posts.id)
     )`,
  )
    .bind(c.req.param("id"))
    .first<{ imageKey: string; contentType: string }>();
  if (!post) return fail(c, 404, "not_found", "That photograph could not be found.");
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actorId, actorLabel, action, targetType, targetId, reason, createdAt) VALUES (?, ?, ?, 'moderation.view_media', 'post', ?, NULL, ?)",
  )
    .bind(crypto.randomUUID(), actor.id, actor.username, c.req.param("id"), new Date().toISOString())
    .run();
  return streamImage(c.env, post.imageKey, post.contentType);
});

app.get("/api/moderation/audit", async (c) => {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const mine = actor.role === "moderator";
  const rows = await c.env.DB.prepare(
    `SELECT id, actorLabel, action, targetType, targetId, reason, createdAt
     FROM audit_log
     WHERE (? = 0 OR actorId = ?)
     ORDER BY createdAt DESC LIMIT 100`,
  )
    .bind(mine ? 1 : 0, actor.id)
    .all();
  return c.json({ entries: rows.results });
});

app.all("*", async (c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) return fail(c, 404, "not_found", "Not found.");
  return c.env.ASSETS.fetch(c.req.raw);
});

export { app, purgeRemovedContent };

async function moderateStatus(c: Context<AppEnv>, to: AccountStatus) {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const action = new URL(c.req.url).pathname.split("/").pop() ?? "";
  const body = await readJson(c);
  const reason = action === "approve" ? optionalReason(body.reason) : requiredReason(body.reason);
  if (reason === null) return fail(c, 400, "invalid", "Record a reason for this decision.");
  const targetId = c.req.param("id");
  if (!targetId) return fail(c, 400, "invalid", "Missing account.");
  const target = await userById(c.env, targetId);
  if (!target || !isAccountStatus(target.accountStatus) || !isRole(target.role)) return fail(c, 404, "not_found", "That account could not be found.");
  if (target.id === actor.id) return fail(c, 400, "invalid", "You cannot change your own account status.");
  const from = effectiveStatus(target.accountStatus, target.suspendedUntil);
  if (action === "reinstate" && from !== "suspended" && from !== "banned") {
    return fail(c, 400, "invalid", "That account is not suspended or banned.");
  }
  if (action === "approve" && from !== "pending" && from !== "rejected") {
    return fail(c, 400, "invalid", "That registration is not waiting for a decision.");
  }
  if (!canTransition(actor.role, from, to)) return fail(c, 403, "forbidden", "You cannot make that change.");
  if (to === "approved" && !target.emailVerified) return fail(c, 409, "email_unverified", "The email address has not been verified.");
  let suspendedUntil: string | null = null;
  if (to === "suspended") {
    const days = body.days;
    if (days !== null && days !== 1 && days !== 7 && days !== 30) return fail(c, 400, "invalid", "Choose 1, 7, or 30 days, or an indefinite suspension.");
    if (typeof days === "number") suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(
      "UPDATE \"user\" SET accountStatus = ?, statusReason = ?, suspendedUntil = ?, updatedAt = ? WHERE id = ?",
    ).bind(to, reason, suspendedUntil, now, target.id),
    auditStatement(c.env, actor, `account.${action}`, "user", target.id, reason),
  ];
  if (to === "suspended" || to === "banned" || to === "rejected") {
    statements.push(c.env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(target.id));
  }
  await c.env.DB.batch(statements);
  if (to === "approved" || to === "rejected") {
    await sendEmail(c.env, {
      to: target.email,
      subject: to === "approved" ? "Your still account is approved" : "Your still registration was not approved",
      text:
        to === "approved"
          ? `You can sign in as ${target.username}.`
          : `The registration for ${target.username} was not approved.${reason ? ` Reason: ${reason}` : ""}`,
    });
  }
  return c.json({ ok: true, accountStatus: to });
}

async function closeReport(c: Context<AppEnv>, to: "under_review" | "resolved" | "dismissed") {
  const actor = await requireStaff(c);
  if (actor instanceof Response) return actor;
  const body = await readJson(c);
  const reason = to === "under_review" ? optionalReason(body.reason) : requiredReason(body.reason);
  if (reason === null) return fail(c, 400, "invalid", "Record a reason for this decision.");
  const report = await c.env.DB.prepare("SELECT id, status FROM reports WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; status: string }>();
  if (!report) return fail(c, 404, "not_found", "That report could not be found.");
  if (report.status !== "pending" && report.status !== "under_review" && report.status !== "resolved" && report.status !== "dismissed") {
    return fail(c, 400, "invalid", "That report cannot be updated.");
  }
  if (!canOpenReport(report.status, to)) return fail(c, 400, "invalid", "That report has already been closed.");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE reports SET status = ?, assignedTo = ?, resolutionReason = ?, updatedAt = ?, resolvedAt = ? WHERE id = ?",
    ).bind(to, actor.id, reason, now, to === "under_review" ? null : now, report.id),
    auditStatement(c.env, actor, `report.${to}`, "report", report.id, reason),
  ]);
  return c.json({ ok: true, status: to });
}

async function likeChange(c: Context<AppEnv>, actor: Actor, like: boolean) {
  const postId = c.req.param("id");
  if (!postId) return fail(c, 400, "invalid", "Missing photograph.");
  const post = await visiblePost(c.env, actor.id, postId);
  if (!post) return fail(c, 404, "not_found", "That photograph could not be found.");
  if (like) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO likes (userId, postId, createdAt) VALUES (?, ?, ?)")
      .bind(actor.id, post.id, new Date().toISOString())
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM likes WHERE userId = ? AND postId = ?").bind(actor.id, post.id).run();
  }
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM likes WHERE postId = ?").bind(post.id).first<{ count: number }>();
  return c.json({ liked: like, likeCount: count?.count ?? 0 });
}

async function listPosts(env: Env, viewerId: string, filter: { authorId?: string; postId?: string; cursor?: { createdAt: string; id: string } | null }) {
  const cursor = filter.cursor;
  const rows = await env.DB.prepare(
    `SELECT posts.id, posts.authorId, posts.title, posts.description, posts.createdAt, posts.width, posts.height,
        posts.contentType, posts.imageKey, posts.removedAt, "user".username, "user".avatarKey,
        (SELECT COUNT(*) FROM likes WHERE likes.postId = posts.id) AS likeCount,
        EXISTS(SELECT 1 FROM likes WHERE likes.postId = posts.id AND likes.userId = ?) AS likedByMe
     FROM posts
     JOIN "user" ON "user".id = posts.authorId
     WHERE posts.removedAt IS NULL
       AND (? IS NULL OR posts.authorId = ?)
       AND (? IS NULL OR posts.id = ?)
       AND (
         posts.authorId = ?
         OR (
           "user".accountStatus = 'approved'
           AND EXISTS (
             SELECT 1 FROM follows outbound
             JOIN follows inbound
               ON inbound.followerId = outbound.followeeId
              AND inbound.followeeId = outbound.followerId
             WHERE outbound.followerId = ? AND outbound.followeeId = posts.authorId
           )
         )
       )
       AND (? IS NULL OR posts.createdAt < ? OR (posts.createdAt = ? AND posts.id < ?))
     ORDER BY posts.createdAt DESC, posts.id DESC
     LIMIT ?`,
  )
    .bind(
      viewerId,
      filter.authorId ?? null,
      filter.authorId ?? null,
      filter.postId ?? null,
      filter.postId ?? null,
      viewerId,
      viewerId,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      filter.postId ? 1 : LIMITS.feedPage + 1,
    )
    .all<PostRecord>();
  const page = filter.postId ? rows.results : rows.results.slice(0, LIMITS.feedPage);
  const last = page[page.length - 1];
  return {
    posts: page.map((post) => ({
      id: post.id,
      title: post.title,
      description: post.description,
      createdAt: post.createdAt,
      width: post.width,
      height: post.height,
      likeCount: Number(post.likeCount),
      likedByMe: Number(post.likedByMe) === 1,
      imageUrl: `/api/media/posts/${post.id}`,
      mine: post.authorId === viewerId,
      author: {
        id: post.authorId,
        username: post.username,
        avatarUrl: post.avatarKey ? `/api/media/avatars/${post.authorId}` : null,
      },
    })),
    nextCursor: !filter.postId && rows.results.length > LIMITS.feedPage && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

async function visiblePost(env: Env, viewerId: string, postId: string) {
  const listed = await listPosts(env, viewerId, { postId });
  if (!listed.posts[0]) return null;
  return env.DB.prepare("SELECT id, authorId, imageKey, contentType FROM posts WHERE id = ? AND removedAt IS NULL")
    .bind(listed.posts[0].id)
    .first<{ id: string; authorId: string; imageKey: string; contentType: string }>();
}

async function streamImage(env: Env, key: string, contentType: string) {
  const object = await env.IMAGES.get(key);
  if (!object) return new Response(JSON.stringify({ error: { code: "not_found", message: "That photograph could not be found." } }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function relationship(env: Env, viewerId: string, otherId: string) {
  const row = await env.DB.prepare(
    `SELECT
      EXISTS(SELECT 1 FROM follows WHERE followerId = ? AND followeeId = ?) AS following,
      EXISTS(SELECT 1 FROM follows WHERE followerId = ? AND followeeId = ?) AS followsYou`,
  )
    .bind(viewerId, otherId, otherId, viewerId)
    .first<{ following: number; followsYou: number }>();
  if (Number(row?.following) === 1 && Number(row?.followsYou) === 1) return "mutual" as const;
  if (Number(row?.following) === 1) return "following" as const;
  return "none" as const;
}

async function approvedByUsername(env: Env, username: string) {
  return env.DB.prepare("SELECT id FROM \"user\" WHERE username = ? AND accountStatus = 'approved'")
    .bind(username.toLowerCase())
    .first<{ id: string }>();
}

async function userById(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT id, email, username, emailVerified, accountStatus, role, suspendedUntil FROM \"user\" WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      email: string;
      username: string;
      emailVerified: number;
      accountStatus: string;
      role: string;
      suspendedUntil: string | null;
    }>();
}

async function loadActor(env: Env, headers: Headers): Promise<Actor | null> {
  const session = await createAuth(env).api.getSession({ headers });
  if (!session?.user) return null;
  const row = await env.DB.prepare(
    `SELECT id, email, emailVerified, username, bio, avatarKey, accountStatus, role, statusReason, suspendedUntil
     FROM "user" WHERE id = ?`,
  )
    .bind(session.user.id)
    .first<{
      id: string;
      email: string;
      emailVerified: number;
      username: string;
      bio: string;
      avatarKey: string | null;
      accountStatus: string;
      role: string;
      statusReason: string | null;
      suspendedUntil: string | null;
    }>();
  if (!row || !isAccountStatus(row.accountStatus) || !isRole(row.role)) return null;
  let status = effectiveStatus(row.accountStatus, row.suspendedUntil);
  if (status === "approved" && row.accountStatus === "suspended") {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE \"user\" SET accountStatus = 'approved', suspendedUntil = NULL, statusReason = NULL, updatedAt = ? WHERE id = ?").bind(
        now,
        row.id,
      ),
      auditStatement(env, null, "account.suspension_expired", "user", row.id, null),
    ]);
    status = "approved";
    row.statusReason = null;
    row.suspendedUntil = null;
  }
  return {
    ...row,
    emailVerified: row.emailVerified === 1,
    accountStatus: status,
    role: row.role,
  };
}

async function requireApproved(c: Context<AppEnv>) {
  const actor = await loadActor(c.env, c.req.raw.headers);
  if (!actor) return fail(c, 401, "unauthenticated", "Sign in to continue.");
  if (actor.accountStatus === "suspended" || actor.accountStatus === "banned") {
    await c.env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(actor.id).run();
    return fail(c, 403, `account_${actor.accountStatus}`, statusMessage(actor.accountStatus));
  }
  if (actor.accountStatus !== "approved") return fail(c, 403, `account_${actor.accountStatus}`, statusMessage(actor.accountStatus));
  return actor;
}

async function requireStaff(c: Context<AppEnv>) {
  const actor = await requireApproved(c);
  if (actor instanceof Response) return actor;
  if (!isStaff(actor.role)) return fail(c, 403, "forbidden", "This area is for editors.");
  return actor;
}

function meJson(actor: Actor) {
  return {
    id: actor.id,
    email: actor.email,
    emailVerified: actor.emailVerified,
    username: actor.username,
    bio: actor.bio,
    avatarUrl: actor.avatarKey ? `/api/media/avatars/${actor.id}` : null,
    accountStatus: actor.accountStatus,
    role: actor.role,
    statusReason: actor.statusReason,
    suspendedUntil: actor.suspendedUntil,
  };
}

function statusMessage(status: AccountStatus) {
  if (status === "pending") return "An editor is still reviewing your registration.";
  if (status === "rejected") return "This registration was not approved.";
  if (status === "suspended") return "This account is suspended.";
  if (status === "banned") return "This account is banned.";
  return "Sign in to continue.";
}

function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function asFile(value: unknown): File | null {
  return typeof File !== "undefined" && value instanceof File && value.size > 0 ? value : null;
}

function requiredReason(value: unknown) {
  return cleanText(value, LIMITS.reason, { allowEmpty: false, multiline: true });
}

function optionalReason(value: unknown) {
  if (value == null || value === "") return "";
  return cleanText(value, LIMITS.reason, { allowEmpty: true, multiline: true });
}

function auditStatement(env: Env, actor: { id: string; username: string } | null, action: string, targetType: string, targetId: string, reason: string | null) {
  return env.DB.prepare(
    "INSERT INTO audit_log (id, actorId, actorLabel, action, targetType, targetId, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), actor?.id ?? null, actor?.username ?? "system", action, targetType, targetId, reason, new Date().toISOString());
}

async function consumeRate(env: Env, key: string, limit: number, windowMs: number) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO app_rate_limit (key, windowStart, count) VALUES (?, ?, 1)
     ON CONFLICT(key, windowStart) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

function encodeCursor(createdAt: string, id: string) {
  return btoa(`${createdAt}|${id}`);
}

function decodeCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const decoded = atob(value);
    const split = decoded.lastIndexOf("|");
    if (split <= 0) return null;
    const createdAt = decoded.slice(0, split);
    const id = decoded.slice(split + 1);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt) || !/^[A-Za-z0-9-]+$/.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function timingSafeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}
