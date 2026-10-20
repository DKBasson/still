# Operations

Nothing in this document creates production resources. Run the remote commands only when you intend to change that environment.

## Environments

| Name | How it runs | Data |
| --- | --- | --- |
| Local | `pnpm dev` on http://localhost:5173 | Wrangler local D1 and R2 under `.wrangler/` |
| Production | `pnpm deploy` after secrets and resources exist | Remote D1 `still` and R2 bucket `still-images` |

`wrangler.jsonc` points the D1 binding at a placeholder database id. Replace `database_id` with the id from `wrangler d1 create still` before a real deploy. Do not commit secrets into that file. Non-secret vars (`ENVIRONMENT`, `APP_ORIGIN`, `BETTER_AUTH_URL`) must match the public origin, including scheme.

## Environment variables

| Name | Required | Where | Purpose |
| --- | --- | --- | --- |
| `ENVIRONMENT` | yes | var | `development` locally, `production` when deployed |
| `APP_ORIGIN` | yes | var | Browser origin, used for the CSRF origin check |
| `BETTER_AUTH_URL` | yes | var | Public base URL Better Auth uses in email links |
| `BETTER_AUTH_SECRET` | yes | secret | Session signing secret, at least 32 random characters |
| `BOOTSTRAP_TOKEN` | until the first admin exists | secret | Bearer token for `POST /api/internal/bootstrap` |
| `DEV_MAILBOX` | local only | var | `1` stores mail in D1. Must be unset in production |
| `RESEND_API_KEY` | production mail | secret | Resend API key |
| `EMAIL_FROM` | production mail | var or secret | From address on a domain Resend is allowed to send from |

Generate secrets with `openssl rand -base64 32`. Set production secrets with `wrangler secret put BETTER_AUTH_SECRET` and the same for `BOOTSTRAP_TOKEN` and `RESEND_API_KEY`.

## Database

Migrations live in `migrations/` and are applied in order.

```bash
pnpm db:migrate:local
# when the remote database exists and you mean to change it:
pnpm db:migrate:remote
```

D1 stores dates as ISO-8601 text and booleans as 0 or 1. `wrangler d1 execute still --local` can inspect the local database. Remote backups use D1 Time Travel (`wrangler d1 time-travel info still` and `wrangler d1 time-travel restore`, only when you intend to roll data back). Export a snapshot before a risky migration with `wrangler d1 export still --remote --output backup.sql`.

## Images

Create a private bucket and leave public access disabled:

```bash
wrangler r2 bucket create still-images
```

Do not add an `r2.dev` public domain or a custom domain on the bucket. The Worker is the only reader. Orphan objects should be rare: a failed post insert deletes the object it just wrote, and the 04:15 UTC cron deletes objects whose posts were removed more than 90 days earlier. If a deploy is rolled back across a cron run, those objects are already gone; that is intentional.

## First administrator

After migrations and secrets are in place, and before ordinary people register:

```bash
curl -s -X POST "$APP_ORIGIN/api/internal/bootstrap" \
  -H "authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"editor@example.com","username":"editor","password":"replace-with-a-long-password"}'
```

A second call returns 409 once any admin exists. Remove `BOOTSTRAP_TOKEN` after the admin has signed in if you do not want the route to remain callable. The route stays dark without the token (404).

## Domain and DNS

1. Add the zone to Cloudflare.
2. `wrangler deploy` (only when you mean to publish).
3. Attach the Worker to the hostname with a route or a Workers custom domain.
4. Set `APP_ORIGIN` and `BETTER_AUTH_URL` to `https://that-hostname` and deploy again so email links and the origin check match.
5. Verify Resend's DNS records for `EMAIL_FROM`.

## CI

`.github/workflows/ci.yml` installs dependencies and runs typecheck, lint, test, and the production build. It does not deploy and it does not call remote Cloudflare APIs.

## Rollback

- Worker: `wrangler rollback` returns the previous script version. Assets from that version come back with it.
- Schema: ship an additive migration forward. Do not delete columns that the running script still reads. If a migration must be undone, restore a D1 Time Travel bookmark taken before it, knowing that writes after that bookmark are lost.
- Images: R2 versioning is off. Deleting an object is permanent. The 90-day soft-delete window is the recovery period for moderation removals.

## Troubleshooting

- Sign-in says the email is not verified: open the verification link. Locally it is on the registration page when the dev mailbox is enabled, or in the `dev_mailbox` table.
- Approval returns `email_unverified`: the address is not confirmed yet.
- Every API call returns 500 and the body says the server is misconfigured: `ENVIRONMENT=production` and `DEV_MAILBOX=1` together. Unset the mailbox.
- Photographs 404 after an unfollow: that is the privacy rule, not a missing file.
- `pnpm typecheck` rewrites `worker-configuration.d.ts`. That file is generated and gitignored.

## Cost assumptions

These are published Cloudflare allowances as of October 2026, for a small private membership, not a traffic forecast. Check the current price pages before launching. The application is not free at every scale.

- Workers Free includes 100,000 requests per day and about 10 ms of CPU per invocation. Each page and each photograph is a request. A few dozen members browsing a short feed stays inside that allowance. Exceeding the CPU limit on large uploads, or the daily request cap, means the Workers Paid plan (about $5 per month, then usage).
- D1 Free includes 5 GB and about 5 million row reads and 100,000 row writes per day. The schema is small. Reads grow with feed pages because each page counts likes.
- R2 includes 10 GB-month, 1 million Class A operations, and 10 million Class B operations, with no egress fee. A photograph view is one Class B read. Storage beyond 10 GB is about $0.015 per GB-month. Cloudflare Images transformations are not used.
- Better Auth has no separate hosting fee. Email is Resend's free allowance (commonly a few thousand messages a month) or whatever plan the domain is on. Password resets and verification are the only messages.
- A domain is typically about $10 a year. D1 Time Travel is included with D1; confirm the retention window on the current plan.
- Local development and CI do not incur Cloudflare charges.

A modest membership that stores a few gigabytes of photographs and stays under 100,000 Worker requests a day can run on the free allowances plus the domain and email. Plan on the Workers Paid plan if image processing starts hitting the CPU limit or the membership grows past the daily request cap.
