ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_license_id_licenses_id_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "license_activations";--> statement-breakpoint
DROP TABLE IF EXISTS "licenses";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_licensed";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "license_id";--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"owner_email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"subscription_status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'organization' NOT NULL,
	"seat_limit" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"notes" text,
	"is_provisioned_externally" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" uuid,
	"joined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspaces_status" ON "workspaces" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner_email" ON "workspaces" USING btree ("owner_email");--> statement-breakpoint
CREATE INDEX "idx_workspaces_expires_at" ON "workspaces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_email_unique" ON "workspace_members" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user_status" ON "workspace_members" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_email_status" ON "workspace_members" USING btree ("email","status");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_workspace_status" ON "workspace_members" USING btree ("workspace_id","status");
