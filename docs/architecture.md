# Architecture

still is one Cloudflare Worker. It serves the React application as static assets and handles `/api/*` with Hono. `run_worker_first` includes `/api/*` so a browser navigation, such as an email verification link, reaches the Worker instead of the single-page fallback. D1 holds accounts, follows, posts, likes, reports, and the audit log. R2 holds image bytes in a private bucket named by the `IMAGES` binding.

```text
Browser  →  Worker (Hono + Better Auth)
              ├─ D1   users, follows, posts, likes, reports, audit
              └─ R2   private JPEG, PNG, and WebP objects
```

Business rules that must stay consistent live in `src/shared/domain.ts`: account transitions, roles, report reasons, and text limits. Authorisation for photographs is `listPosts` and `visiblePost` in `src/worker/app.ts`. Those functions are the only path that returns another member's post to an ordinary session.

## Account status

| From | To | Who |
| --- | --- | --- |
| pending | approved, rejected | moderator or admin, and only after the email is verified |
| rejected | approved | moderator or admin |
| approved | suspended, banned | moderator or admin |
| suspended | approved, banned | moderator or admin |
| banned | approved | admin only |
| any | pending | nobody |

A timed suspension stores `suspendedUntil`. The next successful session check, or a read of the account, treats an expired suspension as approved and writes that back. A ban does not expire. Users cannot change `accountStatus` or `role`. The last administrator cannot be demoted or deleted.

Pending and rejected accounts may hold a session that can read `GET /api/me` and the waiting-room pages. They cannot read the feed, profiles, posts, images, likes, or uploads. Suspended and banned accounts cannot create a session. Changing an account to suspended, banned, or rejected deletes its sessions immediately.

## Roles

| Action | user | moderator | admin |
| --- | --- | --- | --- |
| Use the social app | yes, if approved | yes, if approved | yes, if approved |
| Review registrations, reports, remove a post, suspend, ban, reinstate a suspension | no | yes | yes |
| Reinstate a ban | no | no | yes |
| Assign roles | no | no | yes, and not their own role |
| Read the full audit log | no | only their own rows | yes |

Staff routes require an approved account whose role is `moderator` or `admin`. The role column in D1 is the authority. Client-supplied role values are ignored except on the admin-only role route, which checks the actor again.

## Mutual follow

A viewer sees another member's posts, images, and likes only when both follow rows exist, the author is approved, and the post is not removed. The viewer always sees their own posts. One-way follows, missing follows, and unfollows return 404 on the next request so the response does not confirm that a private post exists. Discovery search returns approved usernames, bios, and portraits only.

## Images

Uploads accept one JPEG, PNG, or WebP up to 10 MB (portraits 2 MB). The worker checks the file signature, reads dimensions, and strips JPEG metadata segments, non-essential PNG chunks, and WebP EXIF/XMP. It does not decode pixels. Animated WebP is rejected. Objects use opaque keys (`posts/{id}`, `avatars/{id}`).

Delivery is `GET /api/media/posts/:id` and `GET /api/media/avatars/:id`. Both require a session and the same visibility rules as the post API, then stream the object with `Cache-Control: private, no-store`. There are no signed URLs. Ending a follow removes access on the next request, including a URL someone already copied.

Editors can open a reported or already-removed photograph through `GET /api/moderation/media/posts/:id`. That read is written to the audit log. It is not available for ordinary posts that have no report.

## Posts, likes, reports

Each post has one image, a title of at most 100 characters, and a description of at most 300. The feed is `createdAt` then `id`, newest first, 12 per page, with an opaque cursor.

Likes are unique on `(userId, postId)`. A second like is ignored. The response is a count, not a list of people. Liking a post the viewer cannot see returns 404.

Reports use a fixed reason list plus an optional explanation. A second open report from the same person on the same target returns 409. Members are limited to 10 reports a day.

## Deletion and retention

An author delete removes the database row and the R2 object, unless a report is still open. An open report turns the author's delete into a soft removal so the evidence remains. An editor removal always soft-deletes (`removalKind = moderation`) and keeps the object. A daily cron deletes R2 objects and rows whose `removedAt` is older than 90 days.

Account deletion checks the password, deletes that member's images, then deletes the user. Audit rows keep `actorLabel` and set `actorId` to null. Audit rows cannot be updated or deleted: SQL triggers abort those statements.

## Authentication

Better Auth stores users, sessions, credentials, and verification tokens in D1. Email verification is required before an editor can approve the account. Password reset revokes sessions. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. The session cookie is not cached; every protected request reads the account status from D1.

Mutations other than `/api/auth/*` and the bootstrap route require `Origin` equal to `APP_ORIGIN` and the header `x-still-request: 1`. Rate limits use `cf-connecting-ip` only.

The bootstrap route `POST /api/internal/bootstrap` accepts `Authorization: Bearer BOOTSTRAP_TOKEN` only while no administrator exists. It creates the user through Better Auth, then sets the row to verified, approved, and admin, and deletes any session that signup created. The token is a Worker secret. It is not in the client bundle.
