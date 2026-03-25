import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { timestamps } from "./timestamps";

export const revenuecatSubscriptions = pgTable(
    "revenuecat_subscriptions",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),

        appUserId: text("app_user_id").notNull(),

        platform: text("platform").notNull(),

        entitlementId: text("entitlement_id").notNull(),

        isActive: boolean("is_active").default(false).notNull(),

        autoRenewing: boolean("auto_renewing").default(false).notNull(),

        expiresAt: timestamp("expires_at", { withTimezone: true }),

        productId: text("product_id"),
        transactionId: text("transaction_id"),
        originalTransactionId: text("original_transaction_id"),

        customerInfo: jsonb("customer_info"),

        lastSource: text("last_source").default("revenuecat_client_sync").notNull(),
        lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),

        ...timestamps,
    },
    (table) => [
        uniqueIndex("revenuecat_subscriptions_user_id_unique").on(table.userId),
        index("idx_revenuecat_subscription_user_id").on(table.userId),
        index("idx_revenuecat_subscription_expires_at").on(table.expiresAt),
    ]
);

export type SelectRevenuecatSubscription = typeof revenuecatSubscriptions.$inferSelect;
export type InsertRevenuecatSubscription = typeof revenuecatSubscriptions.$inferInsert;
