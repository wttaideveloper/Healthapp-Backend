import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { users } from "./users";

export const emailVerifications = pgTable("email_verifications", {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),

    tokenHash: text("token_hash").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
});
