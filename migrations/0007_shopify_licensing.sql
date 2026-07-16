CREATE TABLE "shopify_shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_shop_id" text NOT NULL,
	"shop_domain" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "shopify_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"workspace_id" uuid,
	"shopify_order_id" text NOT NULL,
	"order_number" text,
	"purchaser_email" text NOT NULL,
	"financial_status" text,
	"fulfillment_status" text,
	"seat_quantity" integer NOT NULL,
	"currency" text,
	"total_price" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "shopify_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"workspace_id" uuid,
	"shopify_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"seat_quantity" integer NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"provider_status" text NOT NULL,
	"auto_renewing" boolean DEFAULT false NOT NULL,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "shopify_shop_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_shopify_shop_id_shopify_shops_id_fk" FOREIGN KEY ("shopify_shop_id") REFERENCES "public"."shopify_shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD CONSTRAINT "shopify_orders_shop_id_shopify_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shopify_shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD CONSTRAINT "shopify_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_subscriptions" ADD CONSTRAINT "shopify_subscriptions_shop_id_shopify_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shopify_shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_subscriptions" ADD CONSTRAINT "shopify_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_shops_shopify_shop_id_unique" ON "shopify_shops" USING btree ("shopify_shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_shops_shop_domain_unique" ON "shopify_shops" USING btree ("shop_domain");--> statement-breakpoint
CREATE INDEX "idx_shopify_shops_status" ON "shopify_shops" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_orders_shopify_order_id_unique" ON "shopify_orders" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE INDEX "idx_shopify_orders_shop_id" ON "shopify_orders" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "idx_shopify_orders_workspace_id" ON "shopify_orders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_shopify_orders_purchaser_email" ON "shopify_orders" USING btree ("purchaser_email");--> statement-breakpoint
CREATE INDEX "idx_shopify_orders_status" ON "shopify_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_subscriptions_shopify_subscription_id_unique" ON "shopify_subscriptions" USING btree ("shopify_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_shopify_subscriptions_shop_id" ON "shopify_subscriptions" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "idx_shopify_subscriptions_workspace_id" ON "shopify_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_shopify_subscriptions_status" ON "shopify_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_shopify_subscriptions_current_period_end" ON "shopify_subscriptions" USING btree ("current_period_end");--> statement-breakpoint
CREATE INDEX "idx_workspaces_billing_source" ON "workspaces" USING btree ("billing_source");--> statement-breakpoint
CREATE INDEX "idx_workspaces_shopify_shop_id" ON "workspaces" USING btree ("shopify_shop_id");
