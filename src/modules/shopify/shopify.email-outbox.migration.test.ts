/**
 * Migration 0010 (the purchase email outbox columns), exercised on a database that ALREADY holds historical orders.
 *
 * In-memory Postgres (PGlite) only. The migration is applied to a throwaway database built from the project's earlier
 * migrations; nothing here connects to a real database or reads a connection string.
 */
import "./shopify.test-env";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { FastifyInstance } from "fastify";

import { runPurchaseEmailOutbox } from "./shopify.email-outbox";
import { recordShopifyWebhookEvent } from "./shopify.service";
import { PRODUCT, TEST_SHOP_DOMAIN, createCapturingLogger, createFakeSmtp, shopifyOrderPayload } from "./shopify.pglite.test-env";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");
const TAG = "0010_shopify_purchase_email_outbox";
const SQL_FILE = path.join(MIGRATIONS_DIR, `${TAG}.sql`);

const migrationSql = (): string => fs.readFileSync(SQL_FILE, "utf8");
const statementsOf = (text: string): string[] =>
    text
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

/** A copy of the project's migrations WITHOUT 0010, so a database can be built in its "before" state. */
function copyMigrationsWithout0010(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "healthage-migrations-"));
    fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    fs.rmSync(path.join(dir, `${TAG}.sql`));
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag !== TAG);
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    return dir;
}

describe("migration 0010: files and journal", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
        entries: Array<{ idx: number; when: number; tag: string }>;
    };

    it("is the last journal entry, with a timestamp later than every earlier one (drizzle skips an older one)", () => {
        const last = journal.entries[journal.entries.length - 1]!;
        assert.equal(last.tag, TAG);
        for (let index = 1; index < journal.entries.length; index += 1) {
            assert.ok(journal.entries[index]!.when > journal.entries[index - 1]!.when, `${journal.entries[index]!.tag} is later than ${journal.entries[index - 1]!.tag}`);
            assert.equal(journal.entries[index]!.idx, journal.entries[index - 1]!.idx + 1);
        }
    });

    it("every journalled migration has its SQL file", () => {
        for (const entry of journal.entries) assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`)), entry.tag);
    });

    it("is additive only: it adds columns, one constraint and one index, and drops or rewrites nothing", () => {
        const executable = statementsOf(migrationSql())
            .map((statement) => statement.replace(/^(--.*\n)+/gm, "").trim())
            .filter(Boolean);
        assert.equal(executable.length, 9);
        for (const statement of executable) {
            assert.match(statement, /^(ALTER TABLE "shopify_orders" ADD (COLUMN|CONSTRAINT)|CREATE INDEX)/, statement);
            assert.doesNotMatch(statement, /\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i, statement);
        }
    });
});

describe("migration 0010 applied to a database that already has historical orders", () => {
    let client: PGlite;
    let db: ReturnType<typeof drizzle>;
    let beforeRows: Array<Record<string, unknown>>;
    let tmpDir: string;

    const query = async <T = Record<string, unknown>>(text: string): Promise<T[]> => (await client.query<T>(text)).rows;

    before(async () => {
        tmpDir = copyMigrationsWithout0010();
        client = new PGlite();
        db = drizzle(client);
        await migrate(db, { migrationsFolder: tmpDir });

        // Historical orders, as they exist in production today: paid, cancelled, refunded, and one that allocated nothing.
        await client.exec(`INSERT INTO shopify_shops (shopify_shop_id, shop_domain) VALUES ('shop-1', '${TEST_SHOP_DOMAIN}')`);
        for (const [id, email, seats, status] of [
            ["H1", "old1@example.com", 4, "pending"],
            ["H2", "old2@example.com", 1, "cancelled"],
            ["H3", "old3@example.com", 8, "refunded"],
            ["H4", "old4@example.com", 0, "pending"],
        ] as const) {
            await client.exec(
                `INSERT INTO shopify_orders (shop_id, shopify_order_id, purchaser_email, seat_quantity, status, payload_json)
                 SELECT id, '${id}', '${email}', ${seats}, '${status}', '{"id": "${id}", "email": "${email}"}'::jsonb FROM shopify_shops`
            );
        }
        beforeRows = await query(`SELECT * FROM shopify_orders ORDER BY shopify_order_id`);

        for (const statement of statementsOf(migrationSql())) await client.exec(statement);
    });

    after(async () => {
        await client.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("applies cleanly to a table that already has rows, and loses none of them", async () => {
        const rows = await query(`SELECT * FROM shopify_orders ORDER BY shopify_order_id`);
        assert.equal(rows.length, 4);
        for (const [index, row] of rows.entries()) {
            for (const [column, value] of Object.entries(beforeRows[index]!)) {
                assert.deepEqual(row[column], value, `${beforeRows[index]!.shopify_order_id}.${column} is unchanged`);
            }
        }
    });

    it("every historical order is 'none': no attempts, no schedule, no lease, no payload", async () => {
        const rows = await query<Record<string, unknown>>(
            `SELECT purchase_email_status, purchase_email_attempts, purchase_email_next_attempt_at, purchase_email_locked_until,
                    purchase_email_sent_at, purchase_email_last_error, purchase_email_payload FROM shopify_orders`
        );
        assert.equal(rows.length, 4);
        for (const row of rows) {
            assert.deepEqual(row, {
                purchase_email_status: "none",
                purchase_email_attempts: 0,
                purchase_email_next_attempt_at: null,
                purchase_email_locked_until: null,
                purchase_email_sent_at: null,
                purchase_email_last_error: null,
                purchase_email_payload: null,
            });
        }
    });

    it("the outbox does not process historical orders, now or in the far future; only a NEW purchase is emailed", async () => {
        const app = { db } as unknown as FastifyInstance;
        const smtp = createFakeSmtp();
        const log = createCapturingLogger();
        const farFuture = () => new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);

        const historical = await runPurchaseEmailOutbox(app.db, log, { createTransport: smtp.createTransport, now: farFuture });
        assert.equal(historical.claimed, 0);
        assert.equal(historical.recoveredAsAbandoned, 0);
        assert.equal(smtp.attempts, 0);

        const result = await recordShopifyWebhookEvent(app, {
            webhookId: "wh-after-migration",
            topic: "orders/paid",
            payloadJson: shopifyOrderPayload({ orderId: 555, email: "new@example.com", items: [{ productId: PRODUCT.small, quantity: 1 }] }),
            shopDomain: TEST_SHOP_DOMAIN,
            log,
        });
        assert.ok(result.purchaseEmail);
        const fresh = await runPurchaseEmailOutbox(app.db, log, { createTransport: smtp.createTransport, now: farFuture });
        assert.equal(fresh.sent, 1);
        assert.deepEqual(smtp.sent.map((message) => message.to), ["new@example.com"]);

        const statuses = await query<{ shopify_order_id: string; purchase_email_status: string }>(
            `SELECT shopify_order_id, purchase_email_status FROM shopify_orders ORDER BY shopify_order_id`
        );
        assert.deepEqual(
            statuses.map((row) => `${row.shopify_order_id}:${row.purchase_email_status}`),
            ["555:sent", "H1:none", "H2:none", "H3:none", "H4:none"]
        );
    });

    it("only the five known statuses are accepted", async () => {
        for (const status of ["none", "pending", "processing", "sent", "abandoned"]) {
            await client.exec(`UPDATE shopify_orders SET purchase_email_status = '${status}' WHERE shopify_order_id = 'H4'`);
        }
        await assert.rejects(client.exec(`UPDATE shopify_orders SET purchase_email_status = 'bogus' WHERE shopify_order_id = 'H4'`), /shopify_orders_purchase_email_status_check/);
        await client.exec(`UPDATE shopify_orders SET purchase_email_status = 'none' WHERE shopify_order_id = 'H4'`);
    });

    it("creates the small partial index the worker scans", async () => {
        const [index] = await query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_shopify_orders_purchase_email_open'`);
        assert.ok(index);
        assert.match(index.indexdef, /WHERE/);
        assert.match(index.indexdef, /pending/);
        assert.match(index.indexdef, /processing/);
    });

    it("the rollback written in the migration's header works: the columns, constraint and index go away", async () => {
        const lines = migrationSql().split("\n");
        const start = lines.findIndex((line) => line.startsWith("-- Rollback"));
        assert.ok(start >= 0, "the migration documents its rollback");
        const rollback: string[] = [];
        for (const line of lines.slice(start + 1)) {
            if (!line.startsWith("--")) break;
            rollback.push(line.replace(/^--\s*/, ""));
        }
        await client.exec(rollback.join(" "));

        const columns = await query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'shopify_orders' AND column_name LIKE 'purchase_email_%'`
        );
        assert.deepEqual(columns, []);
        assert.equal((await query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_shopify_orders_purchase_email_open'`)).length, 0);
        assert.equal((await query(`SELECT * FROM shopify_orders`)).length, 5, "rolling back loses no order");
    });
});
