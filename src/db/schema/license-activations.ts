import { pgTable, uuid, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";
import { licenses } from "./licenses";

export const licenseActivations = pgTable(
    "license_activations",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),

        licenseId: uuid("license_id")
            .notNull()
            .references(() => licenses.id, { onDelete: "cascade" }),

        deviceId: text("device_id").notNull(),

        platform: text("platform"),

        activatedAt: timestamp("activated_at", { withTimezone: true })
            .defaultNow()
            .notNull(),
    },
    (table) => [uniqueIndex("idx_license_user_device_unique").on(table.licenseId, table.userId, table.deviceId)]
);

export type SelectLicenseActivation = typeof licenseActivations.$inferSelect;
export type InsertLicenseActivation = typeof licenseActivations.$inferInsert;
