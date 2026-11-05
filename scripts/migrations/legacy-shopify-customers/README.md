# Legacy Shopify customer migration

One-time migration of historical Shopify customers onto one year of free
HealthAge access: buyers of the old Discover Your Health Age software and, as
confirmed by the client, buyers of the Small and Large Venue Kits.

Cancelled and fully refunded orders, partially refunded or otherwise ambiguous
orders (held for manual review), and rows without a usable email are reported
and not written.

Live Shopify webhook licensing in `src/modules/shopify/` is not used. Migrated
workspaces use `billing_source = 'legacy_shopify_migration'`, which is not a
Shopify-managed billing source.

## Who gets what

| Product | SKU | Licenses |
| --- | --- | --- |
| Discover Your Health Age - N | `008` | N × line-item quantity (N is the number in the title) |
| Small Venue Kit (Health Expo Screening Kits - English / Small) | `004-1` | 1 × line-item quantity |
| Large Venue Kit (Health Expo Screening Kits - English / Large) | `004-2` | 4 × line-item quantity |

Everything else is skipped (default deny). The table lives in
`product-eligibility.ts`; that file is the only place to change it.

**Identification is SKU-first.** When a line item has a SKU, the SKU decides
which product it is and the title is only cross-checked. A SKU that names an
eligible product but a title that disagrees (or the reverse) is *ambiguous*:
the order is excluded and listed in the report. A blank SKU falls back to the
title. A quantity that is zero, negative, or fractional is also ambiguous; a
license count is never guessed.

**One organization per purchaser.** Orders are grouped by normalized
(trimmed, lower-cased) purchaser email. All qualifying orders for that email,
across all three products, combine into one workspace whose `seat_limit` is the
sum of their licenses. The purchaser is the workspace `owner_email` and gets the
`owner` membership, which can invite and manage members. Orders without a usable
email are never merged with each other.

Example: Large Venue Kit × 2 = 8 licenses. The purchaser is the owner and holds
one of the 8 seats (the live seat rule counts the owner's membership), so 7 are
left to assign.

**Orders that are not migrated.**

| Case | Result |
| --- | --- |
| Cancelled order | excluded |
| Fully refunded order (`refunded`) | excluded |
| Partially refunded order (`partially_refunded`), or a `paid` order that still carries a Refunded Amount | whole purchaser held for manual review. The export gives one refund total for the order, so the refund allocation is not guessed (for example #1425) |
| No usable email | blocked |
| SKU/title conflict or unusable quantity | blocked as ambiguous |

If a purchaser has a held order *and* a clean order, the whole purchaser is held:
one organization per email means the clean order cannot be written now and the
held one added later.

## Files

| File | Purpose |
| --- | --- |
| `product-eligibility.ts` | **The reviewable configuration.** Which products qualify, how many licenses each is worth, which order states count, and how the one-year grant is represented. |
| `orders-csv.ts` | Reads the Shopify orders export and groups line-item rows back into orders. |
| `build-plan.ts` | Pure CSV → per-customer plan. No database, no I/O. |
| `dry-run.ts` | Read-only analysis against the CSV and (optionally) the database. |
| `apply-core.ts` | Apply decisions, idempotency, write-mode flags, per-customer transaction helper. |
| `apply.ts` | **Stage 1** CLI. Writes only with `--apply`. Default is dry-run (no writes, no emails). |
| `send-emails.ts` | **Stage 2** CLI. Sends the free-year email to migrated customers who have not had it. Default is preview. |
| `send-emails-core.ts` | Stage 2 logic: who is owed the email, mode and flag rules, the recipient guard, the lock → send → ledger flow. No database driver, no mail library. |
| `email-transport.ts` | Builds and sends the approved email over SMTP for both stages. Imports no mail library; the CLIs inject it. |
| `migration-email.ts` | Free-year grant email copy. Not the live Shopify owner-welcome mail. |
| `apply.test.ts` | Eligibility, skip, idempotency, expiry, dry-run, and email-safety tests. |
| `send-emails.test.ts` | Stage 2 tests: ledger, retries, limits, test mode, guards, transport, and a full stage 1 → stage 2 run on the real export. |

## Runbook: two stages

The process is deliberately split so that creating access and notifying
customers are separate, individually reversible decisions.

| Stage | Command | Effect |
| --- | --- | --- |
| 1 | `apply.ts --apply --no-email` | Creates the workspaces and owner memberships. Sends nothing. |
| 2 | `send-emails.ts` | Emails owners of migrated workspaces that have no ledger entry, and records each success. |

Every command below is safe to copy. Nothing writes or sends unless it contains
`--apply` (stage 1) or `--send` / `--test-recipients` (stage 2).

### 0. Local checks (no database, no email)

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm migrate:legacy-shopify:dry-run:csv-only
```

### 1. Stage 1: migrate customers without emailing them

```bash
# Read-only preview against the database. Writes nothing, sends nothing.
pnpm migrate:legacy-shopify:apply --dry-run

# Controlled first batch: 5 customers, no email.
pnpm migrate:legacy-shopify:apply --apply --no-email --limit=5

# Everyone else, no email.
pnpm migrate:legacy-shopify:apply --apply --no-email
```

Check the summary shows `Emails : NO (--no-email)` and `Emails sent ... 0`.
Re-running is safe: customers who already have a workspace are `SKIP_EXISTING`.

### 2. Stage 2: test the email, then send it

Stage 2 needs `DATABASE_URL`, the SMTP variables (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, optionally `EMAIL_FROM`) and the platform links in
`.env`. It reads the same CSV as stage 1 (`orders_export_1.csv`) for the
customer's name.

**2a. Preview who is owed the email.** Reads only; sends nothing; writes nothing.
It also prints which platform links the email will contain.

```bash
pnpm migrate:legacy-shopify:send-emails
pnpm migrate:legacy-shopify:send-emails --dry-run
```

**2b. Verify with a test email.** Only the addresses you list receive anything.
No customer is contacted and the email ledger is not touched, so every customer
stays pending afterwards.

```bash
# Preview the test first (sends nothing):
pnpm migrate:legacy-shopify:send-emails --test-recipients=you@yourdomain.com --dry-run

# Send one customer's email, rendered exactly as that customer would get it, to you:
pnpm migrate:legacy-shopify:send-emails --test-recipients=you@yourdomain.com

# Several test addresses, three customers' emails each.
# Quote the whole flag: in PowerShell an unquoted comma splits the list.
pnpm migrate:legacy-shopify:send-emails "--test-recipients=you@yourdomain.com,colleague@yourdomain.com" --limit=3
```

Test-email checklist:

1. The subject is `Your 1 year of FREE access to the new Discover Your Health Age App`.
2. The greeting is a customer's billing name (it is a real customer's content).
3. `Start Date` is the stage 1 run date and `Expires` is 365 days later.
4. Android and Windows links open the right listings; **iOS and macOS links are
   present and correct** (they appear only when `HEALTHAGE_IOS_URL` /
   `HEALTHAGE_MACOS_URL` are set).
5. The support address is correct.
6. The message carries the header `X-HealthAge-Migration-Email-Mode: test`. The
   subject and body are identical to what customers receive; only this header
   distinguishes a test.
7. Re-run 2a: the pending count is unchanged.

Test mode refuses to run if a test address belongs to any migrated owner or any
customer in the CSV, so a "test" can never land in a real customer's inbox. It
sends for one customer unless `--limit=N` is given, and rejects `--all`.

**2c. Send to customers, in a controlled batch.** A live send needs `--send` and
an explicit scope.

```bash
# First real batch:
pnpm migrate:legacy-shopify:send-emails --send --limit=5

# Check the summary and the report, then everyone still pending:
pnpm migrate:legacy-shopify:send-emails --send --all
```

A live send is refused unless the iOS **and** macOS links are configured. If
sending without them is approved, add `--allow-missing-platform-links`.

### Stage 2 flags

| Flag | Effect |
| --- | --- |
| *(none)* / `--dry-run` | Preview. Nothing is sent or written. `--dry-run` wins over every other flag. |
| `--test-recipients=a@x.com,b@y.com` | Test mode: messages go **only** to these addresses; customers are never contacted; ledger untouched. Default scope is 1 customer. |
| `--send` | Live mode: email the customers and record each success. Needs `--limit=N`, `--all` or `--only-emails=…`. Cannot be combined with `--test-recipients`. |
| `--only-emails=a@x.com,b@y.com` | **Exact-recipient pilot.** With `--send`, emails exactly these customers and nobody else; without `--send`, previews exactly that list. Cannot be combined with `--all`, `--limit` or `--test-recipients`. Every address must be emailable or already emailed, otherwise the whole run is refused before anything is sent. See "Pilot". |
| `--limit=N` | Process at most N customers, in email order. Successful sends drop out of the pending list, so repeated `--limit=N` runs walk through everyone. |
| `--all` | Every pending customer (live mode only). |
| `--allow-missing-platform-links` | Allow a live send without the iOS/macOS links. |
| `--csv=PATH`, `--out=DIR` | Customer-name source and report directory. |

Unknown flags are errors (including the stage 1 flags `--apply` and
`--no-email`), so a typo can never silently turn a preview into a send.

### How stage 2 decides who is owed the email

A migrated workspace is emailed only if **all** of these hold:

- `billing_source = 'legacy_shopify_migration'` (the stage 1 workspaces);
- `workspaces.notes` has **no** `free_year_email_sent_at:` entry (the ledger);
- the workspace is still active and unexpired, with an expiry date on record;
- the owner's membership exists and is `invited` or `active` (not revoked);
- the owner's account, if any, is not deactivated;
- the owner is in the CSV, which supplies the greeting name. The name is not
  stored in the database, so a workspace whose owner the CSV does not know is
  skipped and reported rather than greeted by guesswork (usually the wrong CSV).

Everything skipped is listed with its reason in the console and the report.
Start date is the workspace expiry minus 365 days, i.e. the stage 1 run date.

### Failures, retries and the ledger

- **A failed send is retryable.** Nothing is recorded, so the next run picks that
  customer up again. SMTP rejecting the recipient counts as a failure.
- **A success is recorded** by appending `free_year_email_sent_at: <ISO time>` to
  `workspaces.notes`, the same ledger and format stage 1 uses. The write is an
  atomic append, does not overwrite concurrent edits, and does not change
  `updated_at` (entitlement chooses between a user's active workspaces by
  `updated_at`, so the ledger must not influence it).
- **No double sends.** Each send runs under a per-workspace database lock and
  re-reads the ledger under that lock, so two overlapping runs cannot both email
  the same customer.
- **`SENT BUT NOT RECORDED`** means the message was accepted by the mail server but
  the ledger write failed or could not be confirmed. The summary and report show
  the exact `free_year_email_sent_at: ...` line. **Add that line to the
  workspace's `notes` before running stage 2 again**, otherwise that customer is
  emailed twice. The command exits non-zero when this or any failure occurs.
- **The run stops at the first `SENT BUT NOT RECORDED`.** Whatever broke the ledger
  write (a permission, a dropped connection) may break the next one too, and each
  further send would be a duplicate on the re-run. No later customer is attempted
  or locked; the summary prints `RUN STOPPED ... N selected customer(s) were NOT
  attempted`, and they stay pending. Fix the cause, add the printed ledger line,
  then run stage 2 again: only customers still missing from the ledger are
  emailed. Ordinary failed sends (SMTP errors) do **not** stop the run.
- "Sent" means the SMTP server accepted the message for that recipient with none
  rejected. It cannot prove inbox delivery.
- A crash in the instant between a successful send and the ledger commit behaves
  like `SENT BUT NOT RECORDED` but cannot be reported; the window is a few
  milliseconds per customer.

Reports are written to `migration-reports/` (git-ignored; they contain customer
addresses).

## Pilot: exactly the customers you name

`--only-emails` makes a run act on **exactly** the addresses listed, in both
stages, and on nobody else. It exists for a controlled pilot with real customers.

- **Exact match only.** Addresses are trimmed, lower-cased and de-duplicated; that
  is all. No plus-alias or dot folding, no wildcards, no domain or partial match:
  `ann@x.com` never selects `joann@x.com` or `ann+tag@x.com`.
- **Never "everyone".** An empty, malformed or repeated list is an error, as is a
  forgotten comma. Stage 1 refuses `--limit`; stage 2 refuses `--all`, `--limit`
  and `--test-recipients` alongside it.
- **Every address must be actionable or already done.** Stage 1: creatable, or
  already has a workspace. Stage 2: owed the email, or already emailed (ledger).
  Anything else (not in the CSV, refunded, held for review, no migration
  workspace, inactive, duplicate workspaces) **refuses the whole write/send run
  before anything happens**, so a pilot never half-happens and a typo is never
  quietly dropped. A preview prints the same report and says what would be refused.
  Re-running the same command after a partial failure is safe: finished addresses
  are tolerated, the rest are retried.
- **Stage 1** needs `--no-email` with `--apply`. **Stage 2** needs `--send` as well
  to send; `--only-emails` on its own previews exactly that list.
- **Stage 2 still rechecks each customer under the advisory lock** (eligibility and
  the email ledger), and its sender refuses any address not on the list even if
  the plan were wrong.
- Live sending still needs the approved iOS and macOS links in the environment
  (`HEALTHAGE_IOS_URL`, `HEALTHAGE_MACOS_URL`); the email template is unchanged.

**Quote the flag in PowerShell.** An unquoted comma is an array operator, and
through `pnpm` the list arrives as `a@x.com b@y.com` (rejected, so it fails
safe, but it will not run). Use `"--only-emails=a@x.com,b@y.com"` everywhere.

The pilot customers must be in the CSV you pass with `--csv=`. An address that
has no eligible order in that export is reported `missing` and refuses the run.

## Running on the production server

What the repository guarantees (checked, not assumed):

- The `Dockerfile` copies `scripts/` into the image and installs dev
  dependencies, so `tsx` is there. It does **not** copy `orders_export_1.csv` or
  `.env`.
- The scripts are not part of `pnpm build` (`tsconfig.json` compiles only
  `src/`). They run with `tsx`, the same way the container runs the app.
- The container's environment comes from Compose: `env_file: .env` plus a
  `DATABASE_URL` for the `postgres` service. There is no `.env` file inside the
  image, and `node --env-file=.env` exits with an error when it is missing, so
  do **not** use the `pnpm migrate:legacy-shopify:*` shortcuts in the container.
  Call `pnpm exec tsx <script>` directly.
- A server deploy builds from the server's git checkout (`deploy-ec2.sh` runs
  `docker compose up -d --build`). The new scripts reach the server only through
  that checkout. `orders_export_1.csv` is tracked in git, so a checkout has it
  at the repo root, but it is **not** in the image.

You do not need to rebuild or restart the live app to run the scripts: run a
one-off container from the existing image and mount the checkout's `scripts/`
and the CSV read-only. Secrets never appear on the command line; they come from
the Compose environment inside the container. Do **not** run
`docker compose config`, `docker inspect`, `printenv` or `env` to "check"
settings: they print secret values.

```bash
cd /path/to/Healthapp-Backend     # the checkout deploy-ec2.sh builds from
mkdir -p migration-reports        # kept on the host; contains customer addresses
CSV=orders_export_1.csv           # or the export that contains the pilot orders

pilot() {                         # one-off container, production DATABASE_URL, no secrets typed
  docker compose run --rm --no-deps \
    -v "$PWD/scripts:/app/scripts:ro" \
    -v "$PWD/$CSV:/app/orders_export_1.csv:ro" \
    -v "$PWD/migration-reports:/app/migration-reports" \
    app pnpm exec tsx "$@"
}
```

Check what the container will use before anything else (prints the database
host and name, and `set`/`MISSING` for each variable; never a value):

```bash
docker compose run --rm --no-deps app node -e "const u=new URL(process.env.DATABASE_URL);console.log('database:',u.hostname+':'+(u.port||5432)+'/'+u.pathname.slice(1));for(const k of ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','EMAIL_FROM','HEALTHAGE_IOS_URL','HEALTHAGE_MACOS_URL'])console.log(k.padEnd(20),process.env[k]?'set':'MISSING')"
```

Then, for the pilot (stage 1 and stage 2 back to back, because the grant clock
starts at stage 1):

```bash
PAIR="first@customer.example,second@customer.example"
S=scripts/migrations/legacy-shopify-customers

pilot $S/apply.ts --dry-run "--only-emails=$PAIR"              # read-only: who would be created
pilot $S/apply.ts --apply --no-email "--only-emails=$PAIR"     # WRITES the workspaces, sends nothing
pilot $S/send-emails.ts "--only-emails=$PAIR"                  # preview: sends nothing
pilot $S/send-emails.ts --send "--only-emails=$PAIR"           # LIVE: emails exactly these customers
echo "exit code: $?"                                           # 0 = clean; 1 = a failure or an unrecorded send
```

Verify with read-only SQL (`updated_at` must be unchanged by stage 2):

```bash
docker compose exec -T postgres psql -U healthage -d healthage -c \
  "select owner_email, seat_limit, expires_at, updated_at, notes from workspaces where billing_source='legacy_shopify_migration' order by created_at desc limit 5;"
```

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
pnpm migrate:legacy-shopify:apply --apply --no-email --limit=5
pnpm migrate:legacy-shopify:apply --apply --no-email
```

If both `--apply` and `--dry-run` are passed, dry-run wins and nothing is written.

| Flag | Effect |
| --- | --- |
| `--apply` | Allow writes. Without it the run is a dry run. |
| `--dry-run` | Force no writes and no email, even with `--apply`. |
| `--no-email` | Write workspaces but send **no** free-year email. |
| `--skip-db` | Do not read the database (CSV analysis only). |
| `--limit=N` | Create at most N customers. |
| `--only-emails=a@x.com,b@y.com` | Act on **exactly** these addresses and nobody else. With `--apply` it requires `--no-email` (stage 2 sends); cannot be combined with `--limit`. Every address must be creatable or already have a workspace, otherwise a write run is refused and nothing is written. See "Pilot". |
| `--csv=PATH`, `--out=DIR` | Input export and report directory. |

Unrecognised flags are rejected, so a mistyped `--no-emial` stops the run
instead of being ignored and sending mail.

**Until the iOS and macOS store links are approved, always pass `--no-email`.**
Plain `--apply` still emails each customer after their transaction commits.

Stage 1 never emails a customer it skipped as `SKIP_EXISTING`, so customers
migrated with `--no-email` are emailed by stage 2 (`send-emails.ts`), described
in the runbook above.

## Email configuration

The free-year email is sent only after that customer's workspace/membership
transaction commits. It is not sent in dry-run or with `--no-email`. The
template is unchanged and is the same for every product.

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
That marker is the email ledger, shared by both stages; no new table is
required. Stage 2 reads it to decide who still needs the email.

Stage 1's own inline email path (plain `--apply`, without `--no-email`) updates
the ledger with a statement that also refreshes `updated_at`. That path is not
used in the two-stage process; stage 2's ledger write deliberately leaves
`updated_at` alone.

Apply never edits an existing workspace. If a purchaser was already migrated
(for example in an earlier software-only run) and the plan now totals more
seats, they are `SKIP_EXISTING` and the dry run adds a note
"has N seat(s) but the plan totals M" so a human can raise the seat limit.

Each customer is one transaction: the workspace and its owner membership are
written together or not at all. The email is sent only after the commit, so an
email failure never undoes a workspace.

## What is written

```
workspaces          status = 'active'
                    subscription_status = 'active'
                    plan = 'organization'
                    seat_limit = combined license total (all products)
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
