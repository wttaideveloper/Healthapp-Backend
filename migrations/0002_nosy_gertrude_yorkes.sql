CREATE TABLE "stripe_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"price_id" text,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"provider_status" text NOT NULL,
	"auto_renewing" boolean DEFAULT false NOT NULL,
	"latest_invoice_id" text,
	"quantity" integer,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_json" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_subscriptions" ADD CONSTRAINT "stripe_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_customers_user_id_unique" ON "stripe_customers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_customers_stripe_customer_id_unique" ON "stripe_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_subscriptions_stripe_subscription_id_unique" ON "stripe_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_subscriptions_user_id" ON "stripe_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_subscriptions_status" ON "stripe_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_stripe_subscriptions_current_period_end" ON "stripe_subscriptions" USING btree ("current_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_id_unique" ON "billing_events" USING btree ("provider","event_id");