# HealthAge Backend

Fastify + Drizzle backend for HealthAge authentication, subscription entitlements, organization workspaces, Stripe billing, RevenueCat sync, and admin workflows.

The frontend should use `GET /api/v1/entitlements/me` as the single source of truth for Pro access. See [ACCESS_MODEL.md](/Users/munavvarsinan/Developer/github/wistdomtooth/healthage-backend/ACCESS_MODEL.md) for the full frontend-facing access contract.

## Stack

- Node.js 22
- Fastify
- Zod route schemas
- PostgreSQL
- Drizzle ORM / Drizzle Kit
- Stripe subscriptions for web, Windows, and standalone macOS builds
- RevenueCat sync for App Store / Play Store purchases
- SMTP email for password reset and workspace invites

## Required Environment

Create `.env` in the project root.

```bash
NODE_ENV=development
LOG_LEVEL=debug
PORT=8091
DATABASE_URL=postgresql://healthage:healthage@localhost:5432/healthage?sslmode=disable
JWT_SECRET=replace-with-at-least-32-characters

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password
EMAIL_FROM=HealthAge <noreply@healthage.com>

ADMIN_EMAILS=admin@example.com
ADMIN_BOOTSTRAP_TOKEN=optional-recovery-token

STRIPE_SECRET_KEY=sk_test_or_live_key
STRIPE_WEBHOOK_SECRET=whsec_from_stripe_webhook_endpoint
STRIPE_PRICE_ID_ANNUAL=price_id
STRIPE_SUCCESS_URL=https://your-app.example.com/billing/success
STRIPE_CANCEL_URL=https://your-app.example.com/billing/cancel
STRIPE_BILLING_PORTAL_RETURN_URL=https://your-app.example.com/settings/billing
```

For Gmail SMTP, `SMTP_PASS` must be a Gmail App Password, not the normal account password.

## Local Development

Install dependencies:

```bash
pnpm install
```

Start only Postgres:

```bash
docker compose up -d postgres
```

Run migrations from the host:

```bash
pnpm db:migrate
```

Start the API:

```bash
pnpm dev
```

API:

```text
http://localhost:8091
```

Swagger docs:

```text
http://localhost:8091/docs
```

Health checks:

```bash
curl http://localhost:8091/api/v1/health
curl http://localhost:8091/api/v1/health/ready
```

## Full Docker Run

Run API + Postgres fully in Docker:

```bash
pnpm docker:up
```

or:

```bash
docker compose up -d --build
```

The app container runs migrations automatically because `RUN_MIGRATIONS=true` is set in `docker-compose.yml`.

Check status and logs:

```bash
pnpm docker:ps
pnpm docker:logs
```

Stop containers:

```bash
pnpm docker:down
```

Reset the local Docker database:

```bash
docker compose down -v
docker compose up -d --build
```

Use `down -v` only for local reset because it deletes the Docker Postgres volume.

## Database Tools

Run migrations inside Docker:

```bash
pnpm docker:migrate
```

Open psql:

```bash
pnpm docker:db:shell
```

Create a local DB dump:

```bash
pnpm docker:db:dump
```

Start Drizzle Studio locally:

```bash
pnpm docker:studio
```

For EC2/public Studio access:

```bash
pnpm docker:studio:public
pnpm docker:studio:url
```

Open:

```text
https://local.drizzle.studio/?host=http://<EC2_PUBLIC_IP>:4983
```

Make sure EC2 security group allows inbound TCP `4983` from your IP.

## EC2 Deployment

On the server:

```bash
cd /path/to/healthage-backend
git pull
./scripts/deploy-ec2.sh
```

The deploy script:

- checks `.env`
- builds and starts Docker Compose
- lets the app container run migrations
- optionally configures nginx when `CONFIGURE_NGINX=true`

Nginx setup:

```bash
pnpm ec2:nginx
pnpm ec2:nginx:ssl
```

Check production health:

```bash
curl http://127.0.0.1:8091/api/v1/health/ready
curl https://ha.wisdomtooth.tech/api/v1/health/ready
```

## Access Model

There are three access sources:

- `workspace`: organization subscription access
- `individual_iap`: RevenueCat/App Store/Play Store access
- `individual_stripe`: Stripe subscription access for web, Windows, and standalone macOS

Frontend unlock rule:

- call `GET /api/v1/entitlements/me`
- unlock when `hasAccess=true`
- if `source=workspace`, hide individual purchase screens
- if `hasAccess=false` on iOS/macOS App Store, show RevenueCat/IAP purchase
- if `hasAccess=false` on web/Windows/standalone macOS, show Stripe purchase

## Important Routes

Auth:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/reset-password`

Entitlements:

- `GET /api/v1/entitlements/me`
- `POST /api/v1/entitlements/revenuecat/sync`

Stripe:

- `POST /api/v1/stripe/checkout`
- `POST /api/v1/stripe/portal`
- `POST /api/v1/stripe/webhook`

Platform admin:

- `GET /api/v1/admin/users`
- `POST /api/v1/admin/users/admin`
- `POST /api/v1/admin/users/promote-admin`
- `POST /api/v1/admin/workspaces`
- `GET /api/v1/admin/workspaces`
- `GET /api/v1/admin/workspaces/:id`
- `GET /api/v1/admin/workspaces/:id/members`
- `PATCH /api/v1/admin/workspaces/:id`
- `POST /api/v1/admin/workspaces/:id/members`
- `PATCH /api/v1/admin/workspaces/:id/members/:memberId`
- `DELETE /api/v1/admin/workspaces/:id/members/:memberId`

Workspace admin:

- `GET /api/v1/workspaces/me`
- `GET /api/v1/workspaces/:id/members`
- `POST /api/v1/workspaces/:id/members`
- `PATCH /api/v1/workspaces/:id/members/:memberId`
- `DELETE /api/v1/workspaces/:id/members/:memberId`

## Stripe Setup

Set the webhook endpoint in Stripe Dashboard:

```text
https://ha.wisdomtooth.tech/api/v1/stripe/webhook
```

Required webhook events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Use the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`.

After Stripe checkout, frontend should poll `GET /api/v1/entitlements/me` until it returns:

```json
{
  "hasAccess": true,
  "source": "individual_stripe"
}
```

If `stripe_customers` has rows but `stripe_subscriptions` is empty, checkout is working but webhooks are not reaching or passing signature verification.

## RevenueCat Setup

After purchase, restore, and app launch, App Store/Play Store clients should sync RevenueCat state:

```http
POST /api/v1/entitlements/revenuecat/sync
Authorization: Bearer <token>
```

Then refresh:

```http
GET /api/v1/entitlements/me
Authorization: Bearer <token>
```

Unlock when `hasAccess=true` and `source=individual_iap`.

## Workspace Emails

Workspace creation and member addition send SMTP emails:

- platform admin creates workspace owner
- platform admin adds workspace member
- workspace owner/admin adds workspace member
- revoked member is re-added

The invite email tells users to visit the HealthAge Admin / Workspace Admin portal:

```text
https://healthage.healthexporesources.com/
```

and sign in or create an account with the invited email. Matching invited memberships are activated automatically on login/register.

The address is defined once, as `WORKSPACE_ADMIN_URL` in `src/modules/workspace/workspace.links.ts`, and is used by every invite, organization-welcome and Shopify purchase confirmation email.

## Shopify Purchase Confirmation Emails

A paid Shopify order (`orders/paid`) for a supported HealthAge product creates or tops up the customer's workspace and
sends **one** purchase confirmation email, built in `src/modules/shopify/shopify.purchase-email.ts` on the shared email
design system (`src/core/email/email-document.ts`).

| Order contains | Subject |
| --- | --- |
| Large Venue Kit only | Your HealthAge Large Venue Kit Purchase Is Confirmed! |
| Small Venue Kit only | Your HealthAge Small Venue Kit Purchase Is Confirmed! |
| Discover Your Health Age only | Thank You for Purchasing Discover Your Health Age! |
| More than one supported product | Your HealthAge Purchase Is Confirmed! (one consolidated email) |

- **First purchase:** the workspace is created, then the email carries the welcome and registration instructions.
- **Repeat purchase:** the licenses are added to the existing workspace, and the email says how many were added and the new total.
- Products that are not licensed HealthAge products never produce an email (and are not listed in one).
- Shopify's own Order Confirmation email is separate and unaffected.
- Store links and the support address come from `HEALTHAGE_*_URL` and `HEALTHAGE_SUPPORT_EMAIL` (unset means the published defaults).

### Delivery: a durable outbox on the order row

The promise to email is stored in the database (`shopify_orders.purchase_email_*`, migration `0010`), in the **same
transaction** that creates the workspace or allocates the licenses. Either both commit or neither does. The code is in
`shopify.email-outbox.ts` (queue and worker), `shopify.email-delivery.ts` (one SMTP attempt and what to make of a failure) and
`src/plugins/shopify-email-outbox.plugin.ts` (starts the worker with the server and drains it on shutdown).

```text
none -> pending -> processing -> sent
          ^            |
          +- temporary failure (exponential backoff)
                       +- anything else, or out of attempts -> abandoned
```

- After the commit the webhook answers Shopify at once and tries the first send in the background.
- A worker scans every 30 s (first scan 5 s after start-up). Temporary failures are retried after 1, 2, 4, 8, 16, 32 and 60
  minutes: **8 attempts in total**, then the email is `abandoned`.
- **Claiming is a lease** (`purchase_email_locked_until`, 5 minutes) taken with `FOR UPDATE SKIP LOCKED`, so several servers can run
  the worker safely. If a worker dies mid-send, the lease runs out and the next scan takes the email over, including after a restart.
  Every claim counts as an attempt, so a worker that keeps crashing cannot loop forever.
- A webhook replay (same `X-Shopify-Webhook-Id`) or a re-send of an already-processed order allocates nothing and queues nothing.
- Orders that existed before migration `0010` are `none` and are never emailed.
- Set `SHOPIFY_EMAIL_WORKER_ENABLED=false` to switch the worker off on a server (retries and recovery stop; the immediate send
  after a purchase still happens). It is on by default.

**What is retried, and what is not.** The rule is that an attempt is only repeated when the message *provably* did not reach the
mail server, because a repeat after an ambiguous failure can deliver a second copy. The classes come from what nodemailer really
reports (tested against real nodemailer and local fake SMTP servers in `shopify.email-delivery.test.ts`):

| What happened | Class | Result |
| --- | --- | --- |
| Connection refused, host unreachable, DNS failure, connect or greeting timeout, TLS set-up failure | `retry` | retried with backoff |
| The server answered with a temporary 4xx (greylisting, busy, even after the body: it said it did not take it) | `retry` | retried with backoff |
| The server took the whole message and the connection dropped or went silent; our own send watchdog fired | `unknown_delivery` | **abandoned, never repeated**: the server may already have it |
| The connection was cut mid-conversation (cannot tell if the message was sent) | `unknown_delivery` | **abandoned, never repeated** |
| 5xx reply, bad credentials, invalid address, protocol error, an email that cannot be built | `rejected` | abandoned |

Timeouts: nodemailer connect 15 s, greeting 15 s, DNS 10 s, silence mid-conversation 60 s, and an overall watchdog of 120 s per send
(well inside the 5-minute lease). The shared workspace-email transport is not changed; only purchase emails use these timeouts.

**Duplicates.** The mail server accepting a message is the one thing that cannot be undone, so the queue is built around it:
the result is recorded with retries if the database blips; if the database stays down after a *successful* send, the result is
remembered in memory and recorded (not re-sent) when the row is next claimed by the same server; a worker whose lease ran out does not
send; a late write from a worker that lost its lease is refused. It is **at-least-once, not exactly-once**: a duplicate remains
possible only if the server dies, or the database stays down past the lease, after the mail server accepted the message
*and* before the result was saved. That memory does not survive a restart and another server cannot see it.

**Cancelled or refunded orders.** The order's status and seat count are read in the same statement that claims the email. If the order
was cancelled or fully refunded since it was queued, or partly refunded so the "licenses added" in the email would be wrong, nothing is
sent: the row becomes `abandoned` with a note starting `Skipped:`. That is expected, logs a warning, and does not alert.

**Database timeouts.** Every database call the outbox makes has a 25 s deadline, and the worker uses its own small connection pool
(2 connections, 20 s query and statement timeouts, TCP keep-alive), separate from the API's. A hung connection fails one pass with a
logged error; the next pass starts again.

**Shutdown.** On `SIGTERM` the worker stops starting new emails, then waits up to 25 s for the one being sent, and for the immediate
sends started by webhooks, before the database closes. `docker-compose.yml` sets `stop_grace_period: 40s` for the app so Docker does not
kill the container first. An email still being sent when the wait ends stays `processing` and is recovered by lease after the restart.

### Monitoring and alerts

Alerts are **log lines with a stable `alert` field** (pino JSON), so any log pipeline can match them. Create one alert rule per key:

| `alert` value | Level | Means | Action |
| --- | --- | --- | --- |
| `shopify_purchase_email_abandoned` | error | an email will not be sent automatically (rejected, out of attempts, delivery unknown, corrupt snapshot, worker died with no attempts left); fields: `shopifyOrderId`, `failure`, `reason` | page: see below |
| `shopify_purchase_email_unrecorded` | error | an email WAS sent but the database would not record it | page: check the database; do not requeue |
| `shopify_purchase_email_attention` | error | **repeats hourly** while any email is abandoned (last 7 days), more than 30 minutes overdue, or stuck `processing`; fields: counts, `oldestAgeMinutes`, up to 10 `orderIds` | page or ticket; it is also how a stopped or wedged worker shows up |

Also worth a rule: `Shopify purchase email worker pass failed` repeating (database trouble), and no `Shopify purchase email worker started`
after a boot.

**Monitor** (run against the database):

```sql
SELECT shopify_order_id, order_number, purchase_email_status, purchase_email_attempts,
       purchase_email_next_attempt_at, purchase_email_last_error
FROM shopify_orders
WHERE purchase_email_status IN ('pending', 'processing', 'abandoned')
ORDER BY updated_at DESC;
```

What an abandoned row's `purchase_email_last_error` means:

| Starts with | Meaning | What to do |
| --- | --- | --- |
| `Permanent failure` | the server refused it (bad address, bad credentials, ...) | fix the cause (for example the address in `purchase_email_payload->>'recipientEmail'`), then requeue |
| `Gave up after 8 attempts` | the mail server was unreachable for about two hours | fix SMTP, then requeue |
| `Delivery outcome unknown` | the connection broke or timed out after the message may have been taken | **check your SMTP provider's log for that recipient first**; requeue only if it was not delivered, or the customer gets two |
| `A worker stopped while sending` | the server died repeatedly mid-send | check the SMTP provider's log as above |
| `Skipped:` | the order was cancelled or refunded; no email is owed | nothing |

**Requeue an abandoned email** (after fixing the cause):

```sql
UPDATE shopify_orders
SET purchase_email_status = 'pending', purchase_email_attempts = 0,
    purchase_email_next_attempt_at = now(), purchase_email_locked_until = NULL, purchase_email_last_error = NULL
WHERE shopify_order_id = '<shopify order id>' AND purchase_email_status = 'abandoned';
```

### Rolling back migration 0010

The migration is additive, so rolling back **the code alone is always safe** (older code ignores the new columns; emails queued meanwhile
are sent late when the new code returns). Roll back the **schema** only if you must, and in this order:

1. **Roll the application code back first, or stop it.** The new code writes the `purchase_email_*` columns on every paid order. Dropping
   them underneath it makes every paid order fail (Shopify keeps retrying, so nothing is lost, but nothing is processed).
2. **Take a backup.** Any email still `pending` or `processing` is lost by the rollback.
3. **Run this as one transaction.** The last statement matters as much as the others:

   ```sql
   BEGIN;
   DROP INDEX "idx_shopify_orders_purchase_email_open";
   ALTER TABLE "shopify_orders" DROP CONSTRAINT "shopify_orders_purchase_email_status_check";
   ALTER TABLE "shopify_orders" DROP COLUMN "purchase_email_payload", DROP COLUMN "purchase_email_last_error",
     DROP COLUMN "purchase_email_sent_at", DROP COLUMN "purchase_email_locked_until",
     DROP COLUMN "purchase_email_next_attempt_at", DROP COLUMN "purchase_email_attempts",
     DROP COLUMN "purchase_email_status";
   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794268800000;
   COMMIT;
   ```

   Drizzle only compares the **newest** row of `drizzle.__drizzle_migrations` with each migration's timestamp. If that row is left in
   place, a later deploy **skips** migration 0010, the columns never return, and every paid order fails.
4. **Verify:** `SELECT column_name FROM information_schema.columns WHERE table_name = 'shopify_orders' AND column_name LIKE 'purchase_email_%';`
   returns no rows, and `SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1794268800000;` returns no rows.
5. **If you forgot the `DELETE`** and the columns are already gone: run only that `DELETE`, then deploy again.

To go forward again, deploy the new code: the container start applies the migration (below).

### Deploying

- **The migration applies automatically.** `scripts/docker-entrypoint.sh` runs `pnpm db:migrate` on every container start
  (`RUN_MIGRATIONS` is `"true"` in `docker-compose.yml`), before the server starts. A failed migration stops the container, and it
  restarts in a loop; Shopify retries webhooks meanwhile. Review migration `0010` before deploying.
- **The migration must run before the new code serves traffic.** The queue write is part of the paid-order transaction, so new code on a
  database without the columns fails every paid order. If you set `RUN_MIGRATIONS=false`, apply the migration by hand first.
- **Staging safety.** The worker starts with the server. Never run a staging server against a copy of production data with real SMTP
  credentials: it would email real customers about anything queued. Point staging SMTP at a sink (for example Mailpit) or set
  `SHOPIFY_EMAIL_WORKER_ENABLED=false`.
- Several servers on one database are safe (leases), but keep their clocks in sync (NTP): leases are timed by each server's own clock.

## Common Troubleshooting

Postgres password error when running `pnpm db:migrate`:

- host migration uses `.env` `DATABASE_URL`
- Docker app uses internal `postgres` host
- if a previous local Postgres is on port `5432`, host migration may hit the wrong DB
- use full Docker run or publish the intended DB to host

Stripe checkout succeeds but subscribe page stays:

- check app logs for `POST /api/v1/stripe/webhook`
- check Stripe Dashboard webhook deliveries are `2xx`
- verify `STRIPE_WEBHOOK_SECRET` matches the exact endpoint
- verify test/live modes match

Workspace invite exists but `user_id` is `null`:

- that is normal until the invited email registers/logs in
- login/register auto-links the membership by email

## Verification

Run typecheck:

```bash
pnpm typecheck
```

Build:

```bash
pnpm build
```

Lint script exists, but this repo currently does not include `eslint` as a dependency.
