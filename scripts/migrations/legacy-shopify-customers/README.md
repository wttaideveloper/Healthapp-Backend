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
| `migration-email.ts` | The three onboarding templates (existing customer, Small Venue Kit, Large Venue Kit), template selection from the SKU-derived products, and the subjects. Not the live Shopify owner-welcome mail. |
| `purchase-summary.ts` | What a customer bought and how many licenses each product is worth, from the plan, for the emails. |
| `migration-email.test.ts` | Template mapping and content for every template, HTML safety and parity, and drift guards against the portal, backend and mobile app. |
| `../../../src/core/email/email-document.ts` | The shared email design system (HTML and text renderers). A pure leaf with no imports; the only application module these scripts may import. |
| `../../../src/modules/workspace/workspace.invite-template.ts` | The workspace invitation / owner-welcome email, on the same design system. |
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

1. The subject is the one for that customer's product (see "The emails"): the
   existing-customer, Small Venue Kit or Large Venue Kit subject.
2. The greeting is a customer's billing name (it is a real customer's content),
   and the email names that customer's own sign-in address (and workspace, when
   they have more than one license).
3. The "Your Free Access" card states the license count the migration wrote
   (compare with `workspaces.seat_limit`); `Start Date` is the stage 1 run date and
   `Expiry Date` is 365 days later, both shown in full ("4 November 2026"). A
   one-license customer's email has no Admin Portal, workspace or invitation steps.
4. All four platform links (Android, iOS, Windows, macOS) open the right pages.
   They default to the published listings and can be overridden with
   `HEALTHAGE_*_URL`.
5. The support address is correct.
6. The message carries the header `X-HealthAge-Migration-Email-Mode: test`. The
   subject and body are exactly what that customer would receive; only this
   header distinguishes a test. It still describes the CUSTOMER (their address,
   workspace and licenses), never the tester.
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
| `--sample` | **Sample email** with synthetic data to your own test inboxes. Preview unless `--send-sample`. Needs `--test-recipients`; never touches the database or the CSV. See "Sample email". |
| `--send-sample` | With `--sample`, actually deliver the sample to the `--test-recipients` addresses (and only those). Refused without `--sample`. |
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
  skipped and reported rather than greeted by guesswork (usually the wrong CSV);
- the plan has a qualifying purchase for the owner (`no_qualifying_purchase`
  otherwise) and the workspace's `seat_limit` equals the licenses the plan
  allocates (`license_mismatch` otherwise), because the email states that number.

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

## The emails

There are two families of customer email. Both are built from one design system
(`src/core/email/email-document.ts`): a structured document rendered to a responsive
HTML email (navy, white and subtle gold; tables and inline CSS only; no scripts,
images or external files) and a complete plain-text version, from the same data, so
they always say the same thing. Every dynamic value is escaped in the HTML and a link
is only emitted if it is a plain http(s) URL.

1. **The onboarding emails** (this migration): one per purchase, three templates.
2. **The workspace invitation email** (the live API): sent when an owner or admin
   invites a member. Described under "The workspace invitation email" below.

The details card (purchase, licenses, address, dates) is fluid: label and value sit side
by side on desktop and stack on a phone, so an address is never broken mid-word and
nothing can overflow at any screen width (240px to 900px was measured in a browser). It
uses no media queries, which many mail clients strip; Outlook for Windows gets a
two-column table through conditional comments. The sizes live in `DETAILS_LAYOUT`.

**Sending any of them to real customers is a separate, explicit authorisation.**
Nothing here sends mail when the code is deployed, and every test uses a fake mail
server.

### The onboarding emails: three templates

| Template | Chosen when the purchase contains | Subject |
| --- | --- | --- |
| `existing_customer` | Discover Your Health Age software only (SKU `008`) | Important: Upgrade to the New Discover Your Health Age App – 1 Year FREE Access |
| `small_venue_kit` | a Small Venue Kit (SKU `004-1`), and no Large Venue Kit | Your Small Venue Kit – Upgrade to the New HealthAge App with 1 Year FREE Access |
| `large_venue_kit` | a Large Venue Kit (SKU `004-2`) | Your Large Venue Kit – Upgrade to the New HealthAge App with 1 Year FREE Access |

The product kind comes from the plan's own SKU-first classification
(`ELIGIBLE_PRODUCTS`, via `purchase-summary.ts`). The email layer never matches a
product name. A purchase mixing products gets a deterministic template (Large, then
Small, then software) and **nothing is discarded**: the email lists every product line
with its own license count and the combined total.

**The route follows the real license count**, not the product name:

| Licenses | Route | Steps |
| --- | --- | --- |
| 1 | **Direct.** Download the app, sign in or **Create Account**, start. No Admin Portal, workspace or invitation instructions at all. | Download · Sign in · Start |
| 2 or more | **Workspace.** The owner opens the Admin Portal, signs in (or signs up) with the purchase email, finds the workspace under **My Workspaces**, checks the counter ("1 of N licenses used"), invites members under **Members**, then downloads the app. Each member uses the app with their own account. | Portal · Sign in · Workspace · Licenses · Invite · Members start · then the four downloads |

The license count is never recomputed by the email. It comes from the plan's own
calculation (the one the dry run prints, SKU and quantity included) and is
cross-checked against the workspace: if the workspace holds a different number of
licenses than the plan allocates, that customer is held back as `license_mismatch`
and nobody is told a wrong number. A customer with no qualifying purchase in the
plan is held back as `no_qualifying_purchase`.

### Small Venue Kit and Large Venue Kit

| | Small Venue Kit × 1 | Large Venue Kit × 1 |
| --- | --- | --- |
| Licenses | 1 (the purchaser's own) | 4 (1 owner + 3 for members) |
| Route | Direct, in the app | Workspace, via the Admin Portal |
| Admin Portal | **Never mentioned as a step**; the email only says it is not needed | Required: the owner manages the workspace there |
| Member invitations | None | Up to 3, from **Members → Invite a Member** |
| "Your Free Access" card | Purchase, Licenses, Registered Email, Access Period, Start, Expiry | Purchase, Licenses, Workspace Owner, Workspace, Start, Expiry |

A Small Venue Kit works without the portal because workspace access is decided only
by the account's active membership in an active workspace, never by its role
(`entitlement.service.ts`), and the app unlocks Pro from the backend's `hasAccess`
(`GET /entitlements/me`). Register or sign in with the purchase email and the license
applies. Buying **two** Small Venue Kits is two licenses, so that purchaser gets the
workspace route (otherwise the second license could not be handed to anyone).

### Existing accounts and new customers

Accounts live in this backend; the old software's accounts are **not** imported (the
migration never creates users). So the emails never assume an account exists and never
invent an account migration:

- *Already have a HealthAge account?* Sign in with the existing email address and
  password. **Forgot password?** on the app's sign-in screen resets it
  (`/auth/forgot-password`, `/auth/reset-password`).
- *New to the HealthAge app?* **Create Account** with the same email address used for
  the purchase. The membership created by the migration is claimed automatically at
  registration or login.
- The existing-customer email adds: "if you already have an account, please do not
  create a second one".
- Every email says to use the purchase email address (the free access is linked to
  it), that there is no approval step, and to contact support if the portal says
  "Account not authorized" or the workspace does not appear.

### The journey the emails describe (verified against the application)

| # | What the customer does | Where it is verified |
| --- | --- | --- |
| 1 | Opens the Admin Portal, which shows **Sign in** and "Need a workspace admin account? **Sign up**". (Workspace route only.) | Portal `AdminAuthScreen.tsx` |
| 2 | First time: **Sign up**, then *Full name* (letters, numbers, spaces, starting with a letter), *Work email*, *Password* (8+), then **Create account**. | Portal `WorkspaceAuthScreen.tsx`; `POST /api/v1/auth/register` |
| 3 | The backend creates an **active** account and claims the invited owner seat for that exact email. No approval step exists: the sign-up confirmation says so, and so do the emails. | `auth.route.ts` (register and login both call `linkWorkspaceMembershipsForUser`) |
| 4 | **Sign in.** The portal admits platform admins and *active* workspace owners/admins; anyone else sees "Account not authorized." (the email tells them to contact support). | Portal `page.tsx` `onLogin` |
| 5 | Lands on **My Workspaces**. "Manage Organization Members" shows **"1 of N licenses used"**: the owner uses one. | Portal `MembersView.tsx`, `storage.ts` |
| 6 | If N > 1: **Members**, then **Invite a Member** with *Email*, *Role* (leave **member**) and **Invite**. Active members and pending invitations both use a license. The backend emails the invitee. | `MembersView.tsx`; `POST /api/v1/workspaces/:id/members` (owner/admin only, the owner's seat counts) |
| 7 | Each invited member uses the **app**, not the portal (the portal rejects plain members): **Create Account** (or **Sign In**) with the invited email. The license activates automatically; no checkout. | Mobile app `i18n.ts`, `authService.ts`, `purchase.ts` |
| 8 | With one license: downloads the app and signs in or creates an account with the purchase email. | Mobile app (no email-verification step exists) |

A test reads the real Admin Portal, backend and mobile-app sources and fails if any
quoted label or any of these behaviours disappears (the portal and app checks skip
themselves when those projects are not checked out next to this one).

### The workspace invitation email

Built by `src/modules/workspace/workspace.invite-template.ts` on the same design
system, and used by **every** place that invites someone: the owner/admin invite route,
the platform-admin routes, and the Shopify owner welcome. There used to be three copies
of the text (and the values were not escaped in the HTML); there is now one builder,
`getWorkspaceInviteEmailContent` in `workspace.email.ts`.

- **Member invitation** (the default): "You've Been Invited to HealthAge!", who invited
  them (when known), the workspace, the invited address, the role, and the date access
  runs to (the workspace's expiry, when it has one). It says they do not need a
  subscription, then four steps: use the invited address, download the app (all four
  platform buttons), **Create Account** or **Sign In**, start. It does **not** send a
  plain member to the Admin Portal, which only admits owners and admins. An invited
  *admin* also gets the portal link.
- **Owner / administrator welcome**: the Admin Portal button and steps. Keeps its subject
  (and the custom subjects the Shopify flow passes in).
- **There is no "Accept Invitation" link, and none is invented.** The application has no
  invitation token, link or expiry: an invitation is a membership row that is claimed
  automatically when the person registers or signs in with that address. So the email
  says to use the invited address. If an invitation link is ever introduced, pass it as
  `acceptInvitationUrl` and the email renders an Accept Invitation button with a visible
  fallback URL; nothing else needs to change.
- The store links and the support address can be overridden per environment
  (`HEALTHAGE_ANDROID_URL`, `HEALTHAGE_IOS_URL`, `HEALTHAGE_WINDOWS_URL`,
  `HEALTHAGE_MACOS_URL`, `HEALTHAGE_SUPPORT_EMAIL`); the defaults are in
  `workspace.links.ts`, the single source, and a test keeps the migration's defaults
  equal to them.
- The inviter's name is looked up best-effort after the invitation is saved; if the
  lookup fails the email says "Your workspace administrator" and is still sent.

### The discontinuation notice

Every onboarding email, and the invitation email for members of migrated workspaces,
carries one announcement: **"Important: Discontinuation of the Previous HealthAge
Software"** (we are discontinuing the previous version of HealthAge, the old software
will no longer be supported, please switch to the new application, and the existing
purchase includes one year of free access to the new version).

- It is a navy panel with a gold rule and title and ivory text, so it is the strongest
  element in the email, and it is framed with `====` lines in the plain-text version.
  The wording lives once, in `src/core/email/email-document.ts`.
- **Placement.** Onboarding emails: straight after the introduction, above the access
  details, in all three templates and on both routes. Invitation email: after the
  invitation facts and the "no subscription needed" note, before the steps.
- **It gives no date and does not say the old software is already off**: only that it
  is being discontinued and will no longer be supported. Tests fail on any digit, month
  name or "already shut down" style claim in the notice.
- **Member invitations.** Only members of workspaces created by this migration
  (`billing_source = legacy_shopify_migration`) get it, because they are the people the
  old software was sold to and their organization really does hold the free year. For
  them the last sentence reads "Your *organization's* existing purchase includes one
  year of free access", since a member did not make the purchase. Members of manual or
  live-Shopify workspaces get no notice (they would be told about a purchase that is not
  theirs). The routes decide it with `isLegacyMigrationWorkspace(workspace.billingSource)`;
  to show it to every invited member, change that one expression in
  `workspace.route.ts` and `admin-workspace.route.ts`. The owner welcome never carries it.
- It does not replace anything: the product-specific steps, download links, sign-in
  guidance, workspace instructions, invitation behaviour and the sending safeguards are
  unchanged (the existing tests for all of them still pass).
- **One announcement, not two.** The onboarding emails used to end with an "Important
  Upgrade Information" section that repeated the notice (switch to the new app, it
  replaces the previous version, the four platforms, the free year). It was removed. Its
  two facts that were *not* repeats moved next to what they describe: "No additional
  purchase or payment is required for your N licenses" now sits under "Your N Licenses"
  (workspace route), and for a single Small Venue Kit "includes one license for your
  personal use" and "You do not need to access the Admin Portal or invite additional
  members" sit under "Your Free Access". A test fails if the switch request, "no longer
  supported" or the transition message appears more than once in an email.

### Previewing locally (nothing is sent)

```powershell
# All of these print the email and send nothing. Synthetic data; no database, CSV or mail server.
pnpm migrate:legacy-shopify:send-emails --sample --sample-product=existing "--test-recipients=you@yourdomain.com"   # existing customer, 1 license (direct)
pnpm migrate:legacy-shopify:send-emails --sample --sample-product=small    "--test-recipients=you@yourdomain.com"   # Small Venue Kit (direct)
pnpm migrate:legacy-shopify:send-emails --sample --sample-product=large    "--test-recipients=you@yourdomain.com"   # Large Venue Kit (workspace)
pnpm migrate:legacy-shopify:send-emails --sample --sample-product=dyha     "--test-recipients=you@yourdomain.com"   # software, 3 licenses (workspace)

# The tests render every template and the invitation email, check them against the application, and use a fake mail server:
pnpm test
```

### Rolling it out safely

1. Deploying the code sends nothing. Run `pnpm test`, `pnpm typecheck` and `pnpm build`.
2. Before any send, open each link the emails use: the four store links (the macOS
   link is a download page on the portal's host) and the Admin Portal address.
   Confirm the macOS link points at a build where workspace access works (see "Known
   limits").
3. Stage 1 with `--no-email` (always). Preview first with `--dry-run`.
4. Send yourself each sample (`--sample --send-sample`, to your own inboxes) and read
   them on a phone and in Gmail and Outlook.
5. Pilot with exact addresses (`--only-emails=`): one Small Venue Kit customer and one
   Large Venue Kit customer. Watch their first sign-in.
6. Then batches with `--limit=`, then everyone still pending. The ledger, the advisory
   lock and the retry handling in "Failures, retries and the ledger" apply unchanged.
7. **Each real send needs explicit authorisation.** Do not run `--send`, `--send-sample`
   or `--all` without it.

### Known limits

- **Mac App Store build.** In the mobile app, `mustUseAppStoreIapForPro()` is true
  for Mac App Store (Mac Catalyst, IAP) builds, and there workspace access must
  **not** unlock Pro. The direct-download macOS build (web Stripe flow) is
  unaffected. The macOS link in the emails must point at a build where workspace
  access works.
- The journey was verified by reading the code, not by running the portal or the apps.
  Watch the first real customer's sign-up.
- The invitation email has no accept link or invitation expiry, because the
  application has none (see above). It shows the workspace's access end date instead.
- The company logo is not an image: there is no hosted logo URL, and an email must not
  depend on one that does not exist. The header is a text wordmark.

## Sample email (synthetic, test inboxes only)

`--sample` shows, and with `--send-sample` delivers, the real migration email
filled with **made-up data** to inboxes you name. It involves no customers.
`--sample-product=existing|small|large|dyha` chooses which email it shows
(default `large`); the license counts come from the real product rules.

```powershell
# Preview (the default): prints the email and sends nothing.
pnpm migrate:legacy-shopify:send-emails --sample "--test-recipients=you@yourdomain.com,colleague@yourdomain.com"

# Deliver it to exactly those addresses:
pnpm migrate:legacy-shopify:send-emails --sample --send-sample "--test-recipients=you@yourdomain.com,colleague@yourdomain.com"
```

What the email contains: the same personalised onboarding email a customer gets
(same subject, same template), addressed to `HealthAge Test Customer` for the
fictional workspace `HealthAge Test Workspace` and the reserved address
`test.customer@example.com`, with the dates `2026-01-01 (sample date)` and
`2027-01-01 (sample date)`, the configured support address, and all four
platform links. The message carries the header
`X-HealthAge-Migration-Email-Mode: sample`.

Safety rules (all enforced in code and covered by tests, including a test that
runs the real CLI against a fake mail server and a fake database):

- `--sample` needs `--test-recipients`; `--send-sample` needs `--sample`.
- `--send`, `--all`, `--limit`, `--only-emails`, `--csv`, `--out` and
  `--allow-missing-platform-links` are **rejected**, not ignored. `--dry-run`
  still wins over `--send-sample`.
- It never connects to PostgreSQL, never reads the Shopify CSV, never writes a
  report file, never creates or updates a workspace and never writes the email
  ledger. Sample mode is decided in `main()` before any of those is touched.
- The sender refuses every address that is not on the `--test-recipients` list.
- A sample **send** is refused unless all four links and the support address are
  usable (`HEALTHAGE_ANDROID_URL`, `HEALTHAGE_WINDOWS_URL`,
  `HEALTHAGE_IOS_URL`, `HEALTHAGE_MACOS_URL`; each defaults to the published
  listing, and a value that is not a plain http(s) URL is refused). There is no
  override: a sample missing a link would test the wrong email.

Because sample mode does not read the database or the export, it **cannot check
whether a recipient is a real customer** (plain `--test-recipients` without
`--sample` can). Only list inboxes you own.

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
- A live send still refuses to start if any platform link is missing or unusable
  (the iOS and macOS links now default to the published listings, so this only
  trips on an invalid override); the email is the personalised onboarding email
  described above. Before the first send, open all four links yourself.

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

**Always pass `--no-email` to stage 1.** Plain `--apply` emails each customer inline
after their transaction commits, outside stage 2's ledger, recipient allowlist and
retry handling. Send the emails with stage 2 (`send-emails.ts`) instead.

Stage 1 never emails a customer it skipped as `SKIP_EXISTING`, so customers
migrated with `--no-email` are emailed by stage 2 (`send-emails.ts`), described
in the runbook above.

## Email configuration

The free-year email is sent only after that customer's workspace/membership
transaction commits. It is not sent in dry-run or with `--no-email`. Its content
depends on the customer's product and license count (see "The emails").

All five values below default to the published listings and the support address
(they are also the defaults the invitation emails use, from
`src/modules/workspace/workspace.links.ts`), so nothing has to be set. Set a
variable only to override its default; a value that is not a plain http(s) URL is
refused before any email is built:

```bash
# HEALTHAGE_ANDROID_URL=https://play.google.com/store/apps/details?id=com.wtt.healthAge
# HEALTHAGE_IOS_URL=https://apps.apple.com/in/app/health-age/id6744716742
# HEALTHAGE_WINDOWS_URL=https://apps.microsoft.com/detail/9P8MFP2CBVL5
# HEALTHAGE_MACOS_URL=https://healthage.healthexporesources.com/download/
# HEALTHAGE_SUPPORT_EMAIL=support@healthexporesources.com
```

`EMAIL_FROM` is the SMTP From header and is separate from
`HEALTHAGE_SUPPORT_EMAIL`. Do not replace `EMAIL_FROM` with the support
address.

A blank variable counts as unset (the default applies).

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
