-- Durable outbox for the Shopify purchase confirmation email, kept on the order row.
--
-- Additive only: seven new columns, one CHECK constraint and one small partial index on shopify_orders.
-- Nothing is dropped, renamed or rewritten. Every EXISTING row gets purchase_email_status = 'none' (a constant
-- default, so Postgres adds the columns without rewriting the table): historical orders are never emailed.
--
--   none        no confirmation is owed (every historical order, and any order that allocated no licenses)
--   pending     owed; waiting for its first send or for the next retry (purchase_email_next_attempt_at)
--   processing  claimed by a worker; purchase_email_locked_until is its lease. A worker that dies leaves the row
--               here and the lease expiry makes it claimable again
--   sent        delivered to the mail server (purchase_email_sent_at)
--   abandoned   not sent and not going to be: rejected for good, out of attempts, delivery outcome unknown (never repeated
--               because the server may already have it), or the order was cancelled/refunded first (purchase_email_last_error
--               then starts "Skipped:"). See README, "Monitoring" and "Requeue an abandoned email"
--
-- purchase_email_payload is a snapshot of exactly what the email says (customer name, workspace, licenses added and
-- total at purchase time), written in the same transaction that allocates the licenses.
--
-- ROLLBACK. The ORDER matters, and every step is needed (full procedure: README, "Rolling back migration 0010"):
--   1. Roll the application code back FIRST, or stop it. The new code writes these columns on every paid order, so
--      dropping them underneath it makes every paid order fail.
--   2. Take a backup. Emails still queued (pending / processing) are lost by the rollback.
--   3. Run the block below as ONE transaction. Its last statement makes drizzle forget that this migration ran. Drizzle only
--      compares the NEWEST row of drizzle.__drizzle_migrations with each migration's timestamp, so if that row stays, a later
--      deploy SKIPS this migration, the columns never come back, and every paid order then fails.
--   4. Verify: no purchase_email_* column, and no row in drizzle.__drizzle_migrations with created_at = 1794268800000.
--
-- Rollback (nothing else depends on these columns):
--   BEGIN;
--   DROP INDEX "idx_shopify_orders_purchase_email_open";
--   ALTER TABLE "shopify_orders" DROP CONSTRAINT "shopify_orders_purchase_email_status_check";
--   ALTER TABLE "shopify_orders" DROP COLUMN "purchase_email_payload", DROP COLUMN "purchase_email_last_error",
--     DROP COLUMN "purchase_email_sent_at", DROP COLUMN "purchase_email_locked_until",
--     DROP COLUMN "purchase_email_next_attempt_at", DROP COLUMN "purchase_email_attempts",
--     DROP COLUMN "purchase_email_status";
--   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794268800000;
--   COMMIT;
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_last_error" text;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "purchase_email_payload" jsonb;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD CONSTRAINT "shopify_orders_purchase_email_status_check" CHECK ("purchase_email_status" IN ('none', 'pending', 'processing', 'sent', 'abandoned'));--> statement-breakpoint
CREATE INDEX "idx_shopify_orders_purchase_email_open" ON "shopify_orders" USING btree ("purchase_email_status") WHERE "purchase_email_status" IN ('pending', 'processing');
