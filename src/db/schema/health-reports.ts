import { sql } from "drizzle-orm";
import {
    bigint,
    check,
    date,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    pgSequence,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

const nextSyncSequence = sql`nextval('health_report_sync_sequence')`;
export const healthReportSyncSequence = pgSequence("health_report_sync_sequence");

/**
 * Private health reports. IDs originate on the client so an offline record keeps
 * the same identity when it is uploaded. The composite key makes that identity
 * account-scoped and prevents one account from reserving an ID for another.
 */
export const healthReports = pgTable(
    "health_reports",
    {
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        id: text("id").notNull(),
        userName: text("user_name").notNull(),
        userEmail: text("user_email"),
        title: text("title").notNull(),
        answers: jsonb("answers").notNull(),
        reportData: jsonb("report_data").notNull(),
        reportDate: date("report_date").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
        version: integer("version").default(1).notNull(),
        syncSequence: bigint("sync_sequence", { mode: "bigint" })
            .default(nextSyncSequence)
            .notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.id] }),
        check("health_reports_version_positive", sql`${table.version} > 0`),
        check("health_reports_id_length", sql`char_length(${table.id}) between 1 and 128`),
        check("health_reports_title_length", sql`char_length(${table.title}) between 1 and 300`),
        index("idx_health_reports_user_sync").on(table.userId, table.syncSequence),
        index("idx_health_reports_user_created")
            .on(table.userId, table.createdAt.desc(), table.id)
            .where(sql`${table.deletedAt} is null`),
    ]
);

export const healthReportGroups = pgTable(
    "health_report_groups",
    {
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        id: text("id").notNull(),
        name: text("name").notNull(),
        description: text("description").notNull().default(""),
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
        version: integer("version").default(1).notNull(),
        syncSequence: bigint("sync_sequence", { mode: "bigint" })
            .default(nextSyncSequence)
            .notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.id] }),
        check("health_report_groups_version_positive", sql`${table.version} > 0`),
        check("health_report_groups_id_length", sql`char_length(${table.id}) between 1 and 128`),
        check("health_report_groups_name_length", sql`char_length(${table.name}) between 1 and 120`),
        index("idx_health_report_groups_user_sync").on(table.userId, table.syncSequence),
        index("idx_health_report_groups_user_created")
            .on(table.userId, table.createdAt.desc(), table.id)
            .where(sql`${table.deletedAt} is null`),
    ]
);

/**
 * Relationship rows are retained as tombstones. Both composite foreign keys
 * include user_id, making a cross-account relationship impossible even if an
 * application-layer ownership check were accidentally omitted.
 */
export const healthReportGroupLinks = pgTable(
    "health_report_group_links",
    {
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        reportId: text("report_id").notNull(),
        groupId: text("group_id").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
        version: integer("version").default(1).notNull(),
        syncSequence: bigint("sync_sequence", { mode: "bigint" })
            .default(nextSyncSequence)
            .notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.reportId, table.groupId] }),
        check("health_report_group_links_version_positive", sql`${table.version} > 0`),
        foreignKey({
            columns: [table.userId, table.reportId],
            foreignColumns: [healthReports.userId, healthReports.id],
            name: "health_report_group_links_report_owner_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.userId, table.groupId],
            foreignColumns: [healthReportGroups.userId, healthReportGroups.id],
            name: "health_report_group_links_group_owner_fk",
        }).onDelete("cascade"),
        index("idx_health_report_group_links_user_sync").on(table.userId, table.syncSequence),
        index("idx_health_report_group_links_group")
            .on(table.userId, table.groupId)
            .where(sql`${table.deletedAt} is null`),
        index("idx_health_report_group_links_report")
            .on(table.userId, table.reportId)
            .where(sql`${table.deletedAt} is null`),
    ]
);

/**
 * Durable idempotency receipts. Only small mutation metadata is stored here;
 * report content is deliberately not duplicated.
 */
export const healthReportSyncMutations = pgTable(
    "health_report_sync_mutations",
    {
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        mutationId: uuid("mutation_id").notNull(),
        operation: text("operation").notNull(),
        requestHash: text("request_hash").notNull(),
        result: jsonb("result").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.mutationId] }),
        check("health_report_sync_mutations_hash_length", sql`char_length(${table.requestHash}) = 64`),
        uniqueIndex("uq_health_report_sync_mutation_hash").on(
            table.userId,
            table.mutationId,
            table.requestHash
        ),
        index("idx_health_report_sync_mutations_created").on(table.createdAt),
    ]
);

export type SelectHealthReport = typeof healthReports.$inferSelect;
export type SelectHealthReportGroup = typeof healthReportGroups.$inferSelect;
export type SelectHealthReportGroupLink = typeof healthReportGroupLinks.$inferSelect;
