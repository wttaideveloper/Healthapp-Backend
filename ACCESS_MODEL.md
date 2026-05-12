# HealthAge Access Model

This backend now has one frontend-facing access check:

`GET /api/v1/entitlements/me`

The response tells every client whether the current user should be unlocked. The client should not try to combine workspace, Apple IAP, RevenueCat, or Stripe state by itself.

## Access Sources

Access can come from:

- `workspace`: organization access provisioned by a platform admin after external payment.
- `individual_iap`: App Store / Play Store individual subscription synced from RevenueCat.
- `individual_stripe`: standalone web or desktop individual subscription from Stripe.

Workspace access wins over individual access. If a user is a member of an active paid workspace, the frontend should hide subscription and purchase screens.

## App Review Shape

For iOS and Mac App Store builds:

- Individual users subscribe with Apple IAP through RevenueCat.
- Organization users log in with an account that belongs to a paid workspace.
- Organization users must not see external payment links, license fields, Stripe checkout, or purchase calls to action.

For standalone macOS or web:

- Individual users may use Stripe.
- Organization users still get access through workspace membership.

## Main Entitlement API

### `GET /api/v1/entitlements/me`

Headers:

`Authorization: Bearer <accessToken>`

Example response for workspace access:

```json
{
  "hasAccess": true,
  "source": "workspace",
  "expiresAt": null,
  "providerStatus": "active",
  "autoRenewing": null,
  "workspace": {
    "id": "workspace-uuid",
    "name": "Clinic ABC",
    "role": "owner",
    "memberStatus": "active",
    "plan": "organization",
    "seatLimit": 25,
    "subscriptionStatus": "active"
  },
  "individual": null
}
```

Example response for individual IAP:

```json
{
  "hasAccess": true,
  "source": "individual_iap",
  "expiresAt": "2026-06-07T00:00:00.000Z",
  "providerStatus": "active",
  "autoRenewing": true,
  "workspace": null,
  "individual": {
    "provider": "revenuecat",
    "productId": "pro_monthly",
    "status": "active"
  }
}
```

Example response without access:

```json
{
  "hasAccess": false,
  "source": null,
  "expiresAt": null,
  "providerStatus": null,
  "autoRenewing": null,
  "workspace": null,
  "individual": null
}
```

Frontend unlock rule:

- If `hasAccess` is `true`, unlock the app.
- If `hasAccess` is `false` on iOS or Mac App Store, show RevenueCat/Apple IAP.
- If `hasAccess` is `false` on standalone macOS or web, show Stripe/web purchase.
- If `source` is `workspace`, never show purchase UI.

## Individual App Store Sync

### `POST /api/v1/entitlements/revenuecat/sync`

Use this after purchase, restore, and app launch/status checks in App Store builds.

Body:

```json
{
  "platform": "ios",
  "action": "restore",
  "entitlementId": "pro",
  "isActive": true,
  "autoRenewing": true,
  "expiryDate": "2026-06-07T00:00:00.000Z",
  "productId": "pro_monthly",
  "transactionId": "latest_tx_id",
  "originalTransactionId": "original_tx_id",
  "customerInfo": {}
}
```

Returns:

```json
{
  "ok": true,
  "data": {
    "hasAccess": true,
    "source": "individual_iap"
  }
}
```

The real response includes the full entitlement shape shown above.

## Platform Admin Workspace APIs

These routes are for the internal/admin panel and require a platform admin JWT.

### `POST /api/v1/admin/workspaces`

Provision a paid organization after payment happens outside the app.

Body:

```json
{
  "name": "Clinic ABC",
  "ownerEmail": "owner@clinic.com",
  "seatLimit": 25,
  "plan": "organization",
  "subscriptionStatus": "active",
  "status": "active",
  "expiresAt": null,
  "notes": "Paid by invoice"
}
```

Behavior:

- Creates the workspace.
- Adds `ownerEmail` as an owner member.
- If that email already has a user account, the membership is `active`.
- If not, the membership is `invited` and will become `active` automatically when the user registers or logs in with that email.

### `GET /api/v1/admin/workspaces`

Lists all organization workspaces with active seat counts.

### `GET /api/v1/admin/workspaces/:id`

Returns workspace details plus members.

### `PATCH /api/v1/admin/workspaces/:id`

Use this to revoke access when the organization subscription ends.

Common body examples:

```json
{
  "subscriptionStatus": "expired"
}
```

```json
{
  "status": "revoked"
}
```

`hasAccess` becomes `false` for all workspace members when:

- workspace `status` is not `active`,
- `subscriptionStatus` is not `active` or `trialing`,
- or `expiresAt` is in the past.

### `POST /api/v1/admin/workspaces/:id/members`

Add or invite a member by email.

```json
{
  "email": "doctor@clinic.com",
  "role": "member"
}
```

Allowed roles: `owner`, `admin`, `member`.

### `PATCH /api/v1/admin/workspaces/:id/members/:memberId`

Change role or status.

```json
{
  "role": "admin",
  "status": "active"
}
```

Allowed statuses: `invited`, `active`, `revoked`.

### `DELETE /api/v1/admin/workspaces/:id/members/:memberId`

Soft-revokes a member by setting `status` to `revoked`.

## Workspace Owner/Admin APIs

These routes are for organization owners/admins after they log in to the web platform.

### `GET /api/v1/workspaces/me`

Lists workspaces where the current user is an active member.

### `GET /api/v1/workspaces/:id/members`

Lists members. Requires workspace `owner` or `admin` role.

### `POST /api/v1/workspaces/:id/members`

Invites a member. Requires workspace `owner` or `admin` role.

Body:

```json
{
  "email": "member@clinic.com",
  "role": "member"
}
```

Workspace users can add only `admin` or `member`. Platform admins can create/change owners.

### `PATCH /api/v1/workspaces/:id/members/:memberId`

Workspace owner/admin can update non-owner members.

```json
{
  "role": "admin",
  "status": "active"
}
```

### `DELETE /api/v1/workspaces/:id/members/:memberId`

Workspace owner/admin can revoke non-owner members.

## Auth Changes

`POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/auth/me` no longer return `isLicensed` or `licenseId`.

They return `hasAccess` instead. `GET /api/v1/auth/me` also includes a compact `entitlement` summary.

Frontend should call `GET /api/v1/entitlements/me` after login for the full source-specific access state.

## Removed APIs

These old license-key APIs are removed:

- `POST /api/v1/licenses/activate`
- `GET /api/v1/licenses/me`
- `POST /api/v1/admin/licenses`
- `GET /api/v1/admin/licenses`
- `PATCH /api/v1/admin/licenses/:id`
- `DELETE /api/v1/admin/licenses/:id`

RevenueCat sync moved from:

`POST /api/v1/licenses/revenuecat/sync`

to:

`POST /api/v1/entitlements/revenuecat/sync`

## Local Run

Install dependencies:

```bash
pnpm install
```

Create `.env` with at least:

```bash
DATABASE_URL=postgresql://healthage:healthage@localhost:5432/healthage?sslmode=disable
JWT_SECRET=replace-with-at-least-32-characters
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=example
SMTP_PASS=example
PORT=8091
```

Start Postgres with Docker:

```bash
docker compose up -d postgres
```

Apply migrations:

```bash
pnpm db:migrate
```

Run the API:

```bash
pnpm dev
```

Swagger docs:

`http://localhost:8091/docs`

Health check:

```bash
curl http://localhost:8091/api/v1/health
```

Full Docker local run:

```bash
pnpm docker:up
```

The Docker app exposes:

`http://127.0.0.1:8091`

## EC2 Deploy

The existing EC2 deploy script builds Docker containers and runs migrations automatically because `docker-compose.yml` sets `RUN_MIGRATIONS=true`.

On the EC2 server:

```bash
cd /path/to/healthage-backend
git pull
pnpm build
./scripts/deploy-ec2.sh
```

Or use the package script:

```bash
pnpm docker:up
```

Check status:

```bash
docker compose ps
docker compose logs --tail=80 app
curl http://127.0.0.1:8091/api/v1/health
```

If the domain is configured through the included nginx script:

```bash
curl http://ha.wisdomtooth.tech/api/v1/health
```

First-time nginx setup:

```bash
./scripts/configure-nginx-ec2.sh ha.wisdomtooth.tech
```

SSL setup:

```bash
ENABLE_SSL=true ./scripts/configure-nginx-ec2.sh ha.wisdomtooth.tech
```

## Migration Notes

Migration `0006_workspace_entitlements.sql`:

- Drops old license-key tables.
- Removes `users.is_licensed`.
- Removes `users.license_id`.
- Adds `workspaces`.
- Adds `workspace_members`.

Take a database backup before applying this migration in production if old license activation data might need to be archived.
