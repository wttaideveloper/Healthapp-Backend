CREATE TABLE "store_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"store" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"latest_transaction_id" text,
	"product_id" text,
	"entitlement_id" text,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT false NOT NULL,
	"owner_user_id" uuid,
	"status" text DEFAULT 'expired' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_entitlements" ADD CONSTRAINT "store_entitlements_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_entitlements_store_original_tx_unique" ON "store_entitlements" USING btree ("store","original_transaction_id");--> statement-breakpoint
CREATE INDEX "idx_store_entitlements_owner_active_exp" ON "store_entitlements" USING btree ("owner_user_id","is_active","expires_at");