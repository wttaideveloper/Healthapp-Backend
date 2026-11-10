/**
 * Documentation that is executed: the rollback procedure, the monitoring and requeue SQL, the alert keys and the Docker
 * shutdown grace in README.md / the migration header / docker-compose.yml are checked against the real code, so they cannot
 * quietly go stale. In-memory Postgres (PGlite) only.
 */
import "./shopify.test-env";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { PURCHASE_EMAIL_ALERT, PURCHASE_EMAIL_MAX_ATTEMPTS, PURCHASE_EMAIL_SHUTDOWN_GRACE_MS, runPurchaseEmailOutbox } from "./shopify.email-outbox";
import { smtpErrors } from "./shopify.fake-smtp.test-env";
import { recordShopifyWebhookEvent } from "./shopify.service";
import { PRODUCT, TEST_SHOP_DOMAIN, createCapturingLogger, createFakeSmtp, createTestDatabase, outboxRow, shopifyOrderPayload, smtpError, type TestDatabase } from "./shopify.pglite.test-env";

const ROOT = path.resolve(__dirname, "../../..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const MIGRATION = fs.readFileSync(path.join(ROOT, "migrations", "0010_shopify_purchase_email_outbox.sql"), "utf8");
const COMPOSE = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const MIGRATION_TIMESTAMP = (
    JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> }
).entries.find((entry) => entry.tag === "0010_shopify_purchase_email_outbox")!.when;

/** The ```sql fenced blocks of the README, with the list indentation removed. */
function readmeSqlBlocks(): string[] {
    return [...README.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!.split("\n").map((line) => line.replace(/^\s{3}/, "")).join("\n"));
}

const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** The rollback block written in the migration's own header comment. */
function headerRollbackSql(): string {
    const lines = MIGRATION.split("\n");
    const start = lines.findIndex((line) => line.startsWith("-- Rollback"));
    const block: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (!line.startsWith("--")) break;
        block.push(line.replace(/^--\s*/, ""));
    }
    return block.join("\n");
}

const readmeRollbackSql = (): string => readmeSqlBlocks().find((block) => block.includes("DROP INDEX"))!;

describe("rolling back migration 0010: the documented procedure works, step for step", () => {
    it("the README and the migration header give the same rollback SQL, with the same timestamp as the journal", () => {
        assert.equal(normalize(readmeRollbackSql()), normalize(headerRollbackSql()));
        assert.ok(readmeRollbackSql().includes(`"created_at" = ${MIGRATION_TIMESTAMP}`), "the timestamp in the docs is the journal's");
        assert.ok(MIGRATION.includes(String(MIGRATION_TIMESTAMP)));
    });

    it("it is one transaction, and the README says the things that matter: code first, backup, forget the record, verify", () => {
        const sql = readmeRollbackSql();
        assert.match(sql, /^BEGIN;/m);
        assert.match(sql, /^COMMIT;/m);
        assert.match(sql, /DELETE FROM "drizzle"\."__drizzle_migrations"/);
        for (const phrase of [
            "Roll the application code back first",
            "Take a backup",
            "Run this as one transaction",
            "newest** row of `drizzle.__drizzle_migrations`",
            "skips** migration 0010",
            "If you forgot the `DELETE`",
        ]) {
            assert.ok(README.includes(phrase), `README says: ${phrase}`);
        }
        for (const phrase of ["Roll the application code back FIRST", "makes drizzle forget that this migration ran", "SKIPS this migration"]) {
            assert.ok(MIGRATION.includes(phrase), `the migration header says: ${phrase}`);
        }
    });

    describe("on a database migrated by drizzle's own migrator", () => {
        let client: PGlite;
        let db: ReturnType<typeof drizzle>;
        const columns = async () =>
            (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'shopify_orders' AND column_name LIKE 'purchase_email_%'`)).rows.length;
        const recorded = async () => (await client.query(`SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${MIGRATION_TIMESTAMP}`)).rows.length;
        const migrateUp = () => migrate(db, { migrationsFolder: MIGRATIONS_DIR });

        before(async () => {
            client = new PGlite();
            db = drizzle(client);
            await migrateUp();
        });
        after(async () => {
            await client.close();
        });

        it("the full migration adds 7 columns and is recorded", async () => {
            assert.equal(await columns(), 7);
            assert.equal(await recorded(), 1);
        });

        it("THE HAZARD: dropping the columns but leaving drizzle's record makes the next deploy skip the migration for good", async () => {
            const withoutForgetting = readmeRollbackSql().replace(/DELETE FROM[^;]*;/, "");
            await client.exec(withoutForgetting);
            assert.equal(await columns(), 0);
            assert.equal(await recorded(), 1, "drizzle still believes 0010 ran");

            await migrateUp();
            assert.equal(await columns(), 0, "so a redeploy does NOT bring the columns back: every paid order would then fail");
        });

        it("the README's recovery for that mistake works: delete the record, deploy again, the columns return", async () => {
            await client.exec(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${MIGRATION_TIMESTAMP};`);
            await migrateUp();
            assert.equal(await columns(), 7);
            assert.equal(await recorded(), 1);
        });

        it("THE DOCUMENTED PROCEDURE, exactly as written: rollback leaves no columns and no record, and the next deploy restores both", async () => {
            await client.exec(readmeRollbackSql());
            assert.equal(await columns(), 0);
            assert.equal(await recorded(), 0, "the README's last statement made drizzle forget");

            await migrateUp();
            assert.equal(await columns(), 7);
            assert.equal(await recorded(), 1);
        });

        it("the README's verification queries return what it says they do", async () => {
            const verify = [...README.matchAll(/`(SELECT [^`]*(?:information_schema\.columns|__drizzle_migrations)[^`]*)`/g)].map((match) => match[1]!);
            assert.equal(verify.length, 2);
            await client.exec(readmeRollbackSql());
            assert.equal((await client.query(verify[0]!)).rows.length, 0);
            assert.equal((await client.query(verify[1]!)).rows.length, 0);
        });
    });
});

describe("the monitoring and requeue SQL in the README, run verbatim", () => {
    let database: TestDatabase;
    before(async () => {
        database = await createTestDatabase();
    });
    after(async () => {
        await database.close();
    });

    it("the monitor query finds an abandoned email, and the requeue SQL gets it delivered", async () => {
        const monitor = readmeSqlBlocks().find((block) => block.includes("SELECT shopify_order_id"))!;
        const requeue = readmeSqlBlocks().find((block) => block.includes("UPDATE shopify_orders"))!.replace("<shopify order id>", "7001");
        const log = createCapturingLogger();
        await recordShopifyWebhookEvent(database.app, {
            webhookId: "wh-7001",
            topic: "orders/paid",
            payloadJson: shopifyOrderPayload({ orderId: 7001, email: "buyer7001@example.com", items: [{ productId: PRODUCT.large, quantity: 1 }] }),
            shopDomain: TEST_SHOP_DOMAIN,
            log,
        });
        const rejecting = createFakeSmtp({ alwaysFail: smtpError("550 5.1.1 no such user", { code: "EENVELOPE", responseCode: 550 }) });
        await runPurchaseEmailOutbox(database.db, log, { createTransport: rejecting.createTransport });

        const seen = await database.rows<{ shopify_order_id: string; purchase_email_status: string }>(monitor);
        assert.deepEqual(seen.map((row) => [row.shopify_order_id, row.purchase_email_status]), [["7001", "abandoned"]]);

        await database.rows(requeue);
        const accepting = createFakeSmtp();
        await runPurchaseEmailOutbox(database.db, log, { createTransport: accepting.createTransport });
        assert.equal(accepting.sent.length, 1);
        assert.equal((await outboxRow(database, 7001)).purchase_email_status, "sent");
    });
});

describe("the README stays in step with the code", () => {
    it("documents every alert key the code emits", () => {
        for (const key of Object.values(PURCHASE_EMAIL_ALERT)) assert.ok(README.includes(`\`${key}\``), `README documents ${key}`);
    });

    it("explains every abandoned-note prefix, and the attempt count", () => {
        for (const prefix of ["Permanent failure", "Gave up after", "Delivery outcome unknown", "A worker stopped while sending", "Skipped:"]) {
            assert.ok(README.includes(prefix), prefix);
        }
        assert.ok(README.includes(`Gave up after ${PURCHASE_EMAIL_MAX_ATTEMPTS} attempts`));
    });

    it("the Docker stop grace period is comfortably longer than the shutdown grace the code waits", () => {
        const appBlock = COMPOSE.slice(COMPOSE.indexOf("\n  app:"), COMPOSE.indexOf("\n  studio:"));
        const seconds = Number(/stop_grace_period:\s*(\d+)s/.exec(appBlock)?.[1]);
        assert.ok(Number.isFinite(seconds), "the app service sets stop_grace_period");
        assert.ok(seconds * 1000 >= PURCHASE_EMAIL_SHUTDOWN_GRACE_MS + 10_000, `${seconds}s must exceed the ${PURCHASE_EMAIL_SHUTDOWN_GRACE_MS / 1000}s shutdown wait plus the pool close`);
        assert.ok(!/stop_grace_period/.test(COMPOSE.slice(0, COMPOSE.indexOf("\n  app:"))), "only the app service was changed, not the database");
    });

    it("the failure classes in the README match what the delivery tests prove (the shapes are anchored to real nodemailer)", () => {
        for (const cls of ["`retry`", "`unknown_delivery`", "`rejected`"]) assert.ok(README.includes(cls), cls);
        assert.equal(smtpErrors.connectionRefused().code, "ESOCKET");
    });
});
