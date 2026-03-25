import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { timestamps } from "./timestamps";

export const stripeSubscriptions = pgTable(
    "stripe_subscriptions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        stripeCustomerId: text("stripe_customer_id").notNull(),
        stripeSubscriptionId: text("stripe_subscription_id").notNull(),
        priceId: text("price_id"),
        status: text("status").notNull(),
        currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
        cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
        providerStatus: text("provider_status").notNull(),
        autoRenewing: boolean("auto_renewing").default(false).notNull(),
        latestInvoiceId: text("latest_invoice_id"),
        quantity: integer("quantity"),
        payloadJson: jsonb("payload_json"),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("stripe_subscriptions_stripe_subscription_id_unique").on(table.stripeSubscriptionId),
        index("idx_stripe_subscriptions_user_id").on(table.userId),
        index("idx_stripe_subscriptions_status").on(table.status),
        index("idx_stripe_subscriptions_current_period_end").on(table.currentPeriodEnd),
    ]
);

export type SelectStripeSubscription = typeof stripeSubscriptions.$inferSelect;
export type InsertStripeSubscription = typeof stripeSubscriptions.$inferInsert;
