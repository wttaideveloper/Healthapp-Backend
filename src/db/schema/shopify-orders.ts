import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { shopifyShops } from "./shopify-shops";
import { workspaces } from "./workspaces";
import { timestamps } from "./timestamps";

export const shopifyOrders = pgTable(
    "shopify_orders",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        shopId: uuid("shop_id")
            .notNull()
            .references(() => shopifyShops.id, { onDelete: "cascade" }),
        workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
        shopifyOrderId: text("shopify_order_id").notNull(),
        orderNumber: text("order_number"),
        purchaserEmail: text("purchaser_email").notNull(),
        financialStatus: text("financial_status"),
        fulfillmentStatus: text("fulfillment_status"),
        /** Licensed seat count granted by this order. */
        seatQuantity: integer("seat_quantity").notNull(),
        currency: text("currency"),
        totalPrice: text("total_price"),
        /**
         * Lifecycle of this license order in HealthAge.
         * Expected values: pending | fulfilled | refunded | cancelled
         */
        status: text("status").default("pending").notNull(),
        payloadJson: jsonb("payload_json"),
        /**
         * Durable outbox for the purchase confirmation email (see shopify.email-outbox.ts).
         * none | pending | processing | sent | abandoned. Every historical row is 'none': never emailed.
         */
        purchaseEmailStatus: text("purchase_email_status").default("none").notNull(),
        /** Send attempts made so far (a claim counts as an attempt, so a crashing worker cannot loop forever). */
        purchaseEmailAttempts: integer("purchase_email_attempts").default(0).notNull(),
        /** When a 'pending' email is next due (the first send, or the retry after a backoff). */
        purchaseEmailNextAttemptAt: timestamp("purchase_email_next_attempt_at", { withTimezone: true }),
        /** The lease of the worker that claimed the row; after it passes, another worker may take over. */
        purchaseEmailLockedUntil: timestamp("purchase_email_locked_until", { withTimezone: true }),
        purchaseEmailSentAt: timestamp("purchase_email_sent_at", { withTimezone: true }),
        /** The last failure, as a short sanitized note (never credentials or message bodies). */
        purchaseEmailLastError: text("purchase_email_last_error"),
        /** Snapshot of what the email says, written in the same transaction that allocates the licenses. */
        purchaseEmailPayload: jsonb("purchase_email_payload"),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("shopify_orders_shopify_order_id_unique").on(table.shopifyOrderId),
        index("idx_shopify_orders_shop_id").on(table.shopId),
        index("idx_shopify_orders_workspace_id").on(table.workspaceId),
        index("idx_shopify_orders_purchaser_email").on(table.purchaserEmail),
        index("idx_shopify_orders_status").on(table.status),
        index("idx_shopify_orders_purchase_email_open")
            .on(table.purchaseEmailStatus)
            .where(sql`${table.purchaseEmailStatus} IN ('pending', 'processing')`),
        check(
            "shopify_orders_purchase_email_status_check",
            sql`${table.purchaseEmailStatus} IN ('none', 'pending', 'processing', 'sent', 'abandoned')`
        ),
    ]
);

export type SelectShopifyOrder = typeof shopifyOrders.$inferSelect;
export type InsertShopifyOrder = typeof shopifyOrders.$inferInsert;
