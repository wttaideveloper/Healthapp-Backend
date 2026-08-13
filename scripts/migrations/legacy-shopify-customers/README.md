# Legacy Shopify customer migration — dry run

One-time migration of historical Shopify customers who bought the old Health Age
software (and qualifying venue kits) onto one year of free HealthAge access.

**Nothing in this folder writes to the database.** The only thing implemented so
far is the analysis and the dry-run report. The real migration is a separate,
not-yet-written script that must be approved against a dry-run report first.

## Files

| File | Purpose |
| --- | --- |
| `product-eligibility.ts` | **The reviewable configuration.** Which products qualify, how many licenses each is worth, which order states count, and how the one-year grant is represented. Nothing else contains product string checks. |
| `orders-csv.ts` | Reads the Shopify orders export and groups line-item rows back into orders. |
| `build-plan.ts` | Pure CSV → per-customer plan. No database, no I/O. |
| `dry-run.ts` | Entry point. Reads the plan, inspects existing backend state read-only, prints the summary, writes the reports. |

## Running it

CSV analysis only — no database, no `DATABASE_URL` needed:

```bash
pnpm migrate:legacy-shopify:dry-run:csv-only
```

Full dry run, including read-only checks against the backend:

```bash
pnpm migrate:legacy-shopify:dry-run
```

The package script loads `.env`, whose `DATABASE_URL` points at the Docker
service host `postgres`. From the host machine, either run it inside the
container or pass a reachable URL:

```bash
docker compose run --rm app pnpm migrate:legacy-shopify:dry-run
# or
DATABASE_URL=postgresql://healthage:...@127.0.0.1:5432/healthage \
  npx tsx scripts/migrations/legacy-shopify-customers/dry-run.ts
```

Options:

```
--csv=<path>   default: orders_export_1.csv
--out=<dir>    default: migration-reports/   (gitignored: contains customer PII)
--skip-db      skip all database access
```

## Why it cannot write

Two independent guarantees:

1. The script issues `SELECT` only.
2. Every statement runs inside `BEGIN TRANSACTION READ ONLY`, ended with
   `ROLLBACK`. Postgres rejects any write on that connection, so a future edit
   that accidentally adds an `INSERT` fails loudly rather than mutating data.

It also creates no users, sends no email, and never touches the Shopify webhook
path in `src/modules/shopify/`.

## Output

- `migration-reports/legacy-shopify-customers-<timestamp>.csv` — one row per
  customer: `email, customer_name, qualifying_orders, license_quantity,
  first_purchase_date, last_purchase_date, order_numbers, products, status,
  review_notes`.
- `migration-reports/legacy-shopify-customers-<timestamp>.json` — the same data
  plus per-customer backend state, skipped products, ambiguous rows, excluded
  orders, and the `expires_at` each customer would receive.

### Customer statuses

| Status | Meaning |
| --- | --- |
| `ready_create_workspace` | Eligible, license count known, no conflicting backend state. |
| `manual_review_venue_kit` | Includes a Health Expo Screening Kit, whose seat count the export does not carry. |
| `manual_review_partial_refund` | Order is partially refunded; the export does not say which line item was refunded. |
| `skip_existing_active_workspace` | Already has a workspace granting access. Adding a second one would change which workspace the entitlement check returns. |
| `skip_no_qualifying_order` | Bought an eligible product, but every such order was refunded or cancelled. |
| `blocked_missing_email` | The export has no usable email. Customers are never merged on a blank email. |
| `blocked_ambiguous_data` | A line item matched a product by name but not by SKU, or carried an unusable quantity. |

## How the one-year grant is represented

Using the existing workspace model only — no new tables, no entitlement changes:

```
workspaces          status = 'active'
                    subscription_status = 'active'
                    plan = 'organization'
                    seat_limit = total licenses
                    expires_at = run date + 365 days
                    billing_source = 'legacy_shopify_migration'
                    is_provisioned_externally = true
                    notes = 'Legacy Shopify migration — order(s) #…'

workspace_members   role = 'owner'
                    status = 'active' if a user row already exists, else 'invited'
```

`isWorkspaceAccessActive()` (`src/modules/workspace/workspace.util.ts`) already
grants access for exactly this shape and revokes it automatically once
`expires_at` passes — no expiry job and no code change required.

`billing_source` is deliberately **not** `'shopify'`:
`findShopifyWorkspaceIdByOwnerEmail()` in `shopify.service.ts` attaches incoming
subscription webhooks to workspaces whose `billing_source` is exactly
`'shopify'` and overwrites their `expires_at` and `seat_limit`. A distinct value
keeps migrated rows out of that path and makes the entire migration selectable
in one predicate for rollback.

Members are invited by email, never created as users. The existing
`linkWorkspaceMembershipsForUser()` hook claims the seat when the customer
registers or logs in.