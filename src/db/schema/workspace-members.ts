import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";
import { timestamps } from "./timestamps";

export const workspaceMembers = pgTable(
    "workspace_members",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: uuid("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "cascade" }),
        userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
        email: text("email").notNull(),
        role: text("role").default("member").notNull(),
        status: text("status").default("invited").notNull(),
        invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
        joinedAt: timestamp("joined_at", { withTimezone: true }),
        revokedAt: timestamp("revoked_at", { withTimezone: true }),
        ...timestamps,
    },
    (table) => [
        uniqueIndex("workspace_members_workspace_email_unique").on(table.workspaceId, table.email),
        index("idx_workspace_members_user_status").on(table.userId, table.status),
        index("idx_workspace_members_email_status").on(table.email, table.status),
        index("idx_workspace_members_workspace_status").on(table.workspaceId, table.status),
    ]
);

export type SelectWorkspaceMember = typeof workspaceMembers.$inferSelect;
export type InsertWorkspaceMember = typeof workspaceMembers.$inferInsert;
