import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
        ...timestamps,
    },
    (table) => [
        uniqueIndex("shopify_orders_shopify_order_id_unique").on(table.shopifyOrderId),
        index("idx_shopify_orders_shop_id").on(table.shopId),
        index("idx_shopify_orders_workspace_id").on(table.workspaceId),
        index("idx_shopify_orders_purchaser_email").on(table.purchaserEmail),
        index("idx_shopify_orders_status").on(table.status),
    ]
);

export type SelectShopifyOrder = typeof shopifyOrders.$inferSelect;
export type InsertShopifyOrder = typeof shopifyOrders.$inferInsert;
