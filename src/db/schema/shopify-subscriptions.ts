import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { shopifyShops } from "./shopify-shops";
import { workspaces } from "./workspaces";
import { timestamps } from "./timestamps";

export const shopifySubscriptions = pgTable(
    "shopify_subscriptions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        shopId: uuid("shop_id")
            .notNull()
            .references(() => shopifyShops.id, { onDelete: "cascade" }),
        workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
        shopifySubscriptionId: text("shopify_subscription_id").notNull(),
        status: text("status").notNull(),
        seatQuantity: integer("seat_quantity").notNull(),
        currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
        cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
        providerStatus: text("provider_status").notNull(),
        autoRenewing: boolean("auto_renewing").default(false).notNull(),
        payloadJson: jsonb("payload_json"),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("shopify_subscriptions_shopify_subscription_id_unique").on(table.shopifySubscriptionId),
        index("idx_shopify_subscriptions_shop_id").on(table.shopId),
        index("idx_shopify_subscriptions_workspace_id").on(table.workspaceId),
        index("idx_shopify_subscriptions_status").on(table.status),
        index("idx_shopify_subscriptions_current_period_end").on(table.currentPeriodEnd),
    ]
);

export type SelectShopifySubscription = typeof shopifySubscriptions.$inferSelect;
export type InsertShopifySubscription = typeof shopifySubscriptions.$inferInsert;
