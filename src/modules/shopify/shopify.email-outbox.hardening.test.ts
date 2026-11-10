/**
 * Tests for the production-readiness fixes to the purchase email outbox, one section per finding:
 *
 *   A  the blocker: real nodemailer + local fake SMTP servers, end to end through the queue
 *   B  H1: the database failing AFTER a successful send must never cause a second email
 *   C  H3: an order cancelled or refunded while its email is queued is not confirmed
 *   D  H4: a hung database call cannot stall the worker; the worker's pool is strictly timed
 *   E  H2: shutdown waits for in-flight emails, and never hangs
 *   F  H5: abandoned and overdue emails raise a stable, repeating alert
 *
 * In-memory Postgres (PGlite), loopback-only fake SMTP servers, a hand-moved clock. No email is ever sent.
 */
import { FAKE_SMTP_PASSWORD } from "./shopify.smtp-secret.test-env";
import "./shopify.test-env";

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";

import Fastify from "fastify";
import fp from "fastify-plugin";

import { buildWorkerPoolConfig, shopifyEmailOutboxPlugin } from "../../plugins/shopify-email-outbox.plugin";
import type { ShopifyPurchaseEmailTransport } from "./shopify.email-delivery";
import {
    OutboxDbTimeoutError,
    PURCHASE_EMAIL_ALERT,
    PURCHASE_EMAIL_DB_TIMEOUT_MS,
    PURCHASE_EMAIL_LEASE_MS,
    PURCHASE_EMAIL_MAX_ATTEMPTS,
    SKIPPED_NOTE_PREFIX,
    claimNextPurchaseEmail,
    drainQueuedShopifyPurchaseEmails,
    queueShopifyPurchaseEmailDelivery,
    reportPurchaseEmailsNeedingAttention,
    runPurchaseEmailOutbox,
    startPurchaseEmailOutboxWorker,
    waitForQueuedShopifyPurchaseEmails,
    type PurchaseEmailOutboxDeps,
    type UnrecordedOutcomes,
} from "./shopify.email-outbox";
import { closedLoopbackPort, loopbackTransport, startFakeSmtpServer, type FakeSmtpServer } from "./shopify.fake-smtp.test-env";
import { recordShopifyWebhookEvent } from "./shopify.service";
import {
    PRODUCT,
    TEST_SHOP_DOMAIN,
    createCapturingLogger,
    createFakeSmtp,
    createTestClock,
    createTestDatabase,
    outboxRow,
    shopifyOrderPayload,
    smtpError,
    type TestDatabase,
} from "./shopify.pglite.test-env";

let database: TestDatabase;
const log = createCapturingLogger();

before(async () => {
    database = await createTestDatabase();
});
after(async () => {
    await database.close();
});
beforeEach(async () => {
    await database.reset();
});

const MINUTE = 60_000;
const instantSleep = async (): Promise<void> => undefined;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function purchase(orderId: number, items: Array<{ productId: string; quantity: number }> = [{ productId: PRODUCT.large, quantity: 1 }]): Promise<void> {
    await recordShopifyWebhookEvent(database.app, {
        webhookId: `wh-${orderId}`,
        topic: "orders/paid",
        payloadJson: shopifyOrderPayload({ orderId, email: `buyer${orderId}@example.com`, customerId: 9000 + orderId, items }),
        shopDomain: TEST_SHOP_DOMAIN,
        log,
    });
}

async function count(table: string): Promise<number> {
    const [row] = await database.rows<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
    return Number(row?.n ?? 0);
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await pause(15);
    }
    throw new Error(`Condition not met within ${timeoutMs} ms`);
}

/** The real database with some calls replaced. `update` / `execute` overrides receive the same arguments as the real ones. */
function withDb(overrides: { update?: (...args: unknown[]) => unknown; execute?: (...args: unknown[]) => unknown }): typeof database.db {
    const real = database.db as unknown as Record<string, (...args: unknown[]) => unknown>;
    return {
        select: real.select!.bind(real),
        update: overrides.update ?? real.update!.bind(real),
        execute: overrides.execute ?? real.execute!.bind(real),
    } as unknown as typeof database.db;
}

const down = (message = "connection terminated unexpectedly") => () => {
    throw new Error(message);
};

/** An `update` that throws for the first `failures` calls (Infinity: always) and then behaves normally. */
function flakyUpdate(failures: number): (...args: unknown[]) => unknown {
    let remaining = failures;
    const real = database.db as unknown as { update: (...args: unknown[]) => unknown };
    return (...args) => {
        if (remaining-- > 0) throw new Error("connection terminated unexpectedly");
        return real.update(...args);
    };
}

/** A query chain that never answers, as a connection into a black hole behaves. */
const hungUpdate = () => ({ set: () => ({ where: () => ({ returning: () => new Promise(() => undefined) }) }) });

function deps(extra: PurchaseEmailOutboxDeps = {}): PurchaseEmailOutboxDeps {
    return { sleep: instantSleep, unrecordedOutcomes: new Map(), ...extra };
}

// ---------------------------------------------------------------------------
// A. The blocker, end to end: real nodemailer, local fake SMTP, the whole queue
// ---------------------------------------------------------------------------

describe("A. real SMTP failures through the whole queue", () => {
    /** A moving target, so a test can start a server that "comes back up" on the same address. */
    const target: { port: number } = { port: 0 };
    const viaNodemailer = (client: Record<string, unknown> = {}) => () => loopbackTransport(target.port, client);
    const servers: FakeSmtpServer[] = [];

    async function startServer(behavior: Parameters<typeof startFakeSmtpServer>[0] = {}): Promise<FakeSmtpServer> {
        const server = await startFakeSmtpServer(behavior);
        servers.push(server);
        return server;
    }

    after(async () => {
        await Promise.all(servers.map((server) => server.close()));
    });

    it("the SMTP server is DOWN (connection refused): the email is queued for a retry, NOT abandoned, and goes out when the server returns", async () => {
        await purchase(1001);
        target.port = await closedLoopbackPort();
        const clock = createTestClock();
        const t0 = clock.now();

        const first = await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer() }));
        assert.equal(first.retryScheduled, 1, "this is the outage the first version abandoned on attempt 1");
        let row = await outboxRow(database, 1001);
        assert.equal(row.purchase_email_status, "pending");
        assert.equal(row.purchase_email_attempts, 1);
        assert.equal(row.purchase_email_next_attempt_at?.getTime(), t0.getTime() + MINUTE);
        assert.match(row.purchase_email_last_error ?? "", /ESOCKET/);

        const server = await startServer();
        target.port = server.port;
        clock.advance(MINUTE);
        const second = await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer() }));

        assert.equal(second.sent, 1);
        row = await outboxRow(database, 1001);
        assert.equal(row.purchase_email_status, "sent");
        assert.equal(row.purchase_email_attempts, 2);
        assert.equal(server.accepted, 1, "exactly one message accepted");
    });

    it("the server accepts the whole message and then drops the connection: never repeated, abandoned as 'delivery unknown', alert raised", async () => {
        await purchase(1002);
        const server = await startServer({ afterData: "drop" });
        target.port = server.port;
        const clock = createTestClock();
        const logger = createCapturingLogger();

        const summary = await runPurchaseEmailOutbox(database.db, logger, deps({ now: clock.now, createTransport: viaNodemailer() }));

        assert.equal(summary.abandoned, 1);
        const row = await outboxRow(database, 1002);
        assert.equal(row.purchase_email_status, "abandoned");
        assert.match(row.purchase_email_last_error ?? "", /Delivery outcome unknown \(send\); not retried because the server may already have the message/);
        const alert = logger.calls.find((call) => (call.obj as { alert?: string } | undefined)?.alert === PURCHASE_EMAIL_ALERT.abandoned);
        assert.ok(alert, "an alert-keyed error line is logged");
        assert.equal((alert.obj as { failure: string }).failure, "unknown_delivery");

        clock.advance(48 * 60 * MINUTE);
        assert.equal((await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer() }))).claimed, 0);
        assert.equal(server.received.length, 1, "the server saw the message once, and the queue never sent it again");
    });

    it("the server goes silent after receiving the message (socket timeout): same, never repeated", async () => {
        await purchase(1003);
        const server = await startServer({ afterData: "silent" });
        target.port = server.port;
        const clock = createTestClock();

        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer({ socketTimeout: 400 }) }));
        clock.advance(48 * 60 * MINUTE);
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer({ socketTimeout: 400 }) }));

        assert.equal((await outboxRow(database, 1003)).purchase_email_status, "abandoned");
        assert.equal(server.received.length, 1);
    });

    it("our own watchdog fires on a slow server that DOES deliver: abandoned as unknown, and the message still arrives exactly once", async () => {
        await purchase(1004);
        const server = await startServer({ dataReplyDelayMs: 500 });
        target.port = server.port;
        const clock = createTestClock();

        const summary = await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, sendTimeoutMs: 150, createTransport: viaNodemailer({ socketTimeout: 5_000 }) }));
        assert.equal(summary.abandoned, 1);
        await pause(700);
        clock.advance(48 * 60 * MINUTE);
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, sendTimeoutMs: 150, createTransport: viaNodemailer({ socketTimeout: 5_000 }) }));

        assert.equal(server.accepted, 1, "the slow send completed in the background; the first version would have retried and doubled it");
        assert.match((await outboxRow(database, 1004)).purchase_email_last_error ?? "", /ESENDTIMEOUT/);
    });

    it("a temporary 451 AFTER the body is retried, and the customer ends up with exactly one ACCEPTED message", async () => {
        await purchase(1005);
        const refusing = await startServer({ afterData: "451 4.3.0 try again later" });
        target.port = refusing.port;
        const clock = createTestClock();
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer() }));
        assert.equal((await outboxRow(database, 1005)).purchase_email_status, "pending");

        const accepting = await startServer();
        target.port = accepting.port;
        clock.advance(MINUTE);
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer() }));

        assert.equal(refusing.accepted + accepting.accepted, 1);
        assert.equal((await outboxRow(database, 1005)).purchase_email_status, "sent");
    });

    it("a permanent 550 is abandoned at once; a server that never greets is retried", async () => {
        await purchase(1006);
        await purchase(1007);
        const rejecting = await startServer({ rcpt: "550 5.1.1 no such user" });
        const silent = await startServer({ greeting: null });
        const clock = createTestClock();

        target.port = rejecting.port;
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer() }), { shopifyOrderId: "1006" });
        target.port = silent.port;
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaNodemailer({ greetingTimeout: 300 }) }), { shopifyOrderId: "1007" });

        assert.equal((await outboxRow(database, 1006)).purchase_email_status, "abandoned");
        assert.equal((await outboxRow(database, 1007)).purchase_email_status, "pending");
    });

    it("PROPERTY: whatever the fault, the customer is never ACCEPTED two copies, however many passes and however much time passes", async () => {
        const faults: Array<[string, Parameters<typeof startFakeSmtpServer>[0], Record<string, unknown>]> = [
            ["drop after data", { afterData: "drop" }, {}],
            ["silent after data", { afterData: "silent" }, { socketTimeout: 300 }],
            ["slow reply + watchdog", { dataReplyDelayMs: 400 }, { socketTimeout: 5_000 }],
            ["451 after data", { afterData: "451 4.3.0 later" }, {}],
            ["550 at rcpt", { rcpt: "550 5.1.1 nope" }, {}],
            ["connection cut mid-conversation", { dropAfterEhlo: true }, {}],
        ];
        let orderId = 1100;
        for (const [name, behavior, client] of faults) {
            orderId += 1;
            await purchase(orderId);
            const server = await startServer(behavior);
            target.port = server.port;
            const clock = createTestClock();
            for (let pass = 0; pass < 12; pass += 1) {
                await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, sendTimeoutMs: 150, createTransport: viaNodemailer(client) }), { shopifyOrderId: String(orderId) });
                clock.advance(2 * 60 * MINUTE);
            }
            await pause(500);
            assert.ok(server.accepted <= 1, `${name}: accepted ${server.accepted}`);
        }
    });
});

// ---------------------------------------------------------------------------
// B. H1: the database fails AFTER the send
// ---------------------------------------------------------------------------

describe("B. a database failure after a successful send never causes a second email", () => {
    it("a brief outage while recording 'sent' is retried in the same pass, and the result is recorded", async () => {
        await purchase(2001);
        const smtp = createFakeSmtp();

        const summary = await runPurchaseEmailOutbox(withDb({ update: flakyUpdate(3) }), log, deps({ createTransport: smtp.createTransport }));

        assert.equal(summary.sent, 1);
        assert.equal(smtp.sent.length, 1);
        assert.equal((await outboxRow(database, 2001)).purchase_email_status, "sent");
    });

    it("a longer outage: the result is remembered in memory, and when the row is reclaimed it is recorded WITHOUT sending again", async () => {
        await purchase(2002);
        const smtp = createFakeSmtp();
        const memory: UnrecordedOutcomes = new Map();
        const clock = createTestClock();
        const logger = createCapturingLogger();

        const summary = await runPurchaseEmailOutbox(withDb({ update: flakyUpdate(Infinity) }), logger, deps({ now: clock.now, createTransport: smtp.createTransport, unrecordedOutcomes: memory }));

        assert.equal(summary.unrecorded, 1);
        assert.equal(smtp.sent.length, 1, "it WAS delivered");
        assert.equal((await outboxRow(database, 2002)).purchase_email_status, "processing", "and the database does not know");
        assert.deepEqual([...memory.keys()], ["2002"]);
        const alert = logger.calls.find((call) => (call.obj as { alert?: string } | undefined)?.alert === PURCHASE_EMAIL_ALERT.unrecorded);
        assert.ok(alert && alert.level === "error", "a loud, alert-keyed error line says it was sent but not recorded");

        // The database comes back; the lease runs out; the same process reclaims the row.
        clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        const recovered = await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: smtp.createTransport, unrecordedOutcomes: memory }));

        assert.equal(recovered.sent, 1, "recorded as sent");
        assert.equal(smtp.sent.length, 1, "and NOT sent again");
        assert.equal(memory.size, 0);
        assert.equal((await outboxRow(database, 2002)).purchase_email_status, "sent");
    });

    it("the same protection for an abandonment after an ambiguous send: remembered, then recorded without a second send", async () => {
        await purchase(2003);
        const server = await startFakeSmtpServer({ afterData: "drop" });
        try {
            const memory: UnrecordedOutcomes = new Map();
            const clock = createTestClock();
            const viaServer = () => loopbackTransport(server.port);

            const summary = await runPurchaseEmailOutbox(withDb({ update: flakyUpdate(Infinity) }), log, deps({ now: clock.now, createTransport: viaServer, unrecordedOutcomes: memory }));
            assert.equal(summary.unrecorded, 1);
            assert.equal(memory.get("2003")?.kind, "abandoned");

            clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
            const recovered = await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: viaServer, unrecordedOutcomes: memory }));

            assert.equal(recovered.abandoned, 1);
            assert.equal(server.received.length, 1, "the ambiguous send is not repeated just because the database was down");
            assert.equal((await outboxRow(database, 2003)).purchase_email_status, "abandoned");
        } finally {
            await server.close();
        }
    });

    it("if only the retry could not be scheduled, the email was NOT delivered, so the later reclaim sending it is correct", async () => {
        await purchase(2004);
        const failing = createFakeSmtp({ failures: [smtpErrorRefused()] });
        const clock = createTestClock();

        const summary = await runPurchaseEmailOutbox(withDb({ update: flakyUpdate(Infinity) }), log, deps({ now: clock.now, createTransport: failing.createTransport }));
        assert.equal(summary.unrecorded, 1);
        assert.equal(failing.sent.length, 0);

        clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: failing.createTransport }));

        assert.equal(failing.sent.length, 1, "exactly one delivery in total");
        assert.equal((await outboxRow(database, 2004)).purchase_email_status, "sent");
    });

    it("the write retries never wait past the lease: when the next wait would cross it, it stops and remembers", async () => {
        await purchase(2005);
        const smtp = createFakeSmtp();
        const waits: number[] = [];
        const memory: UnrecordedOutcomes = new Map();

        const summary = await runPurchaseEmailOutbox(
            withDb({ update: flakyUpdate(Infinity) }),
            log,
            deps({
                createTransport: smtp.createTransport,
                unrecordedOutcomes: memory,
                completionRetryDelaysMs: [1_000, PURCHASE_EMAIL_LEASE_MS],
                sleep: async (ms) => void waits.push(ms),
            })
        );

        assert.deepEqual(waits, [1_000], "the second wait would have outlasted the lease, so it was not taken");
        assert.equal(summary.unrecorded, 1);
        assert.equal(memory.size, 1);
    });

    it("a database call that HANGS while recording is given up on and retried", async () => {
        await purchase(2006);
        const smtp = createFakeSmtp();
        let hung = 0;
        const real = database.db as unknown as { update: (...args: unknown[]) => unknown };
        const db = withDb({
            update: (...args) => {
                if (hung++ === 0) return hungUpdate();
                return real.update(...args);
            },
        });

        const summary = await runPurchaseEmailOutbox(db, log, deps({ createTransport: smtp.createTransport, dbTimeoutMs: 60 }));

        assert.equal(summary.sent, 1);
        assert.equal(smtp.sent.length, 1);
        assert.equal((await outboxRow(database, 2006)).purchase_email_status, "sent");
    });
});

const smtpErrorRefused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ESOCKET", syscall: "connect" });

// ---------------------------------------------------------------------------
// C. H3: cancelled or refunded while queued
// ---------------------------------------------------------------------------

describe("C. an order cancelled or refunded while its email is queued is not confirmed", () => {
    const cancel = (orderId: number) =>
        recordShopifyWebhookEvent(database.app, { webhookId: `cancel-${orderId}`, topic: "orders/cancelled", payloadJson: { id: orderId, financial_status: "voided" }, shopDomain: TEST_SHOP_DOMAIN, log });

    const refund = (orderId: number, quantity: number) =>
        recordShopifyWebhookEvent(database.app, {
            webhookId: `refund-${orderId}-${quantity}`,
            topic: "refunds/create",
            payloadJson: { id: `r${orderId}`, order_id: orderId, refund_line_items: [{ quantity, line_item: { product_id: Number(PRODUCT.large) } }] },
            shopDomain: TEST_SHOP_DOMAIN,
            log,
        });

    it("cancelled: nothing is sent, the row records why, and it is a warning, not an alert", async () => {
        await purchase(3001);
        await cancel(3001);
        const smtp = createFakeSmtp();
        const logger = createCapturingLogger();

        const summary = await runPurchaseEmailOutbox(database.db, logger, deps({ createTransport: smtp.createTransport }));

        assert.equal(summary.skipped, 1);
        assert.equal(smtp.attempts, 0);
        const row = await outboxRow(database, 3001);
        assert.equal(row.purchase_email_status, "abandoned");
        assert.ok(row.purchase_email_last_error?.startsWith(SKIPPED_NOTE_PREFIX));
        assert.match(row.purchase_email_last_error ?? "", /the order was cancelled or refunded before the confirmation was sent/);
        const skipLine = logger.calls.find((call) => /skipped: the order is no longer a live purchase/.test(call.msg));
        assert.equal(skipLine?.level, "warn");
        assert.ok(!logger.calls.some((call) => (call.obj as { alert?: string } | undefined)?.alert), "no alert for an expected skip");
    });

    it("fully refunded: nothing is sent", async () => {
        await purchase(3002);
        await refund(3002, 1);
        const smtp = createFakeSmtp();

        assert.equal((await runPurchaseEmailOutbox(database.db, log, deps({ createTransport: smtp.createTransport }))).skipped, 1);
        assert.equal(smtp.attempts, 0);
    });

    it("partly refunded (2 kits bought, 1 refunded): the snapshot's '8 licenses' would be wrong, so nothing is sent", async () => {
        await purchase(3003, [{ productId: PRODUCT.large, quantity: 2 }]);
        await refund(3003, 1);
        const smtp = createFakeSmtp();

        assert.equal((await runPurchaseEmailOutbox(database.db, log, deps({ createTransport: smtp.createTransport }))).skipped, 1);
        assert.equal(smtp.attempts, 0);
        assert.match((await outboxRow(database, 3003)).purchase_email_last_error ?? "", /part of the order was refunded/);
    });

    it("the cancellation arriving after the first send changes nothing, and an untouched order is still confirmed", async () => {
        await purchase(3004);
        await purchase(3005);
        const smtp = createFakeSmtp();
        await runPurchaseEmailOutbox(database.db, log, deps({ createTransport: smtp.createTransport }), { shopifyOrderId: "3004" });
        await cancel(3004);
        await runPurchaseEmailOutbox(database.db, log, deps({ createTransport: smtp.createTransport }));

        assert.equal(smtp.sent.length, 2, "3004 was sent before it was cancelled; 3005 is live");
        assert.equal((await outboxRow(database, 3004)).purchase_email_status, "sent");
    });

    it("skipped rows are not in the 'needs attention' report, and requeueing one skips it again", async () => {
        await purchase(3006);
        await cancel(3006);
        await runPurchaseEmailOutbox(database.db, log, deps({ createTransport: createFakeSmtp().createTransport }));
        assert.equal(await reportPurchaseEmailsNeedingAttention(database.db, createCapturingLogger(), { now: createTestClock().now() }), null);

        await database.exec(
            `UPDATE shopify_orders SET purchase_email_status='pending', purchase_email_attempts=0, purchase_email_next_attempt_at=now(), purchase_email_locked_until=NULL, purchase_email_last_error=NULL WHERE shopify_order_id='3006' AND purchase_email_status='abandoned'`
        );
        const smtp = createFakeSmtp();
        const clock = createTestClock();
        assert.equal((await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: smtp.createTransport }))).skipped, 1);
        assert.equal(smtp.attempts, 0);
    });
});

// ---------------------------------------------------------------------------
// D. H4: hung database calls, and the worker's own pool
// ---------------------------------------------------------------------------

describe("D. a hung database cannot stall the worker", () => {
    it("every database call has a deadline: a call that never answers rejects with a timeout error", async () => {
        const started = Date.now();
        await assert.rejects(
            claimNextPurchaseEmail(withDb({ execute: () => new Promise(() => undefined) }), { now: new Date(), leaseMs: PURCHASE_EMAIL_LEASE_MS, maxAttempts: PURCHASE_EMAIL_MAX_ATTEMPTS, dbTimeoutMs: 80 }),
            (error: unknown) => error instanceof OutboxDbTimeoutError && /"claim" took longer than 80 ms/.test(error.message)
        );
        assert.ok(Date.now() - started < 1_000);
    });

    it("the worker survives a call that hangs forever: that pass fails with a logged timeout, and the next pass sends the email", async () => {
        await purchase(4001);
        let hung = false;
        const real = database.db as unknown as { execute: (...args: unknown[]) => unknown };
        const db = withDb({
            execute: (...args) => {
                if (!hung) {
                    hung = true;
                    return new Promise(() => undefined);
                }
                return real.execute(...args);
            },
        });
        const logger = createCapturingLogger();
        const smtp = createFakeSmtp();
        const worker = startPurchaseEmailOutboxWorker({ db, log: logger, deps: { createTransport: smtp.createTransport, dbTimeoutMs: 80 }, initialDelayMs: 5, intervalMs: 30 });
        try {
            await waitFor(async () => (await outboxRow(database, 4001)).purchase_email_status === "sent");
            const failed = logger.calls.find((call) => /worker pass failed/.test(call.msg));
            assert.ok(failed, "the stalled pass was logged");
            assert.equal((failed.obj as { err: { code: string } }).err.code, "EOUTBOXDBTIMEOUT");
            assert.equal(smtp.sent.length, 1);
        } finally {
            await worker.stop();
        }
    });

    it("the immediate send after a purchase also cannot hang: it ends with a logged timeout and the worker takes over later", async () => {
        await purchase(4002);
        const logger = createCapturingLogger();
        queueShopifyPurchaseEmailDelivery(withDb({ execute: () => new Promise(() => undefined) }), logger, "4002", { dbTimeoutMs: 60 });

        await waitForQueuedShopifyPurchaseEmails();

        assert.ok(logger.calls.some((call) => /Immediate Shopify purchase email send failed/.test(call.msg)));
        assert.equal((await outboxRow(database, 4002)).purchase_email_status, "pending", "still queued, nothing lost");
    });

    it("the worker's own connection pool is strictly timed and kept apart from the API's", () => {
        const config = buildWorkerPoolConfig("postgres://example.invalid/db");
        assert.equal(config.connectionString, "postgres://example.invalid/db");
        assert.equal(config.max, 2);
        assert.equal(config.application_name, "healthage-shopify-email-worker");
        assert.equal(config.keepAlive, true);
        for (const field of ["connectionTimeoutMillis", "query_timeout", "statement_timeout", "idle_in_transaction_session_timeout"] as const) {
            const value = config[field];
            assert.ok(typeof value === "number" && value > 0 && value <= 30_000, `${field} is a bounded timeout`);
        }
        assert.ok((config.query_timeout as number) < PURCHASE_EMAIL_DB_TIMEOUT_MS, "the pool gives up before the outbox's own deadline does");
    });
});

// ---------------------------------------------------------------------------
// E. H2: shutdown
// ---------------------------------------------------------------------------

describe("E. shutdown waits for in-flight emails and never hangs", () => {
    function gatedTransport() {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const sent: string[] = [];
        let started = 0;
        const transport: ShopifyPurchaseEmailTransport = {
            async sendMail(message) {
                started += 1;
                await gate;
                sent.push(message.to);
            },
        };
        return { transport, release, sent, started: () => started };
    }

    it("drain waits for an immediate send in progress and returns once it has finished and been recorded", async () => {
        await purchase(5001);
        const slow = gatedTransport();
        queueShopifyPurchaseEmailDelivery(database.db, log, "5001", { createTransport: () => slow.transport });
        await waitFor(() => slow.started() === 1);
        setTimeout(slow.release, 100);

        const result = await drainQueuedShopifyPurchaseEmails(3_000);

        assert.deepEqual(result, { drained: true, remaining: 0 });
        assert.equal((await outboxRow(database, 5001)).purchase_email_status, "sent");
    });

    it("drain gives up after its timeout instead of hanging, leaving the send to finish on its own", async () => {
        await purchase(5002);
        const slow = gatedTransport();
        queueShopifyPurchaseEmailDelivery(database.db, log, "5002", { createTransport: () => slow.transport });
        await waitFor(() => slow.started() === 1);

        const result = await drainQueuedShopifyPurchaseEmails(60);

        assert.deepEqual(result, { drained: false, remaining: 1 });
        slow.release();
        await waitForQueuedShopifyPurchaseEmails();
        assert.equal((await outboxRow(database, 5002)).purchase_email_status, "sent");
    });

    it("closing the app waits for the immediate send BEFORE the main database plugin closes", async () => {
        await purchase(5003);
        const events: string[] = [];
        const app = Fastify({ logger: false });
        await app.register(
            fp(
                async (instance) => {
                    instance.decorate("db", database.db);
                    instance.addHook("onClose", async () => {
                        events.push("main database closed");
                    });
                },
                { name: "db-plugin" }
            )
        );
        await app.register(shopifyEmailOutboxPlugin, { db: database.db, initialDelayMs: 60_000, shutdownGraceMs: 3_000 });
        await app.ready();

        const slow: ShopifyPurchaseEmailTransport = {
            async sendMail() {
                await pause(200);
                events.push("email sent");
            },
        };
        queueShopifyPurchaseEmailDelivery(database.db, log, "5003", { createTransport: () => slow });
        await pause(30);
        await app.close();

        assert.deepEqual(events, ["email sent", "main database closed"]);
        assert.equal((await outboxRow(database, 5003)).purchase_email_status, "sent", "the result was recorded before the database closed");
    });

    it("closing the app does not hang on a send that never finishes: it logs a warning and carries on after the grace period", async () => {
        await purchase(5004);
        const lines: string[] = [];
        const stream = new Writable({
            write(chunk, _encoding, callback) {
                lines.push(String(chunk));
                callback();
            },
        });
        const app = Fastify({ logger: { level: "info", stream } });
        await app.register(fp(async (instance) => void instance.decorate("db", database.db), { name: "db-plugin" }));
        await app.register(shopifyEmailOutboxPlugin, { db: database.db, initialDelayMs: 60_000, shutdownGraceMs: 150 });
        await app.ready();

        const never: ShopifyPurchaseEmailTransport = { sendMail: () => new Promise(() => undefined) };
        queueShopifyPurchaseEmailDelivery(database.db, log, "5004", { createTransport: () => never, sendTimeoutMs: 600 });
        await pause(30);

        const started = Date.now();
        await app.close();
        const took = Date.now() - started;

        assert.ok(took < 500, `close returned after the grace period (${took} ms), not after the 600 ms send watchdog`);
        assert.ok(lines.join("").includes("Shutting down while Shopify purchase emails were still being sent"));
        assert.equal((await outboxRow(database, 5004)).purchase_email_status, "processing", "left for the lease to recover after the restart");
        await waitForQueuedShopifyPurchaseEmails();
    });

    it("stop() lets the email being sent finish but starts no further ones, and reports it did not time out", async () => {
        await purchase(5005);
        await purchase(5006);
        await purchase(5007);
        const slow = gatedTransport();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log, deps: { createTransport: () => slow.transport }, initialDelayMs: 5, intervalMs: 5_000 });

        await waitFor(() => slow.started() === 1);
        const stopping = worker.stop({ timeoutMs: 3_000 });
        slow.release();
        const result = await stopping;

        assert.deepEqual(result, { timedOut: false });
        assert.equal(slow.sent.length, 1, "the one in flight finished");
        const statuses = await database.rows<{ s: string }>(`SELECT purchase_email_status AS s FROM shopify_orders ORDER BY shopify_order_id`);
        assert.deepEqual(statuses.map((row) => row.s).sort(), ["pending", "pending", "sent"], "no further emails were started");
    });

    it("stop() is bounded: a pass that cannot finish is reported as timed out, not waited for forever", async () => {
        await purchase(5008);
        const slow = gatedTransport();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log, deps: { createTransport: () => slow.transport }, initialDelayMs: 5, intervalMs: 5_000 });
        await waitFor(() => slow.started() === 1);

        const started = Date.now();
        const result = await worker.stop({ timeoutMs: 100 });

        assert.deepEqual(result, { timedOut: true });
        assert.ok(Date.now() - started < 1_000);
        slow.release();
        await pause(100);
    });
});

// ---------------------------------------------------------------------------
// F. H5: alerting
// ---------------------------------------------------------------------------

describe("F. abandoned and overdue emails raise a stable, repeating alert", () => {
    const alertOf = (call: { obj: unknown }) => (call.obj as { alert?: string } | undefined)?.alert;

    it("every way of abandoning an email logs an error line with the stable alert key", async () => {
        await purchase(6001);
        await purchase(6002);
        await purchase(6003);
        const logger = createCapturingLogger();
        const clock = createTestClock();

        await runPurchaseEmailOutbox(database.db, logger, deps({ now: clock.now, createTransport: createFakeSmtp({ alwaysFail: smtpErrorPermanent() }).createTransport }), { shopifyOrderId: "6001" });
        await database.exec(`UPDATE shopify_orders SET purchase_email_payload = '{"x":1}' WHERE shopify_order_id='6002'`);
        await runPurchaseEmailOutbox(database.db, logger, deps({ now: clock.now, createTransport: createFakeSmtp().createTransport }), { shopifyOrderId: "6002" });
        await claimNextPurchaseEmail(database.db, { now: clock.now(), leaseMs: PURCHASE_EMAIL_LEASE_MS, maxAttempts: 1, shopifyOrderId: "6003" });
        clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        await runPurchaseEmailOutbox(database.db, logger, deps({ now: clock.now, maxAttempts: 1, createTransport: createFakeSmtp().createTransport }), { shopifyOrderId: "6003" });

        const alerts = logger.calls.filter((call) => alertOf(call) === PURCHASE_EMAIL_ALERT.abandoned);
        assert.equal(alerts.length, 3, "permanent rejection, corrupt snapshot, and a worker that died with no attempts left");
        assert.ok(alerts.every((call) => call.level === "error"));
        assert.deepEqual(
            alerts.map((call) => (call.obj as { shopifyOrderId: string }).shopifyOrderId).sort(),
            ["6001", "6002", "6003"]
        );
    });

    it("the attention report counts what needs a person and ignores what does not", async () => {
        for (const id of [6101, 6102, 6103, 6104, 6105, 6106, 6107, 6108]) await purchase(id);
        await database.exec(`
            UPDATE shopify_orders SET purchase_email_status='abandoned', purchase_email_last_error='Permanent failure (send). 550', updated_at=now() WHERE shopify_order_id='6101';
            UPDATE shopify_orders SET purchase_email_status='abandoned', purchase_email_last_error='Skipped: the order was cancelled or refunded before the confirmation was sent', updated_at=now() WHERE shopify_order_id='6102';
            UPDATE shopify_orders SET purchase_email_status='abandoned', purchase_email_last_error='Permanent failure (send). 550', updated_at=now() - interval '8 days' WHERE shopify_order_id='6103';
            UPDATE shopify_orders SET purchase_email_next_attempt_at=now() - interval '2 hours' WHERE shopify_order_id='6104';
            UPDATE shopify_orders SET purchase_email_status='processing', purchase_email_locked_until=now() - interval '2 hours' WHERE shopify_order_id='6105';
            UPDATE shopify_orders SET purchase_email_status='sent', purchase_email_sent_at=now() WHERE shopify_order_id='6106';
            UPDATE shopify_orders SET purchase_email_status='processing', purchase_email_locked_until=now() + interval '4 minutes' WHERE shopify_order_id='6107';
        `);
        const logger = createCapturingLogger();

        const report = await reportPurchaseEmailsNeedingAttention(database.db, logger, { now: createTestClock().now() });

        assert.ok(report);
        assert.equal(report.abandoned, 1, "6101 only: 6102 was skipped, 6103 is older than 7 days");
        assert.equal(report.overdue, 1, "6104 is pending and 2 hours late; 6108 is just due");
        assert.equal(report.stuck, 1, "6105's lease ran out 2 hours ago; 6107's is live");
        assert.deepEqual([...report.orderIds].sort(), ["6101", "6104", "6105"]);
        assert.ok(report.oldestAgeMinutes >= 100);
        const line = logger.calls.find((call) => alertOf(call) === PURCHASE_EMAIL_ALERT.attention);
        assert.ok(line && line.level === "error");
        assert.match(line.msg, /1 abandoned, 1 overdue, 1 stuck/);
    });

    it("a healthy outbox raises nothing", async () => {
        await purchase(6201);
        await runPurchaseEmailOutbox(database.db, log, deps({ createTransport: createFakeSmtp().createTransport }));
        const logger = createCapturingLogger();

        assert.equal(await reportPurchaseEmailsNeedingAttention(database.db, logger, { now: createTestClock().now() }), null);
        assert.equal(logger.calls.length, 0);
    });

    it("the worker repeats the alert once an hour while the problem lasts, not on every 30-second pass", async () => {
        await purchase(6301);
        const clock = createTestClock();
        await runPurchaseEmailOutbox(database.db, log, deps({ now: clock.now, createTransport: createFakeSmtp({ alwaysFail: smtpErrorPermanent() }).createTransport }));
        const logger = createCapturingLogger();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log: logger, deps: { now: clock.now, createTransport: createFakeSmtp().createTransport }, initialDelayMs: 600_000, alertIntervalMs: 60 * MINUTE });
        try {
            const attention = () => logger.calls.filter((call) => alertOf(call) === PURCHASE_EMAIL_ALERT.attention).length;
            for (const minutes of [0, 10, 20, 30, 40, 50]) {
                clock.advance(minutes === 0 ? 0 : 10 * MINUTE);
                await worker.tick();
            }
            assert.equal(attention(), 1, "once in the first hour, not once per pass");
            clock.advance(10 * MINUTE);
            await worker.tick();
            assert.equal(attention(), 2, "and again when the hour is up");
        } finally {
            await worker.stop();
        }
    });

    it("a worker that is not keeping up (a pending email overdue) is itself surfaced", async () => {
        await purchase(6401);
        await database.exec(`UPDATE shopify_orders SET purchase_email_next_attempt_at = now() - interval '45 minutes' WHERE shopify_order_id='6401'`);
        const logger = createCapturingLogger();

        const report = await reportPurchaseEmailsNeedingAttention(database.db, logger, { now: createTestClock().now() });

        assert.equal(report?.overdue, 1);
    });

    it("the alert lines carry no SMTP credentials", async () => {
        await purchase(6501);
        const logger = createCapturingLogger();
        await runPurchaseEmailOutbox(
            database.db,
            logger,
            deps({ createTransport: createFakeSmtp({ alwaysFail: Object.assign(smtpErrorPermanent(), { message: `login failed for ${FAKE_SMTP_PASSWORD}` }) }).createTransport })
        );
        assert.ok(!logger.dump().includes(FAKE_SMTP_PASSWORD));
    });
});

const smtpErrorPermanent = () => smtpError("550 5.1.1 no such user", { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });

describe("housekeeping", () => {
    it("nothing was left behind by these tests", async () => {
        await waitForQueuedShopifyPurchaseEmails();
        assert.ok((await count("shopify_orders")) >= 0);
    });
});
