# still

A quieter kind of social. Approved members share one photograph at a time. A photograph is visible only when both people follow each other.

## What it does

- Registration stays pending until an editor approves it, and email ownership is verified first.
- Profiles, follow and unfollow, a chronological home feed, likes, and reports.
- Private photographs. The bucket is not public, and every image request is authorised again.
- An editors' desk for registrations, reports, suspensions, bans, roles, and an append-only audit log.

It does not add comments, messages, stories, carousels, video, hashtags, or a public discovery feed.

## Stack

Vite and React on a Cloudflare Worker, with Hono for the API, D1 for relational data, R2 for private images, and Better Auth for sessions. Local development uses the same Worker runtime through Wrangler.

## Develop

```bash
pnpm install
cp .dev.vars.example .dev.vars
# put a long random BETTER_AUTH_SECRET and BOOTSTRAP_TOKEN in .dev.vars
pnpm db:migrate:local
pnpm dev
```

The app listens on http://localhost:5173. With `DEV_MAILBOX=1` (and `ENVIRONMENT` not `production`), verification and password-reset messages are stored in D1 and the registration screen offers the link. That mailbox route is disabled in production.

Create the first administrator only after the server is running. The first person to register is never an administrator.

```bash
curl -s -X POST http://localhost:5173/api/internal/bootstrap \
  -H "authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"editor@example.com","username":"editor","password":"a-long-password"}'
```

Sign in as that editor and approve later registrations from Editors.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Deploy

Do not deploy from this repository until the production D1 database, private R2 bucket, secrets, and domain are prepared. The steps, cost assumptions, and rollback notes are in [docs/operations.md](docs/operations.md). The privacy rules are in [docs/security.md](docs/security.md). The shape of the system is in [docs/architecture.md](docs/architecture.md).
