/**
 * Tests of the durable purchase-email outbox: atomic queueing, backoff, retry exhaustion, crash recovery, concurrent
 * workers, duplicate prevention, the worker loop, and what reaches the logs.
 *
 * Real in-memory Postgres (PGlite) with the project's migrations; mocked SMTP; a hand-moved clock. No email is sent.
 *
 * About the concurrency tests: PGlite runs one connection, so statements from competing workers interleave but never
 * overlap. These tests therefore prove the claim's LOGIC (one statement, re-checks eligibility, one winner, no row served
 * twice). The row-lock behaviour of `FOR UPDATE SKIP LOCKED` across real connections is Postgres's own guarantee and is not
 * exercised here; see the report for the recommended staging check.
 */
import { FAKE_SMTP_PASSWORD } from "./shopify.smtp-secret.test-env";
import "./shopify.test-env";

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";

import Fastify from "fastify";
import fp from "fastify-plugin";

import { shopifyEmailOutboxPlugin } from "../../plugins/shopify-email-outbox.plugin";
import {
    PURCHASE_EMAIL_LEASE_MS,
    PURCHASE_EMAIL_MAX_ATTEMPTS,
    claimNextPurchaseEmail,
    enqueueShopifyPurchaseEmail,
    processClaimedPurchaseEmail,
    purchaseEmailBackoffMs,
    runPurchaseEmailOutbox,
    startPurchaseEmailOutboxWorker,
    type PurchaseEmailOutboxDeps,
} from "./shopify.email-outbox";
import type { ShopifyPurchaseEmailTransport } from "./shopify.email-delivery";
import type { ShopifyPurchaseEmail } from "./shopify.purchase-email";
import { recordShopifyWebhookEvent } from "./shopify.service";
import { smtpErrors } from "./shopify.fake-smtp.test-env";
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
    type FakeSmtp,
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

/** A paid Large Venue Kit order from its own customer. The webhook queues the email in the database; nothing is sent. */
async function purchase(orderId: number, overrides: { items?: Array<{ productId: string; quantity: number }>; cancelledAt?: string } = {}): Promise<ShopifyPurchaseEmail | null> {
    const result = await recordShopifyWebhookEvent(database.app, {
        webhookId: `wh-${orderId}`,
        topic: "orders/paid",
        payloadJson: shopifyOrderPayload({
            orderId,
            email: `buyer${orderId}@example.com`,
            customerId: 9000 + orderId,
            items: overrides.items ?? [{ productId: PRODUCT.large, quantity: 1 }],
            cancelledAt: overrides.cancelledAt,
        }),
        shopDomain: TEST_SHOP_DOMAIN,
        log,
    });
    return result.purchaseEmail;
}

const run = (smtp: FakeSmtp, deps: PurchaseEmailOutboxDeps = {}, options: { shopifyOrderId?: string; limit?: number } = {}, logger = log) =>
    runPurchaseEmailOutbox(database.db, logger, { createTransport: smtp.createTransport, ...deps }, options);

async function count(table: string): Promise<number> {
    const [row] = await database.rows<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
    return Number(row?.n ?? 0);
}

const claimOnce = (clock: { now(): Date }, options: { shopifyOrderId?: string; maxAttempts?: number } = {}) =>
    claimNextPurchaseEmail(database.db, {
        now: clock.now(),
        leaseMs: PURCHASE_EMAIL_LEASE_MS,
        maxAttempts: options.maxAttempts ?? PURCHASE_EMAIL_MAX_ATTEMPTS,
        shopifyOrderId: options.shopifyOrderId,
    });

// ---------------------------------------------------------------------------
// Atomic queueing
// ---------------------------------------------------------------------------

describe("the email is queued atomically with the workspace and licenses", () => {
    it("a paid order is 'pending' with its snapshot as soon as the transaction commits, and nothing has been sent", async () => {
        const email = await purchase(1001);

        assert.ok(email);
        const row = await outboxRow(database, 1001);
        assert.equal(row.purchase_email_status, "pending");
        assert.equal(row.purchase_email_attempts, 0);
        assert.ok(row.purchase_email_next_attempt_at);
        assert.equal(row.purchase_email_sent_at, null);
        assert.equal(row.purchase_email_locked_until, null);
        assert.equal(row.purchase_email_payload?.licensesAdded, 4);
        assert.equal(row.purchase_email_payload?.recipientEmail, "buyer1001@example.com");
        assert.equal(row.purchase_email_payload?.scenario, "new_workspace");
        assert.equal(await count("workspaces"), 1);
    });

    it("if the queue write cannot be made, NOTHING commits: no workspace, no order, no processed marker, and Shopify's retry then works", async () => {
        await database.exec(`
            CREATE FUNCTION test_refuse_outbox_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.purchase_email_status = 'pending' THEN RAISE EXCEPTION 'test: outbox write refused'; END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER test_refuse_outbox_write BEFORE UPDATE ON shopify_orders FOR EACH ROW EXECUTE FUNCTION test_refuse_outbox_write();
        `);
        try {
            await assert.rejects(purchase(1002));
            assert.equal(await count("workspaces"), 0);
            assert.equal(await count("workspace_members"), 0);
            assert.equal(await count("shopify_orders"), 0);
            assert.equal(await count("billing_events"), 0, "the webhook is not marked processed, so Shopify's retry is not skipped");
        } finally {
            await database.exec(`DROP TRIGGER test_refuse_outbox_write ON shopify_orders; DROP FUNCTION test_refuse_outbox_write();`);
        }

        assert.ok(await purchase(1002), "the replay now succeeds");
        assert.equal(await count("workspaces"), 1);
        assert.equal((await outboxRow(database, 1002)).purchase_email_status, "pending");
    });

    it("orders that allocate nothing are never queued: unsupported products and already-cancelled orders stay 'none'", async () => {
        assert.equal(await purchase(1003, { items: [{ productId: PRODUCT.unrelated, quantity: 2 }] }), null);
        assert.equal(await purchase(1004, { cancelledAt: "2026-11-02T11:00:00.000Z" }), null);

        for (const orderId of [1003, 1004]) {
            const row = await outboxRow(database, orderId);
            assert.equal(row.purchase_email_status, "none");
            assert.equal(row.purchase_email_payload, null);
        }
        const smtp = createFakeSmtp();
        const summary = await run(smtp);
        assert.equal(summary.claimed, 0);
        assert.equal(smtp.attempts, 0);
    });

    it("queueing twice is a no-op: a pending or sent email is never reset or doubled", async () => {
        const email = (await purchase(1005))!;
        const [{ id }] = await database.rows<{ id: string }>(`SELECT id FROM shopify_orders WHERE shopify_order_id = '1005'`);

        assert.equal(await enqueueShopifyPurchaseEmail(database.db, log, { shopifyOrderRecordId: id!, email }), false);

        const smtp = createFakeSmtp();
        await run(smtp);
        assert.equal((await outboxRow(database, 1005)).purchase_email_status, "sent");
        assert.equal(await enqueueShopifyPurchaseEmail(database.db, log, { shopifyOrderRecordId: id!, email }), false);
        assert.equal((await outboxRow(database, 1005)).purchase_email_status, "sent", "a sent email stays sent");
        await run(smtp, { now: () => new Date(Date.now() + 24 * 60 * MINUTE) });
        assert.equal(smtp.sent.length, 1);
    });

    it("an invalid snapshot is refused and logged, without failing the order", async () => {
        const email = (await purchase(1006))!;
        await purchase(1007, { items: [{ productId: PRODUCT.unrelated, quantity: 1 }] });
        const [{ id }] = await database.rows<{ id: string }>(`SELECT id FROM shopify_orders WHERE shopify_order_id = '1007'`);
        const logger = createCapturingLogger();

        assert.equal(await enqueueShopifyPurchaseEmail(database.db, logger, { shopifyOrderRecordId: id!, email: { ...email, licensesAdded: 0 } }), false);

        assert.equal((await outboxRow(database, 1007)).purchase_email_status, "none");
        assert.ok(logger.calls.some((call) => call.level === "error" && /failed validation/.test(call.msg)));
    });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe("sending", () => {
    it("claims, sends once and records 'sent'", async () => {
        await purchase(2001);
        const smtp = createFakeSmtp();
        const clock = createTestClock();

        const summary = await run(smtp, { now: clock.now });

        assert.equal(summary.claimed, 1);
        assert.equal(summary.sent, 1);
        assert.equal(smtp.sent.length, 1);
        assert.equal(smtp.sent[0]?.to, "buyer2001@example.com");
        assert.equal(smtp.sent[0]?.subject, "Your HealthAge Large Venue Kit Purchase Is Confirmed!");
        const row = await outboxRow(database, 2001);
        assert.equal(row.purchase_email_status, "sent");
        assert.equal(row.purchase_email_attempts, 1);
        assert.equal(row.purchase_email_sent_at?.getTime(), clock.now().getTime());
        assert.equal(row.purchase_email_locked_until, null);
        assert.equal(row.purchase_email_last_error, null);
    });

    it("a sent email is never sent again, however many passes or however much time goes by", async () => {
        await purchase(2002);
        const smtp = createFakeSmtp();
        const clock = createTestClock();

        await run(smtp, { now: clock.now });
        for (let pass = 0; pass < 5; pass += 1) {
            clock.advance(24 * 60 * MINUTE);
            const summary = await run(smtp, { now: clock.now });
            assert.equal(summary.claimed, 0);
        }
        assert.equal(smtp.sent.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

describe("retrying temporary SMTP failures with exponential backoff", () => {
    it("the waits are 1, 2, 4, 8, 16, 32, then 60 minutes (capped)", () => {
        assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((failed) => purchaseEmailBackoffMs(failed) / MINUTE), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
    });

    it("a failed attempt is rescheduled, is not retried early, and succeeds on a later pass with exactly one message sent", async () => {
        await purchase(3001);
        const smtp = createFakeSmtp({ failures: [smtpErrors.connectionRefused(), smtpError("421 try again later", { responseCode: 421 }), null] });
        const clock = createTestClock();

        const t1 = clock.now();
        assert.equal((await run(smtp, { now: clock.now })).retryScheduled, 1);
        let row = await outboxRow(database, 3001);
        assert.equal(row.purchase_email_status, "pending");
        assert.equal(row.purchase_email_attempts, 1);
        assert.equal(row.purchase_email_next_attempt_at?.getTime(), t1.getTime() + 1 * MINUTE);
        assert.equal(row.purchase_email_locked_until, null);
        assert.match(row.purchase_email_last_error ?? "", /ESOCKET/);

        clock.advance(30_000);
        assert.equal((await run(smtp, { now: clock.now })).claimed, 0, "not due yet");
        assert.equal(smtp.attempts, 1);

        clock.advance(30_000);
        const t2 = clock.now();
        assert.equal((await run(smtp, { now: clock.now })).retryScheduled, 1);
        row = await outboxRow(database, 3001);
        assert.equal(row.purchase_email_attempts, 2);
        assert.equal(row.purchase_email_next_attempt_at?.getTime(), t2.getTime() + 2 * MINUTE, "the second wait is twice the first");

        clock.advance(2 * MINUTE);
        assert.equal((await run(smtp, { now: clock.now })).sent, 1);
        row = await outboxRow(database, 3001);
        assert.equal(row.purchase_email_status, "sent");
        assert.equal(row.purchase_email_attempts, 3);
        assert.equal(row.purchase_email_last_error, null, "a success clears the old error");
        assert.equal(smtp.attempts, 3);
        assert.equal(smtp.sent.length, 1, "retries never produce a second copy");
    });
});

// ---------------------------------------------------------------------------
// Retry exhaustion and permanent failures
// ---------------------------------------------------------------------------

describe("retry exhaustion: a maximum number of attempts, then 'abandoned'", () => {
    it("with the default limits a long outage is tried exactly 8 times, waiting 1-2-4-8-16-32-60 minutes, then abandoned for good", async () => {
        await purchase(4001);
        const smtp = createFakeSmtp({ alwaysFail: smtpErrors.connectTimeout() });
        const clock = createTestClock();
        const waits: number[] = [];

        for (let pass = 0; pass < 20; pass += 1) {
            const before = clock.now();
            await run(smtp, { now: clock.now });
            const row = await outboxRow(database, 4001);
            if (row.purchase_email_status === "pending") waits.push((row.purchase_email_next_attempt_at!.getTime() - before.getTime()) / MINUTE);
            clock.advance(2 * 60 * MINUTE);
        }

        assert.equal(PURCHASE_EMAIL_MAX_ATTEMPTS, 8);
        assert.equal(smtp.attempts, 8, "exactly the maximum, never more");
        assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 60]);
        const row = await outboxRow(database, 4001);
        assert.equal(row.purchase_email_status, "abandoned");
        assert.equal(row.purchase_email_attempts, 8);
        assert.match(row.purchase_email_last_error ?? "", /Gave up after 8 attempts/);
        assert.equal(row.purchase_email_next_attempt_at, null);
        assert.equal(smtp.sent.length, 0);
        assert.equal(await count("workspaces"), 1, "the order itself is untouched");
    });

    it("the limit is configurable and enforced the same way", async () => {
        await purchase(4002);
        const smtp = createFakeSmtp({ alwaysFail: smtpErrors.connectionRefused() });
        const clock = createTestClock();
        for (let pass = 0; pass < 6; pass += 1) {
            await run(smtp, { now: clock.now, maxAttempts: 3 });
            clock.advance(2 * 60 * MINUTE);
        }
        assert.equal(smtp.attempts, 3);
        assert.equal((await outboxRow(database, 4002)).purchase_email_status, "abandoned");
    });

    it("a permanent rejection is abandoned at once and never retried", async () => {
        await purchase(4003);
        const smtp = createFakeSmtp({ alwaysFail: smtpError("550 5.1.1 mailbox does not exist", { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }) });
        const clock = createTestClock();

        assert.equal((await run(smtp, { now: clock.now })).abandoned, 1);
        clock.advance(24 * 60 * MINUTE);
        assert.equal((await run(smtp, { now: clock.now })).claimed, 0);

        assert.equal(smtp.attempts, 1);
        const row = await outboxRow(database, 4003);
        assert.equal(row.purchase_email_status, "abandoned");
        assert.match(row.purchase_email_last_error ?? "", /Permanent failure \(send\)\. EENVELOPE 550 RCPT TO/);
    });

    it("bad credentials and an ambiguous mid-send drop are not retried either (a retry could mail twice)", async () => {
        for (const [orderId, error] of [
            [4004, smtpError("Invalid login", { code: "EAUTH", responseCode: 535 })],
            [4005, smtpError("socket hang up", { code: "ESOCKET" })],
            [4006, smtpError("read ECONNRESET", { code: "ECONNRESET" })],
        ] as const) {
            await purchase(orderId);
            const smtp = createFakeSmtp({ alwaysFail: error });
            await run(smtp, {}, { shopifyOrderId: String(orderId) });
            assert.equal(smtp.attempts, 1, `order ${orderId}`);
            assert.equal((await outboxRow(database, orderId)).purchase_email_status, "abandoned", `order ${orderId}`);
        }
    });

    it("a corrupt stored snapshot is abandoned without sending anything", async () => {
        await purchase(4007);
        await database.exec(`UPDATE shopify_orders SET purchase_email_payload = '{"hello": 1}' WHERE shopify_order_id = '4007'`);
        const smtp = createFakeSmtp();
        const logger = createCapturingLogger();

        assert.equal((await run(smtp, {}, {}, logger)).abandoned, 1);

        assert.equal(smtp.attempts, 0);
        const row = await outboxRow(database, 4007);
        assert.equal(row.purchase_email_status, "abandoned");
        assert.match(row.purchase_email_last_error ?? "", /stored email content is invalid/);
        assert.ok(logger.calls.some((call) => call.level === "error" && /stored content is invalid/.test(call.msg)));
    });

    it("numbers that do not add up are abandoned at the build stage, never mailed", async () => {
        await purchase(4008);
        await database.exec(
            `UPDATE shopify_orders SET purchase_email_payload = jsonb_set(purchase_email_payload, '{lines,0,licenses}', '5') WHERE shopify_order_id = '4008'`
        );
        const smtp = createFakeSmtp();

        assert.equal((await run(smtp)).abandoned, 1);

        assert.equal(smtp.attempts, 0);
        assert.match((await outboxRow(database, 4008)).purchase_email_last_error ?? "", /Permanent failure \(build\)/);
    });
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe("crash recovery: a lease that lapses hands the email to the next worker", () => {
    it("a worker that dies right after claiming leaves it 'processing'; nobody touches it until the lease passes; then it is sent once", async () => {
        await purchase(5001);
        const clock = createTestClock();

        const claim = await claimOnce(clock);
        assert.ok(claim, "the worker claimed it, then 'crashed': no send, no completion");
        let row = await outboxRow(database, 5001);
        assert.equal(row.purchase_email_status, "processing");
        assert.equal(row.purchase_email_attempts, 1);
        assert.equal(row.purchase_email_locked_until?.getTime(), clock.now().getTime() + PURCHASE_EMAIL_LEASE_MS);

        const smtp = createFakeSmtp();
        clock.advance(PURCHASE_EMAIL_LEASE_MS - 1_000);
        assert.equal((await run(smtp, { now: clock.now })).claimed, 0, "while the lease is live, the email belongs to the first worker");
        assert.equal(smtp.attempts, 0);

        clock.advance(2_000);
        const summary = await run(smtp, { now: clock.now });
        assert.equal(summary.sent, 1);
        row = await outboxRow(database, 5001);
        assert.equal(row.purchase_email_status, "sent");
        assert.equal(row.purchase_email_attempts, 2, "the recovered send counts as the second attempt");
        assert.equal(smtp.sent.length, 1);
    });

    it("a worker that keeps dying cannot loop forever: when the attempts are used up the email is abandoned", async () => {
        await purchase(5002);
        const clock = createTestClock();
        const maxAttempts = 3;

        for (let crash = 1; crash <= maxAttempts; crash += 1) {
            const claim = await claimOnce(clock, { maxAttempts });
            assert.ok(claim, `claim ${crash}`);
            assert.equal(claim.attempt, crash);
            clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        }

        const smtp = createFakeSmtp();
        const summary = await run(smtp, { now: clock.now, maxAttempts });

        assert.equal(summary.claimed, 0);
        assert.equal(summary.recoveredAsAbandoned, 1);
        const row = await outboxRow(database, 5002);
        assert.equal(row.purchase_email_status, "abandoned");
        assert.match(row.purchase_email_last_error ?? "", /worker stopped while sending and no attempts were left/);
        assert.equal(smtp.attempts, 0, "never sent: the crashes may have happened mid-send, so it is left for a person");
    });

    it("a stalled worker whose lease ran out does not send: it cannot duplicate the worker that took over", async () => {
        await purchase(5003);
        const clock = createTestClock();
        const staleClaim = (await claimOnce(clock))!;

        clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        const smtpB = createFakeSmtp();
        assert.equal((await run(smtpB, { now: clock.now })).sent, 1, "worker B takes over and sends");

        const smtpA = createFakeSmtp();
        const outcome = await processClaimedPurchaseEmail(database.db, log, staleClaim, { createTransport: smtpA.createTransport, now: clock.now });

        assert.equal(outcome, "lost_lease");
        assert.equal(smtpA.attempts, 0, "the stalled worker never sends");
        assert.equal(smtpB.sent.length, 1);
        assert.equal((await outboxRow(database, 5003)).purchase_email_status, "sent");
    });

    it("a send that is still in flight when the lease runs out cannot overwrite the newer worker's result (the one residual duplicate window)", async () => {
        await purchase(5004);
        const clock = createTestClock();
        const claimA = (await claimOnce(clock))!;

        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const slowSent: string[] = [];
        const slowTransport: ShopifyPurchaseEmailTransport = {
            async sendMail(message) {
                await gate;
                slowSent.push(message.to);
            },
        };
        const logger = createCapturingLogger();
        const inFlight = processClaimedPurchaseEmail(database.db, logger, claimA, { createTransport: () => slowTransport, now: clock.now });

        clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        const smtpB = createFakeSmtp();
        assert.equal((await run(smtpB, { now: clock.now })).sent, 1, "B finds the lease expired, claims and sends");
        const sentAtByB = (await outboxRow(database, 5004)).purchase_email_sent_at;

        release();
        assert.equal(await inFlight, "lost_lease");

        const row = await outboxRow(database, 5004);
        assert.equal(row.purchase_email_status, "sent");
        assert.equal(row.purchase_email_attempts, 2);
        assert.equal(row.purchase_email_sent_at?.getTime(), sentAtByB?.getTime(), "A's late completion did not overwrite B's");
        assert.ok(logger.calls.some((call) => call.level === "warn" && /duplicate copy is possible/.test(call.msg)), "the possible duplicate is logged");
        assert.equal(slowSent.length + smtpB.sent.length, 2, "this is the documented, rare duplicate: A's slow send and B's send");
    });
});

describe("a stalled worker cannot disturb the worker that replaced it", () => {
    it("a late FAILURE from the stalled worker is ignored: it cannot reset the email the new worker is sending right now", async () => {
        await purchase(5005);
        const clock = createTestClock();
        const claimA = (await claimOnce(clock))!;

        // Worker A's send hangs, then fails with a temporary error, long after its lease ran out.
        let releaseA!: () => void;
        const gateA = new Promise<void>((resolve) => (releaseA = resolve));
        const transportA: ShopifyPurchaseEmailTransport = {
            async sendMail() {
                await gateA;
                throw smtpError("connect ETIMEDOUT", { code: "ETIMEDOUT" });
            },
        };
        const inFlightA = processClaimedPurchaseEmail(database.db, log, claimA, { createTransport: () => transportA, now: clock.now });

        // The lease passes; worker B claims the email and starts sending (also not finished yet).
        clock.advance(PURCHASE_EMAIL_LEASE_MS + 1_000);
        const claimB = (await claimOnce(clock))!;
        assert.equal(claimB.attempt, 2);
        let releaseB!: () => void;
        const gateB = new Promise<void>((resolve) => (releaseB = resolve));
        const sentByB: string[] = [];
        const transportB: ShopifyPurchaseEmailTransport = {
            async sendMail(message) {
                await gateB;
                sentByB.push(message.to);
            },
        };
        const inFlightB = processClaimedPurchaseEmail(database.db, log, claimB, { createTransport: () => transportB, now: clock.now });

        // A finally fails. Its completion must be rejected: the row is B's now.
        releaseA();
        assert.equal(await inFlightA, "lost_lease");
        const midway = await outboxRow(database, 5005);
        assert.equal(midway.purchase_email_status, "processing", "A did not reset it to pending");
        assert.equal(midway.purchase_email_locked_until?.getTime(), claimB.leaseUntil.getTime(), "the lease is still B's");

        releaseB();
        assert.equal(await inFlightB, "sent");
        const row = await outboxRow(database, 5005);
        assert.equal(row.purchase_email_status, "sent");
        assert.equal(sentByB.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Concurrent workers
// ---------------------------------------------------------------------------

describe("concurrent workers never take the same email", () => {
    /** A mail transport that yields between calls, so the competing workers really interleave. */
    function interleavingSmtp(): FakeSmtp {
        const smtp = createFakeSmtp();
        const base = smtp.transport.sendMail.bind(smtp.transport);
        smtp.transport.sendMail = async (message) => {
            await new Promise((resolve) => setImmediate(resolve));
            return base(message);
        };
        return smtp;
    }

    it("four workers racing over twelve queued emails send each exactly once", async () => {
        for (let orderId = 6001; orderId <= 6012; orderId += 1) await purchase(orderId);
        const smtp = interleavingSmtp();
        const clock = createTestClock();

        const summaries = await Promise.all([1, 2, 3, 4].map(() => run(smtp, { now: clock.now })));

        assert.equal(summaries.reduce((total, summary) => total + summary.claimed, 0), 12, "every email was claimed once in total");
        assert.equal(summaries.reduce((total, summary) => total + summary.sent, 0), 12);
        assert.equal(smtp.sent.length, 12);
        assert.equal(new Set(smtp.sent.map((message) => message.to)).size, 12, "no recipient got two copies");
        assert.ok(summaries.filter((summary) => summary.claimed > 0).length >= 2, "the work really was shared between workers");
        const rows = await database.rows<{ status: string; attempts: number }>(
            `SELECT purchase_email_status AS status, purchase_email_attempts AS attempts FROM shopify_orders`
        );
        assert.ok(rows.every((row) => row.status === "sent" && row.attempts === 1));
    });

    it("two claims for the same order at the same moment: exactly one wins", async () => {
        await purchase(6101);
        const clock = createTestClock();

        const claims = await Promise.all([claimOnce(clock, { shopifyOrderId: "6101" }), claimOnce(clock, { shopifyOrderId: "6101" }), claimOnce(clock, { shopifyOrderId: "6101" })]);

        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal((await outboxRow(database, 6101)).purchase_email_attempts, 1);
    });

    it("a worker passes over an email another worker holds under a live lease", async () => {
        await purchase(6102);
        const clock = createTestClock();
        await claimOnce(clock);

        const smtp = createFakeSmtp();
        const summary = await run(smtp, { now: clock.now });

        assert.equal(summary.claimed, 0);
        assert.equal(smtp.attempts, 0);
        assert.equal((await outboxRow(database, 6102)).purchase_email_status, "processing");
    });

    it("competing workers also do not double-send retries that fall due at the same time", async () => {
        for (let orderId = 6201; orderId <= 6206; orderId += 1) await purchase(orderId);
        const clock = createTestClock();
        const failing = createFakeSmtp({ alwaysFail: smtpErrors.connectionRefused() });
        await run(failing, { now: clock.now });
        clock.advance(2 * MINUTE);

        const smtp = interleavingSmtp();
        await Promise.all([run(smtp, { now: clock.now }), run(smtp, { now: clock.now }), run(smtp, { now: clock.now })]);

        assert.equal(smtp.sent.length, 6);
        assert.equal(new Set(smtp.sent.map((message) => message.to)).size, 6);
    });
});

// ---------------------------------------------------------------------------
// The worker loop and restart recovery
// ---------------------------------------------------------------------------

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`Condition not met within ${timeoutMs} ms`);
}

describe("the background worker", () => {
    it("after a restart, the first pass sends whatever was left pending", async () => {
        await purchase(7001);
        const smtp = createFakeSmtp();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log, deps: { createTransport: smtp.createTransport }, initialDelayMs: 10, intervalMs: 20 });
        try {
            await waitFor(async () => (await outboxRow(database, 7001)).purchase_email_status === "sent");
            assert.equal(smtp.sent.length, 1);
        } finally {
            await worker.stop();
        }
    });

    it("after a restart, it also recovers an email a dead process left 'processing' once its lease has passed", async () => {
        await purchase(7002);
        // A process claimed it just now with a very short lease and then died: by the time the new process's worker
        // looks, the lease has passed.
        const dead = await claimNextPurchaseEmail(database.db, {
            now: new Date(Date.now() + 1),
            leaseMs: 1,
            maxAttempts: PURCHASE_EMAIL_MAX_ATTEMPTS,
        });
        assert.ok(dead);
        assert.equal((await outboxRow(database, 7002)).purchase_email_status, "processing");

        const smtp = createFakeSmtp();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log, deps: { createTransport: smtp.createTransport }, initialDelayMs: 10, intervalMs: 20 });
        try {
            await waitFor(async () => (await outboxRow(database, 7002)).purchase_email_status === "sent");
            assert.equal((await outboxRow(database, 7002)).purchase_email_attempts, 2);
            assert.equal(smtp.sent.length, 1);
        } finally {
            await worker.stop();
        }
    });

    it("survives a database error: it logs it and the next pass carries on", async () => {
        await purchase(7003);
        let failures = 1;
        const flakyDb = {
            select: database.db.select.bind(database.db),
            update: database.db.update.bind(database.db),
            execute: (query: Parameters<typeof database.db.execute>[0]) => {
                if (failures-- > 0) throw new Error("connection terminated unexpectedly");
                return database.db.execute(query);
            },
        } as unknown as typeof database.db;
        const logger = createCapturingLogger();
        const smtp = createFakeSmtp();
        const worker = startPurchaseEmailOutboxWorker({ db: flakyDb, log: logger, deps: { createTransport: smtp.createTransport }, initialDelayMs: 10, intervalMs: 20 });
        try {
            await waitFor(async () => (await outboxRow(database, 7003)).purchase_email_status === "sent");
            assert.ok(logger.calls.some((call) => call.level === "error" && /worker pass failed; it will try again/.test(call.msg)));
            assert.equal(smtp.sent.length, 1);
        } finally {
            await worker.stop();
        }
    });

    it("stop() ends it: nothing is picked up afterwards", async () => {
        const smtp = createFakeSmtp();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log, deps: { createTransport: smtp.createTransport }, initialDelayMs: 10, intervalMs: 20 });
        await worker.stop();

        await purchase(7004);
        await new Promise((resolve) => setTimeout(resolve, 150));

        assert.equal(smtp.attempts, 0);
        assert.equal((await outboxRow(database, 7004)).purchase_email_status, "pending");
    });

    it("tick() never overlaps itself", async () => {
        await purchase(7005);
        const smtp = createFakeSmtp();
        const worker = startPurchaseEmailOutboxWorker({ db: database.db, log, deps: { createTransport: smtp.createTransport }, initialDelayMs: 60_000 });
        try {
            const [a, b] = await Promise.all([worker.tick(), worker.tick()]);
            assert.equal(a, b, "the second call joins the pass already running");
            assert.equal(smtp.sent.length, 1);
        } finally {
            await worker.stop();
        }
    });

    it("the Fastify plugin starts the worker when the app is ready and stops it cleanly on close", async () => {
        const lines: string[] = [];
        const stream = new Writable({
            write(chunk, _encoding, callback) {
                lines.push(String(chunk));
                callback();
            },
        });
        const app = Fastify({ logger: { level: "info", stream } });
        await app.register(
            fp(
                async (instance) => {
                    instance.decorate("db", database.db);
                },
                { name: "db-plugin" }
            )
        );
        await app.register(shopifyEmailOutboxPlugin);

        await app.ready();
        assert.ok(lines.join("").includes("Shopify purchase email worker started"));
        await app.close();
    });
});

// ---------------------------------------------------------------------------
// What reaches the logs and the database
// ---------------------------------------------------------------------------

describe("secrets and personal data", () => {
    it("failure logs and the stored error note carry no SMTP credentials, no email body and no full customer address", async () => {
        await purchase(8001);
        const smtp = createFakeSmtp({
            alwaysFail: Object.assign(smtpErrors.connectionRefused(), { message: `connect failed for password ${FAKE_SMTP_PASSWORD} at host` }),
        });
        const logger = createCapturingLogger();

        await run(smtp, {}, {}, logger);

        const row = await outboxRow(database, 8001);
        const everything = `${logger.dump()}\n${row.purchase_email_last_error}`;
        assert.ok(!everything.includes(FAKE_SMTP_PASSWORD), "the SMTP password never appears");
        assert.ok(everything.includes("[redacted]"));
        assert.ok(!everything.includes("buyer8001@example.com"), "the address is masked in logs and in the note");
        assert.ok(logger.dump().includes("b***@example.com"));
        assert.ok(!logger.dump().includes("Payment received"), "the email body is never logged");
    });
});
