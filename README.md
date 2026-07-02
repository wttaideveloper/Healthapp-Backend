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

The invite email tells users to visit:

```text
https://health-age-admin.vercel.app/workspace-admin
```

and sign in or create an account with the invited email. Matching invited memberships are activated automatically on login/register.

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
