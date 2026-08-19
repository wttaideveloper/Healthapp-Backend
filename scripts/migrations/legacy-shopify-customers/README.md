# Legacy Shopify customer migration

One-time migration of historical Shopify customers who bought the old
Discover Your Health Age software onto one year of free HealthAge access.

This phase migrates **software purchases only**. Health Expo Screening Kits /
venue kits, mixed partial-refund orders, and rows without a usable email are
reported and skipped.

Live Shopify webhook licensing in `src/modules/shopify/` is not used. Migrated
workspaces use `billing_source = 'legacy_shopify_migration'`, which is not a
Shopify-managed billing source.

## Files

| File | Purpose |
| --- | --- |
| `product-eligibility.ts` | **The reviewable configuration.** Which products qualify, how many licenses each is worth, which order states count, and how the one-year grant is represented. |
| `orders-csv.ts` | Reads the Shopify orders export and groups line-item rows back into orders. |
| `build-plan.ts` | Pure CSV → per-customer plan. No database, no I/O. |
| `dry-run.ts` | Read-only analysis against the CSV and (optionally) the database. |
| `apply-core.ts` | Apply decisions, idempotency, write-mode flags, per-customer transaction helper. |
| `apply.ts` | Apply CLI. Writes only with `--apply`. Default is dry-run (no writes, no emails). |
| `migration-email.ts` | Free-year grant email copy. Not the live Shopify owner-welcome mail. |
| `apply.test.ts` | Eligibility, skip, idempotency, expiry, dry-run, and email-safety tests. |

## Dry run (no writes)

CSV analysis only — no database, no `DATABASE_URL` needed:

```bash
pnpm migrate:legacy-shopify:dry-run:csv-only
pnpm migrate:legacy-shopify:apply --dry-run --skip-db
```

Full dry run, including read-only checks against the backend:

```bash
pnpm migrate:legacy-shopify:dry-run
pnpm migrate:legacy-shopify:apply --dry-run
```

Limit to the first N eligible CREATE candidates:

```bash
pnpm migrate:legacy-shopify:apply --dry-run --skip-db --limit=5
```

## Apply (writes)

`--apply` is required. Without it, nothing is inserted or emailed.

```bash
pnpm migrate:legacy-shopify:apply --apply --limit=5
pnpm migrate:legacy-shopify:apply --apply
```

If both `--apply` and `--dry-run` are passed, dry-run wins and nothing is written.

## Email configuration

The free-year email is sent only after that customer's workspace/membership
transaction commits. It is not sent in dry-run.

Required before mail can be sent (do not invent placeholders):

```bash
HEALTHAGE_ANDROID_URL=https://play.google.com/store/apps/details?id=com.wtt.healthAge
HEALTHAGE_WINDOWS_URL=https://apps.microsoft.com/detail/9P8MFP2CBVL5
HEALTHAGE_SUPPORT_EMAIL=support@healthexporesources.com
```

Optional App Store links. Omit these until a real listing URL exists; the
email will not show empty iOS or macOS rows:

```bash
# HEALTHAGE_IOS_URL=
# HEALTHAGE_MACOS_URL=
```

`EMAIL_FROM` is the SMTP From header and is separate from
`HEALTHAGE_SUPPORT_EMAIL`. Do not replace `EMAIL_FROM` with the support
address.

The apply script also uses the Android, Windows, and support values above as
defaults when the variables are unset. iOS and macOS have no defaults.

If no store URL and no support email can be resolved, the workspace is still
created and the email is reported as a configuration failure. Set the
variables in `.env` before a real send.

## Idempotency

A second run looks up workspaces by normalized owner email. If the customer
already has an active workspace, or a workspace with
`billing_source = 'legacy_shopify_migration'`, the row is `SKIP_EXISTING`.
No second workspace or owner membership is created.

A successful send appends `free_year_email_sent_at:` to `workspaces.notes`.
That marker is the email ledger; no new table is required.

## What is written

```
workspaces          status = 'active'
                    subscription_status = 'active'
                    plan = 'organization'
                    seat_limit = DYHA license total
                    expires_at = run date + 365 days
                    billing_source = 'legacy_shopify_migration'
                    is_provisioned_externally = true
                    notes = 'Legacy Shopify migration — order(s) #…'

workspace_members   role = 'owner'
                    status = 'active' if a user row already exists, else 'invited'
```

Users are never created. `shopify_orders` is never inserted. The existing
`linkWorkspaceMembershipsForUser()` hook claims an invited seat on register/login.

`isWorkspaceAccessActive()` already grants access for this workspace shape and
revokes it when `expires_at` passes.
