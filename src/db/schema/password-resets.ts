import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

export const passwordResets = pgTable(
    "password_resets",
    {
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
    },
    (table) => [
        index("idx_password_resets_user_id").on(table.userId),
        index("idx_password_resets_token_hash").on(table.tokenHash),
    ]
);

export type SelectPasswordReset = typeof passwordResets.$inferSelect;
export type InsertPasswordReset = typeof passwordResets.$inferInsert;

