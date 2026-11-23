-- Account-isolated cloud source of truth for HealthAge report history.
-- Additive only: existing application tables and customer data are untouched.
CREATE SEQUENCE "health_report_sync_sequence" AS bigint;--> statement-breakpoint

CREATE TABLE "health_reports" (
    "user_id" uuid NOT NULL,
    "id" text NOT NULL,
    "user_name" text NOT NULL,
    "user_email" text,
    "title" text NOT NULL,
    "answers" jsonb NOT NULL,
    "report_data" jsonb NOT NULL,
    "report_date" date NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_at" timestamp with time zone,
    "version" integer DEFAULT 1 NOT NULL,
    "sync_sequence" bigint DEFAULT nextval('health_report_sync_sequence') NOT NULL,
    CONSTRAINT "health_reports_user_id_id_pk" PRIMARY KEY("user_id", "id"),
    CONSTRAINT "health_reports_version_positive" CHECK ("version" > 0),
    CONSTRAINT "health_reports_id_length" CHECK (char_length("id") BETWEEN 1 AND 128),
    CONSTRAINT "health_reports_title_length" CHECK (char_length("title") BETWEEN 1 AND 300)
);--> statement-breakpoint

CREATE TABLE "health_report_groups" (
    "user_id" uuid NOT NULL,
    "id" text NOT NULL,
    "name" text NOT NULL,
    "description" text DEFAULT '' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_at" timestamp with time zone,
    "version" integer DEFAULT 1 NOT NULL,
    "sync_sequence" bigint DEFAULT nextval('health_report_sync_sequence') NOT NULL,
    CONSTRAINT "health_report_groups_user_id_id_pk" PRIMARY KEY("user_id", "id"),
    CONSTRAINT "health_report_groups_version_positive" CHECK ("version" > 0),
    CONSTRAINT "health_report_groups_id_length" CHECK (char_length("id") BETWEEN 1 AND 128),
    CONSTRAINT "health_report_groups_name_length" CHECK (char_length("name") BETWEEN 1 AND 120)
);--> statement-breakpoint

CREATE TABLE "health_report_group_links" (
    "user_id" uuid NOT NULL,
    "report_id" text NOT NULL,
    "group_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_at" timestamp with time zone,
    "version" integer DEFAULT 1 NOT NULL,
    "sync_sequence" bigint DEFAULT nextval('health_report_sync_sequence') NOT NULL,
    CONSTRAINT "health_report_group_links_user_report_group_pk" PRIMARY KEY("user_id", "report_id", "group_id"),
    CONSTRAINT "health_report_group_links_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint

CREATE TABLE "health_report_sync_mutations" (
    "user_id" uuid NOT NULL,
    "mutation_id" uuid NOT NULL,
    "operation" text NOT NULL,
    "request_hash" text NOT NULL,
    "result" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "health_report_sync_mutations_user_mutation_pk" PRIMARY KEY("user_id", "mutation_id"),
    CONSTRAINT "health_report_sync_mutations_hash_length" CHECK (char_length("request_hash") = 64)
);--> statement-breakpoint

ALTER TABLE "health_reports" ADD CONSTRAINT "health_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "health_report_groups" ADD CONSTRAINT "health_report_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "health_report_group_links" ADD CONSTRAINT "health_report_group_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "health_report_group_links" ADD CONSTRAINT "health_report_group_links_report_owner_fk" FOREIGN KEY ("user_id", "report_id") REFERENCES "public"."health_reports"("user_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "health_report_group_links" ADD CONSTRAINT "health_report_group_links_group_owner_fk" FOREIGN KEY ("user_id", "group_id") REFERENCES "public"."health_report_groups"("user_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "health_report_sync_mutations" ADD CONSTRAINT "health_report_sync_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "idx_health_reports_user_sync" ON "health_reports" ("user_id", "sync_sequence");--> statement-breakpoint
CREATE INDEX "idx_health_reports_user_created" ON "health_reports" ("user_id", "created_at" DESC, "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_health_report_groups_user_sync" ON "health_report_groups" ("user_id", "sync_sequence");--> statement-breakpoint
CREATE INDEX "idx_health_report_groups_user_created" ON "health_report_groups" ("user_id", "created_at" DESC, "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_health_report_group_links_user_sync" ON "health_report_group_links" ("user_id", "sync_sequence");--> statement-breakpoint
CREATE INDEX "idx_health_report_group_links_group" ON "health_report_group_links" ("user_id", "group_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_health_report_group_links_report" ON "health_report_group_links" ("user_id", "report_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_health_report_sync_mutation_hash" ON "health_report_sync_mutations" ("user_id", "mutation_id", "request_hash");--> statement-breakpoint
CREATE INDEX "idx_health_report_sync_mutations_created" ON "health_report_sync_mutations" ("created_at");
