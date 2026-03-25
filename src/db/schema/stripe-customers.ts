import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { timestamps } from "./timestamps";

export const stripeCustomers = pgTable(
    "stripe_customers",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        stripeCustomerId: text("stripe_customer_id").notNull(),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("stripe_customers_user_id_unique").on(table.userId),
        uniqueIndex("stripe_customers_stripe_customer_id_unique").on(table.stripeCustomerId),
    ]
);

export type SelectStripeCustomer = typeof stripeCustomers.$inferSelect;
export type InsertStripeCustomer = typeof stripeCustomers.$inferInsert;
