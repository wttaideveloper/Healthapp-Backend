import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./timestamps";

export const shopifyShops = pgTable(
    "shopify_shops",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        shopifyShopId: text("shopify_shop_id").notNull(),
        shopDomain: text("shop_domain").notNull(),
        name: text("name"),
        status: text("status").default("active").notNull(),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("shopify_shops_shopify_shop_id_unique").on(table.shopifyShopId),
        uniqueIndex("shopify_shops_shop_domain_unique").on(table.shopDomain),
        index("idx_shopify_shops_status").on(table.status),
    ]
);

export type SelectShopifyShop = typeof shopifyShops.$inferSelect;
export type InsertShopifyShop = typeof shopifyShops.$inferInsert;
