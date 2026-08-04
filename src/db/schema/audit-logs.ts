import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only administrative audit trail.
 *
 * Answers three questions for an administrator: who did what, when, and to which
 * resource. Rows are written only for real state-changing actions — never for
 * reads, and never synthesised after the fact.
 *
 * DESIGN NOTES
 *
 * 1. No foreign keys. An audit record must outlive the thing it describes: if a
 *    workspace is deleted, "who revoked it" is exactly the row you still need.
 *    FKs would either cascade the evidence away or block the delete. Actor and
 *    workspace identifiers are therefore plain columns.
 *
 * 2. Labels are denormalised alongside the ids (`actorEmail`, `workspaceName`,
 *    `targetLabel`). The id answers "which record"; the label keeps the row
 *    readable once that record is gone or renamed. This is also what makes the
 *    admin table searchable without joining four tables per page.
 *
 * 3. `targetId` is text, not uuid. Most targets are uuids, but some real actions
 *    reference external identifiers (a Shopify order id), and a type mismatch
 *    must never be able to fail an audit write.
 *
 * 4. Nothing here is updated after insert. There is no `updatedAt` on purpose.
 */
export const auditLogs = pgTable(
    "audit_logs",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        /** Stable machine key, e.g. "workspace.created". See AUDIT_ACTIONS. */
        action: text("action").notNull(),

        /** Null for system actors (provider webhooks run with no signed-in user). */
        actorUserId: uuid("actor_user_id"),
        actorEmail: text("actor_email"),
        actorRole: text("actor_role"),

        /** "workspace" | "member" | "user" | "session" — see AUDIT_TARGETS. */
        targetType: text("target_type"),
        targetId: text("target_id"),
        targetLabel: text("target_label"),

        workspaceId: uuid("workspace_id"),
        workspaceName: text("workspace_name"),

        /** "success" | "failure". Failures are recorded for security-relevant actions. */
        result: text("result").default("success").notNull(),

        /** Small, action-specific detail (changed fields, reason). Never a full payload. */
        metadata: jsonb("metadata"),

        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        // Listing is always newest-first; this index serves the default query.
        index("idx_audit_logs_created_at").on(table.createdAt),
        index("idx_audit_logs_action").on(table.action),
        index("idx_audit_logs_actor_user_id").on(table.actorUserId),
        index("idx_audit_logs_workspace_id").on(table.workspaceId),
    ]
);

export type SelectAuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
