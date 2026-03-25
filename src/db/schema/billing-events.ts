import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const billingEvents = pgTable(
    "billing_events",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        provider: text("provider").notNull(),
        eventId: text("event_id").notNull(),
        eventType: text("event_type").notNull(),
        processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
        payloadJson: jsonb("payload_json").notNull(),
    },
    (table) => [
        uniqueIndex("billing_events_provider_event_id_unique").on(table.provider, table.eventId),
    ]
);

export type SelectBillingEvent = typeof billingEvents.$inferSelect;
export type InsertBillingEvent = typeof billingEvents.$inferInsert;
