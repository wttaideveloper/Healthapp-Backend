import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { timestamps } from "./timestamps";

export const storeEntitlements = pgTable(
    "store_entitlements",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        platform: text("platform").notNull(),
        store: text("store").notNull(),
        originalTransactionId: text("original_transaction_id").notNull(),
        latestTransactionId: text("latest_transaction_id"),
        productId: text("product_id"),
        entitlementId: text("entitlement_id"),
        expiresAt: timestamp("expires_at", { withTimezone: true }),
        isActive: boolean("is_active").default(false).notNull(),
        ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
        status: text("status").default("expired").notNull(),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("store_entitlements_store_original_tx_unique").on(table.store, table.originalTransactionId),
        index("idx_store_entitlements_owner_active_exp").on(table.ownerUserId, table.isActive, table.expiresAt),
    ]
);

export type SelectStoreEntitlement = typeof storeEntitlements.$inferSelect;
export type InsertStoreEntitlement = typeof storeEntitlements.$inferInsert;

