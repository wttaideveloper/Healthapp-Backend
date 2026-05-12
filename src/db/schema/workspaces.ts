import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { timestamps } from "./timestamps";

export const workspaces = pgTable(
    "workspaces",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        name: text("name").notNull(),
        ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
        ownerEmail: text("owner_email").notNull(),
        status: text("status").default("active").notNull(),
        subscriptionStatus: text("subscription_status").default("active").notNull(),
        plan: text("plan").default("organization").notNull(),
        seatLimit: integer("seat_limit").notNull(),
        expiresAt: timestamp("expires_at", { withTimezone: true }),
        notes: text("notes"),
        isProvisionedExternally: boolean("is_provisioned_externally").default(true).notNull(),
        createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
        revokedAt: timestamp("revoked_at", { withTimezone: true }),
        ...timestamps,
    },
    (table) => [
        index("idx_workspaces_status").on(table.status),
        index("idx_workspaces_owner_email").on(table.ownerEmail),
        index("idx_workspaces_expires_at").on(table.expiresAt),
    ]
);

export type SelectWorkspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = typeof workspaces.$inferInsert;
