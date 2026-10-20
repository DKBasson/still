import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeRemovedContent } from "../src/worker/purge";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct-horse-battery";
const JPEG = hex(
  "ffd8ffe000104a46494600010100000100010000ffc0000b080001000101011100ffc40014000100000000000000000000000000000009ffc40014100100000000000000000000000000000000ffda0008010100003f007fffd9",
);

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("privacy and moderation", () => {
  it("keeps unapproved members out and enforces mutual follow", async () => {
    const admin = await adminSession();
    const alice = await member("alice");
    const pendingFeed = await send(`/api/feed`, { cookie: alice.cookie });
    expect(pendingFeed.status).toBe(403);

    await approve(admin.cookie, alice.id);
    const aliceSession = await signIn("alice@still.test");
    const empty = await send("/api/feed", { cookie: aliceSession });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { posts: unknown[] }).posts).toEqual([]);

    const post = await publish(aliceSession, "North light");
    const own = await send(`/api/posts/${post.id}`, { cookie: aliceSession });
    expect(own.status).toBe(200);

    const bob = await member("bob");
    await approve(admin.cookie, bob.id);
    const bobSession = await signIn("bob@still.test");
    expect((await send(`/api/posts/${post.id}`, { cookie: bobSession })).status).toBe(404);
    expect((await send(`/api/media/posts/${post.id}`, { cookie: bobSession })).status).toBe(404);
    expect((await send(`/api/posts/${post.id}/like`, { method: "POST", cookie: bobSession })).status).toBe(404);

    await send(`/api/users/alice/follow`, { method: "POST", cookie: bobSession });
    expect((await send(`/api/posts/${post.id}`, { cookie: bobSession })).status).toBe(404);

    await send(`/api/users/bob/follow`, { method: "POST", cookie: aliceSession });
    const visible = await send(`/api/posts/${post.id}`, { cookie: bobSession });
    expect(visible.status).toBe(200);
    const image = await send(`/api/media/posts/${post.id}`, { cookie: bobSession });
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toContain("private");

    const liked = await send(`/api/posts/${post.id}/like`, { method: "POST", cookie: bobSession });
    expect(((await liked.json()) as { likeCount: number }).likeCount).toBe(1);
    const again = await send(`/api/posts/${post.id}/like`, { method: "POST", cookie: bobSession });
    expect(((await again.json()) as { likeCount: number }).likeCount).toBe(1);

    await send(`/api/users/alice/follow`, { method: "DELETE", cookie: bobSession });
    expect((await send(`/api/posts/${post.id}`, { cookie: bobSession })).status).toBe(404);
    expect((await send(`/api/media/posts/${post.id}`, { cookie: bobSession })).status).toBe(404);
    expect((await send(`/api/posts/${post.id}/like`, { method: "DELETE", cookie: bobSession })).status).toBe(404);
  });

  it("blocks ordinary members from the desk and protects roles", async () => {
    const admin = await adminSession();
    const alice = await member("ada");
    await approve(admin.cookie, alice.id);
    const session = await signIn("ada@still.test");
    expect((await send("/api/moderation/overview", { cookie: session })).status).toBe(403);
    const promoted = await send(`/api/moderation/users/${alice.id}/role`, {
      method: "POST",
      cookie: admin.cookie,
      body: { role: "moderator", reason: "Covers the evening desk." },
    });
    expect(promoted.status).toBe(200);
    const mod = await signIn("ada@still.test");
    const selfPromote = await send(`/api/moderation/users/${alice.id}/role`, {
      method: "POST",
      cookie: mod,
      body: { role: "admin", reason: "Should fail." },
    });
    expect(selfPromote.status).toBe(403);
  });

  it("suspends an account and revokes the session", async () => {
    const admin = await adminSession();
    const alice = await member("mina");
    await approve(admin.cookie, alice.id);
    const session = await signIn("mina@still.test");
    const suspended = await send(`/api/moderation/users/${alice.id}/suspend`, {
      method: "POST",
      cookie: admin.cookie,
      body: { days: 7, reason: "Reviewing a report." },
    });
    expect(suspended.status).toBe(200);
    expect((await send("/api/me", { cookie: session })).status).toBe(401);
    const retry = await signInRaw("mina@still.test");
    expect(retry.status).toBe(403);
  });

  it("removes a reported photograph from member access and keeps an audit row", async () => {
    const admin = await adminSession();
    const alice = await member("nora");
    const bob = await member("otto");
    await approve(admin.cookie, alice.id);
    await approve(admin.cookie, bob.id);
    const aliceSession = await signIn("nora@still.test");
    const bobSession = await signIn("otto@still.test");
    const post = await publish(aliceSession, "Window");
    await send("/api/users/otto/follow", { method: "POST", cookie: aliceSession });
    await send("/api/users/nora/follow", { method: "POST", cookie: bobSession });
    const report = await send("/api/reports", {
      method: "POST",
      cookie: bobSession,
      body: { targetType: "post", targetId: post.id, reason: "copyright", explanation: "This is my negative." },
    });
    expect(report.status).toBe(201);
    const reportId = ((await report.json()) as { id: string }).id;
    const removed = await send(`/api/moderation/posts/${post.id}/remove`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "Ownership was not established." },
    });
    expect(removed.status).toBe(200);
    expect((await send(`/api/posts/${post.id}`, { cookie: aliceSession })).status).toBe(404);
    expect((await send(`/api/media/posts/${post.id}`, { cookie: aliceSession })).status).toBe(404);
    const staffImage = await send(`/api/moderation/media/posts/${post.id}`, { cookie: admin.cookie });
    expect(staffImage.status).toBe(200);
    const closed = await send(`/api/moderation/reports/${reportId}/resolve`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "Photograph removed." },
    });
    expect(closed.status).toBe(200);
    const audit = await send("/api/moderation/audit", { cookie: admin.cookie });
    const entries = ((await audit.json()) as { entries: { action: string }[] }).entries;
    expect(entries.some((entry) => entry.action === "post.remove")).toBe(true);

    await env.DB.prepare("UPDATE posts SET removedAt = ? WHERE id = ?").bind("2000-01-01T00:00:00.000Z", post.id).run();
    expect(await purgeRemovedContent(env, Date.parse("2000-05-01T00:00:00.000Z"))).toBe(1);
    expect((await send(`/api/moderation/media/posts/${post.id}`, { cookie: admin.cookie })).status).toBe(404);
  });
});

async function adminSession() {
  const created = await send("/api/internal/bootstrap", {
    method: "POST",
    body: { email: "editor@still.test", username: "editor", password: PASSWORD },
    ip: "203.0.113.8",
    csrf: false,
    headers: { authorization: `Bearer ${env.BOOTSTRAP_TOKEN}` },
  });
  if (created.status !== 200 && created.status !== 409) {
    throw new Error(await created.text());
  }
  return { cookie: await signIn("editor@still.test", "203.0.113.8") };
}

async function member(username: string) {
  const email = `${username}@still.test`;
  const ip = `203.0.113.${username.length + 20}`;
  const signup = await send("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name: username, username },
    ip,
    csrf: false,
  });
  if (signup.status >= 400) throw new Error(await signup.text());
  const mailbox = await (await send(`/api/dev/mailbox?recipient=${encodeURIComponent(email)}`)).json() as { messages: { body: string }[] };
  const link = mailbox.messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("missing verification email");
  await SELF.fetch(link, { redirect: "manual" });
  const cookie = await signIn(email, ip);
  const me = await (await send("/api/me", { cookie })).json() as { user: { id: string } };
  return { id: me.user.id, cookie, email };
}

async function approve(cookie: string, id: string) {
  const response = await send(`/api/moderation/users/${id}/approve`, {
    method: "POST",
    cookie,
    body: { reason: "Portfolio looks sincere." },
  });
  if (response.status !== 200) throw new Error(await response.text());
}

async function signIn(email: string, ip = "203.0.113.50") {
  const response = await signInRaw(email, ip);
  if (response.status >= 400) throw new Error(await response.text());
  return cookieHeader(response);
}

async function signInRaw(email: string, ip = "203.0.113.50") {
  return send("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    ip,
    csrf: false,
  });
}

async function publish(cookie: string, title: string) {
  const body = new FormData();
  body.set("title", title);
  body.set("description", "A short note.");
  body.set("image", new File([JPEG], "frame.jpg", { type: "image/jpeg" }));
  const response = await SELF.fetch(`${ORIGIN}/api/posts`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "x-still-request": "1", "cf-connecting-ip": "203.0.113.60" },
    body,
  });
  if (response.status !== 201) throw new Error(await response.text());
  return ((await response.json()) as { post: { id: string } }).post;
}

async function send(path: string, options: { method?: string; cookie?: string; body?: unknown; ip?: string; csrf?: boolean; headers?: HeadersInit } = {}) {
  const headers = new Headers(options.headers);
  headers.set("cf-connecting-ip", options.ip ?? "203.0.113.10");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.method && options.method !== "GET") {
    headers.set("origin", ORIGIN);
    if (options.csrf !== false) headers.set("x-still-request", "1");
  }
  let body: BodyInit | undefined;
  if (options.body) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return SELF.fetch(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers, body });
}

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function hex(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
