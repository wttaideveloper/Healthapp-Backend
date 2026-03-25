import {
    pgTable,
    text,
    uuid,
    boolean,
    timestamp,
    integer,
    index,
} from "drizzle-orm/pg-core";
import { timestamps } from "./timestamps";

export const licenses = pgTable(
    "licenses",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        organizationName: text("organization_name").notNull(),

        licenseKeyHash: text("license_key_hash").notNull().unique(),

        allowedEmailDomain: text("allowed_email_domain"),

        maxActivations: integer("max_activations"),

        expiresAt: timestamp("expires_at", { withTimezone: true }),

        createdByUserId: uuid("created_by_user_id"),

        isActive: boolean("is_active").default(true).notNull(),

        ...timestamps,
    },
    (table) => [
        index("idx_license_key_hash").on(table.licenseKeyHash),
    ]
);

export type SelectLicense = typeof licenses.$inferSelect;
export type InsertLicense = typeof licenses.$inferInsert;
