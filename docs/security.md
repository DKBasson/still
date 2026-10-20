# Security and privacy

## Mutual follow is enforced on the server

The browser hides photographs it was not given. The Worker refuses them as well. Feed pages, profile post lists, single-post reads, likes, and image bytes all go through the same mutual-follow query. A member who is pending, rejected, suspended, or banned cannot call those routes. A pending author is not visible to other members.

Unfollowing takes effect on the next request. Image responses are not signed URLs and are not stored in a shared cache. `Cache-Control: private, no-store` is set on API and image responses. A copied image URL stops working as soon as the follow ends or the post is removed.

A signed URL would have stayed valid until its expiry even after an unfollow. still does not issue them, so there is no leftover access window. The cost of that choice is one Worker invocation and one private R2 read for every image view.

## What editors can see

Editors do not receive a public feed of every photograph. They can open an image when a report points at it, or when the post has already been removed, and that view is audited. Ordinary member queries stay on the mutual-follow rule.

## Sessions and status

Suspended and banned accounts are rejected while the session is being created, and existing sessions are deleted when the status changes. A later request with the old cookie is unauthenticated. Login for those accounts returns 403.

Passwords are hashed by Better Auth. They are not written to audit logs, mailbox rows, or API responses. The dashboard shows email, username, status, and moderation history.

## Abuse controls

- Registration and sign-in are rate limited in Better Auth, keyed by IP.
- Follows, uploads, reports, and profile edits have separate application limits.
- Usernames are unique, 3–20 characters, `[a-z0-9_]`, stored lowercase, and immutable.
- Text fields reject control characters. Titles reject line breaks.
- Image types are detected from the file contents. SVG and other types are rejected. Dimensions above 16000 pixels are rejected.
- Report duplicates and a daily report cap limit pile-ons.

## Account deletion

Deleting an account requires the current password. Photographs and the portrait object are deleted. Audit history remains, with the actor id cleared and the username label kept so the record is still readable. The last administrator cannot delete themselves.

## Appeals and conduct

The in-app conduct page states the acceptable-use rules, how editors decide, and that appeals are email replies to the registration thread rather than a product feature. Suspensions last 1, 7, or 30 days, or until reinstated. Bans last until an administrator reinstates them.

## Secrets

`BETTER_AUTH_SECRET`, `BOOTSTRAP_TOKEN`, and `RESEND_API_KEY` belong in Wrangler secrets or `.dev.vars`. `.dev.vars` is gitignored. Do not put the bootstrap token in `VITE_` variables or in the client.

## Known limits

- Metadata is stripped without a full pixel re-encode. A crafted image that is structurally valid could still be large to decode in a browser. The size and dimension caps bound that.
- Free Workers allow about 10 ms of CPU per request. Very large uploads can exceed that. If they do, move the Worker to the paid plan rather than skipping validation.
- Development mailbox links are shown in the UI only when `GET /api/dev/mailbox` is enabled. Production with `DEV_MAILBOX=1` refuses every request so a misconfiguration cannot leak mail.
- Email sending is awaited so a local mailbox is readable immediately. That reveals whether an address is registered to anyone who can time the password-reset route. The reset response text stays the same either way. A production deployment that must hide timing should hand the send to `waitUntil` and accept that the dev mailbox would no longer be synchronous.
