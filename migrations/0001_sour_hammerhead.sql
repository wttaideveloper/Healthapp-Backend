CREATE TABLE "revenuecat_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_user_id" text NOT NULL,
	"platform" text NOT NULL,
	"entitlement_id" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"auto_renewing" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"product_id" text,
	"transaction_id" text,
	"original_transaction_id" text,
	"customer_info" jsonb,
	"last_source" text DEFAULT 'revenuecat_client_sync' NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revenuecat_subscriptions" ADD CONSTRAINT "revenuecat_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revenuecat_subscriptions_user_id_unique" ON "revenuecat_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_revenuecat_subscription_user_id" ON "revenuecat_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_revenuecat_subscription_expires_at" ON "revenuecat_subscriptions" USING btree ("expires_at");