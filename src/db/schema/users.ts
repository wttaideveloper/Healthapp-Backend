import { pgTable, text, uuid, boolean } from "drizzle-orm/pg-core";
import { userStatusEnum, userRoleEnum } from "./enums";
import { timestamps } from "./timestamps";

export const users = pgTable("users", {
    id: uuid("id").defaultRandom().primaryKey(),

    name: text("name").notNull(),

    email: text("email").notNull().unique(),

    passwordHash: text("password_hash").notNull(),

    role: userRoleEnum("role")
        .default("user")
        .notNull(),

    isEmailVerified: boolean("is_email_verified")
        .default(false)
        .notNull(),

    status: userStatusEnum("status")
        .default("pending")
        .notNull(),

    ...timestamps,
});

export type SelectUser = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
