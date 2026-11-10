/**
 * End-to-end tests of the Shopify purchase -> workspace -> confirmation email flow.
 *
 * The database is a real in-memory Postgres (PGlite) running the project's own migrations, so provisioning, row and
 * advisory locks, upserts, transactions and rollbacks are the production code paths, not stubs. SMTP is a mock
 * (`createFakeSmtp`): no email is ever sent. Nothing here reads a connection string or touches a real service.
 */
import "./shopify.test-env";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

import { errorHandlerPlugin } from "@plugins/error-handler.plugin";
import { runPurchaseEmailOutbox, waitForQueuedShopifyPurchaseEmails } from "./shopify.email-outbox";
import type { ShopifyPurchaseEmail } from "./shopify.purchase-email";
import { shopifyOrderPaidWebhookRoutes, shopifyRoutes } from "./shopify.route";
import { recordShopifyWebhookEvent } from "./shopify.service";
import { smtpErrors } from "./shopify.fake-smtp.test-env";
import {
    PRODUCT,
    TEST_SHOP_DOMAIN,
    TEST_WEBHOOK_SECRET,
    createCapturingLogger,
    createFakeSmtp,
    createTestDatabase,
    insertUser,
    outboxRow,
    shopifyOrderPayload,
    smtpError,
    type FakeSmtp,
    type OrderPayloadOptions,
    type SentMessage,
    type TestDatabase,
} from "./shopify.pglite.test-env";

let database: TestDatabase;

before(async () => {
    database = await createTestDatabase();
});

after(async () => {
    await database.close();
});

beforeEach(async () => {
    await database.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = createCapturingLogger();

/**
 * One Shopify delivery, the way the route handles it: record the webhook in one transaction (the confirmation is queued
 * in the database inside that same transaction), and only after that commit send it through the mock SMTP (the route does
 * this in the background; here it is awaited so the test is deterministic).
 */
async function deliver(
    smtp: FakeSmtp,
    input: { webhookId: string; payload: Record<string, unknown>; topic?: string }
): Promise<{ duplicate: boolean; email: ShopifyPurchaseEmail | null; outbox: Awaited<ReturnType<typeof runPurchaseEmailOutbox>> | null }> {
    const result = await recordShopifyWebhookEvent(database.app, {
        webhookId: input.webhookId,
        topic: input.topic ?? "orders/paid",
        payloadJson: input.payload,
        shopDomain: TEST_SHOP_DOMAIN,
        log,
    });
    const outbox = result.purchaseEmail
        ? await runPurchaseEmailOutbox(database.db, log, { createTransport: smtp.createTransport }, { shopifyOrderId: result.purchaseEmail.shopifyOrderId, limit: 1 })
        : null;
    return { duplicate: result.duplicate, email: result.purchaseEmail, outbox };
}

const order = (options: OrderPayloadOptions) => shopifyOrderPayload(options);

async function count(table: string): Promise<number> {
    const [row] = await database.rows<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
    return Number(row?.n ?? 0);
}

type WorkspaceRow = { id: string; name: string; owner_email: string; seat_limit: number; subscription_status: string; status: string; billing_source: string; expires_at: Date };

const workspaces = () =>
    database.rows<WorkspaceRow>("SELECT id, name, owner_email, seat_limit, subscription_status, status, billing_source, expires_at FROM workspaces ORDER BY created_at");

const members = () => database.rows<{ email: string; role: string; status: string }>("SELECT email, role, status FROM workspace_members ORDER BY created_at");

/** drizzle reports a failed statement as "Failed query: ..." and keeps the Postgres error in `cause`. */
const failedBecauseOf = (constraint: string) => (error: unknown): boolean => {
    const cause = (error as { cause?: { message?: string } }).cause;
    assert.match(String(cause?.message ?? (error as Error).message), new RegExp(`violates check constraint "${constraint}"`));
    return true;
};

const only = (messages: SentMessage[]): SentMessage => {
    assert.equal(messages.length, 1, `expected exactly one email, got ${messages.length}: ${messages.map((m) => m.subject).join(" | ")}`);
    return messages[0]!;
};

const LARGE_SUBJECT = "Your HealthAge Large Venue Kit Purchase Is Confirmed!";
const SMALL_SUBJECT = "Your HealthAge Small Venue Kit Purchase Is Confirmed!";
const DISCOVER_SUBJECT = "Thank You for Purchasing Discover Your Health Age!";
const MIXED_SUBJECT = "Your HealthAge Purchase Is Confirmed!";

// ---------------------------------------------------------------------------
// New customers
// ---------------------------------------------------------------------------

describe("new customer: first purchase creates the workspace, then sends the product email", () => {
    it("1. Large Venue Kit: workspace with 4 licenses, one Large Venue Kit email to the buyer", async () => {
        const smtp = createFakeSmtp();
        const { duplicate, outbox } = await deliver(smtp, {
            webhookId: "wh-1",
            payload: order({ orderId: 1001, orderNumber: 1042, items: [{ productId: PRODUCT.large, quantity: 1 }] }),
        });

        assert.equal(duplicate, false);
        assert.equal(outbox?.sent, 1);
        const queued = await outboxRow(database, 1001);
        assert.equal(queued.purchase_email_status, "sent");
        assert.equal(queued.purchase_email_attempts, 1);
        assert.ok(queued.purchase_email_sent_at);

        const [workspace] = await workspaces();
        assert.equal(workspace?.seat_limit, 4);
        assert.equal(workspace?.billing_source, "shopify");
        assert.equal(workspace?.subscription_status, "active");
        assert.equal(workspace?.owner_email, "buyer@example.com");
        assert.equal(workspace?.expires_at.toISOString(), "2027-11-02T10:00:00.000Z");
        assert.deepEqual(await members(), [{ email: "buyer@example.com", role: "owner", status: "invited" }]);

        const message = only(smtp.sent);
        assert.equal(message.to, "buyer@example.com");
        assert.equal(message.subject, LARGE_SUBJECT);
        assert.match(message.text, /Hello Pat Morgan,/);
        assert.match(message.text, /Order number: #1042/);
        assert.match(message.text, /4 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(message.text, /Create your account/, "a new customer keeps the registration instructions");
        assert.match(message.text, /Open Admin Portal/);
        assert.ok(message.html.includes("Order number"));
    });

    it("3. Small Venue Kit: workspace with 1 license, one Small Venue Kit email", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 1002, orderNumber: 1043, items: [{ productId: PRODUCT.small, quantity: 1 }] }) });

        assert.equal((await workspaces())[0]?.seat_limit, 1);
        const message = only(smtp.sent);
        assert.equal(message.subject, SMALL_SUBJECT);
        assert.match(message.text, /1 LICENSE ADDED TO YOUR WORKSPACE/);
        assert.match(message.text, /Create your account or sign in/);
        assert.doesNotMatch(message.text, /Large Venue Kit/);
    });

    it("5. Discover Your Health Age: the backend provisions 1 license, and the email says exactly that and nothing more", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 1003, orderNumber: 1044, items: [{ productId: PRODUCT.discover, quantity: 1 }] }) });

        const [workspace] = await workspaces();
        assert.equal(workspace?.seat_limit, 1, "the existing backend logic really allocates a license for this product");

        const message = only(smtp.sent);
        assert.equal(message.subject, DISCOVER_SUBJECT);
        assert.match(message.text, /Licenses: 1 license \(1 per app\)/);
        assert.match(message.text, /Registered email: buyer@example\.com/);
        assert.doesNotMatch(message.text, /Venue Kit|Open Admin Portal|ADDED TO YOUR WORKSPACE/);
    });

    it("an existing HealthAge user who buys is made an active owner and told to sign in", async () => {
        await insertUser(database, { email: "buyer@example.com", name: "Existing Pat" });
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 1004, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });

        assert.deepEqual(await members(), [{ email: "buyer@example.com", role: "owner", status: "active" }]);
        const message = only(smtp.sent);
        assert.match(message.text, /Hello Existing Pat,/);
        assert.match(message.text, /Sign in to your account/);
        assert.doesNotMatch(message.text, /Create your account/);
        assert.equal(await count("users"), 1, "no duplicate user is created");
    });

    it("sends exactly one backend email, and not the old generic welcome email", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 1005, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
        const message = only(smtp.sent);
        assert.doesNotMatch(message.subject, /Complete registration|organization has been created|Workspace Admin/i);
        assert.equal(smtp.attempts, 1);
    });
});

// ---------------------------------------------------------------------------
// Existing customers
// ---------------------------------------------------------------------------

describe("existing customer: more licenses go to the same workspace, with their own confirmation", () => {
    it("2. a second Large Venue Kit adds 4 licenses to the existing workspace and sends a Large Venue Kit confirmation", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 2001, orderNumber: 1100, customerId: 77, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
        const second = await deliver(smtp, {
            webhookId: "wh-2",
            payload: order({ orderId: 2002, orderNumber: 1101, customerId: 77, processedAt: "2026-12-01T09:00:00.000Z", items: [{ productId: PRODUCT.large, quantity: 1 }] }),
        });

        assert.equal(second.email?.scenario, "existing_workspace");
        const all = await workspaces();
        assert.equal(all.length, 1, "no duplicate workspace");
        assert.equal(all[0]?.seat_limit, 8);
        assert.equal((await members()).length, 1, "no duplicate owner membership");
        assert.equal(await count("users"), 0, "no user is created by a purchase");
        assert.equal(all[0]?.expires_at.toISOString(), "2027-11-02T10:00:00.000Z", "an active workspace keeps its existing expiry");

        assert.equal(smtp.sent.length, 2, "one confirmation per purchase");
        const message = smtp.sent[1]!;
        assert.equal(message.to, "buyer@example.com");
        assert.equal(message.subject, LARGE_SUBJECT);
        assert.match(message.text, /Order number: #1101/);
        assert.match(message.text, /4 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(message.text, /Your workspace now has 8 licenses in total\./);
        assert.match(message.text, /have been added to your existing HealthAge workspace/);
    });

    it("4. a second Small Venue Kit adds 1 license and sends a Small Venue Kit confirmation", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 2101, customerId: 78, items: [{ productId: PRODUCT.small, quantity: 1 }] }) });
        await deliver(smtp, { webhookId: "wh-2", payload: order({ orderId: 2102, orderNumber: 1201, customerId: 78, items: [{ productId: PRODUCT.small, quantity: 1 }] }) });

        assert.equal((await workspaces())[0]?.seat_limit, 2);
        const message = smtp.sent[1]!;
        assert.equal(message.subject, SMALL_SUBJECT);
        assert.match(message.text, /1 LICENSE ADDED TO YOUR WORKSPACE/);
        assert.match(message.text, /Your workspace now has 2 licenses in total\./);
    });

    it("an existing customer who already has an account is not sent the registration steps again", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 2201, customerId: 79, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
        await insertUser(database, { email: "buyer@example.com", name: "Pat Morgan" });
        await deliver(smtp, { webhookId: "wh-2", payload: order({ orderId: 2202, customerId: 79, items: [{ productId: PRODUCT.small, quantity: 2 }] }) });

        const message = smtp.sent[1]!;
        assert.equal(message.subject, SMALL_SUBJECT);
        assert.match(message.text, /USING YOUR LICENSES/);
        assert.doesNotMatch(message.text, /Create your account/);
        assert.match(message.text, /2 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(message.text, /Your workspace now has 6 licenses in total\./);
    });

    it("a different product on a repeat purchase uses that product's own template", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 2301, customerId: 80, items: [{ productId: PRODUCT.small, quantity: 1 }] }) });
        await deliver(smtp, { webhookId: "wh-2", payload: order({ orderId: 2302, customerId: 80, items: [{ productId: PRODUCT.discover, quantity: 1 }] }) });

        assert.deepEqual(smtp.sent.map((m) => m.subject), [SMALL_SUBJECT, DISCOVER_SUBJECT]);
        assert.equal((await workspaces()).length, 1);
        assert.equal((await workspaces())[0]?.seat_limit, 2);
    });
});

// ---------------------------------------------------------------------------
// Quantities, mixed carts, unsupported products
// ---------------------------------------------------------------------------

describe("quantities, mixed carts and unsupported products", () => {
    it("6. several kits multiply the licenses and the email states the arithmetic", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 3001, items: [{ productId: PRODUCT.large, quantity: 2 }] }) });
        assert.equal((await workspaces())[0]?.seat_limit, 8);
        const large = only(smtp.sent);
        assert.match(large.text, /Product: Large Venue Kit × 2/);
        assert.match(large.text, /Licenses: 8 licenses \(4 per kit × 2\)/);
        assert.match(large.text, /8 LICENSES ADDED TO YOUR WORKSPACE/);

        await database.reset();
        const smtp2 = createFakeSmtp();
        await deliver(smtp2, { webhookId: "wh-2", payload: order({ orderId: 3002, items: [{ productId: PRODUCT.small, quantity: 3 }] }) });
        assert.equal((await workspaces())[0]?.seat_limit, 3);
        assert.match(only(smtp2.sent).text, /Licenses: 3 licenses \(1 per kit × 3\)/);
    });

    it("7. a mixed cart of all three products gives one consolidated email with the combined total", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, {
            webhookId: "wh-1",
            payload: order({
                orderId: 3101,
                orderNumber: 1300,
                items: [
                    { productId: PRODUCT.large, quantity: 1 },
                    { productId: PRODUCT.small, quantity: 2 },
                    { productId: PRODUCT.discover, quantity: 1 },
                ],
            }),
        });

        assert.equal((await workspaces())[0]?.seat_limit, 7);
        const message = only(smtp.sent);
        assert.equal(message.subject, MIXED_SUBJECT);
        assert.match(message.text, /Large Venue Kit × 1 — 4 licenses/);
        assert.match(message.text, /Small Venue Kit × 2 — 2 licenses/);
        assert.match(message.text, /Discover Your Health Age × 1 — 1 license/);
        assert.match(message.text, /7 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.equal(await count("workspaces"), 1);
    });

    it("7b. a repeat mixed purchase is also one email", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 3201, customerId: 90, items: [{ productId: PRODUCT.small, quantity: 1 }] }) });
        await deliver(smtp, {
            webhookId: "wh-2",
            payload: order({ orderId: 3202, customerId: 90, items: [{ productId: PRODUCT.large, quantity: 1 }, { productId: PRODUCT.discover, quantity: 1 }] }),
        });
        assert.equal(smtp.sent.length, 2);
        assert.equal(smtp.sent[1]?.subject, MIXED_SUBJECT);
        assert.match(smtp.sent[1]!.text, /5 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(smtp.sent[1]!.text, /Your workspace now has 6 licenses in total\./);
    });

    it("8. an order with only unsupported products creates no workspace and sends no email", async () => {
        const smtp = createFakeSmtp();
        const { email, duplicate } = await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 3301, items: [{ productId: PRODUCT.unrelated, quantity: 2 }] }) });

        assert.equal(duplicate, false);
        assert.equal(email, null);
        assert.equal(smtp.attempts, 0);
        assert.equal(await count("workspaces"), 0);
        assert.equal(await count("workspace_members"), 0);
        assert.equal(await count("shopify_orders"), 1, "the order itself is still recorded");
    });

    it("8b. unsupported products in a mixed order are ignored: not licensed and not listed in the email", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, {
            webhookId: "wh-1",
            payload: order({ orderId: 3302, items: [{ productId: PRODUCT.small, quantity: 1 }, { productId: PRODUCT.unrelated, quantity: 3, title: "HealthAge T-Shirt" }] }),
        });

        assert.equal((await workspaces())[0]?.seat_limit, 1);
        const message = only(smtp.sent);
        assert.equal(message.subject, SMALL_SUBJECT);
        assert.doesNotMatch(message.text, /T-Shirt/);
        assert.match(message.text, /Other items in your order/);
    });

    it("a paid delivery for an order that is already cancelled sends no confirmation", async () => {
        const smtp = createFakeSmtp();
        const { email } = await deliver(smtp, {
            webhookId: "wh-1",
            payload: order({ orderId: 3401, cancelledAt: "2026-11-02T11:00:00.000Z", items: [{ productId: PRODUCT.large, quantity: 1 }] }),
        });
        assert.equal(email, null);
        assert.equal(smtp.attempts, 0);
    });
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe("9. duplicate deliveries never cause duplicate emails or licenses", () => {
    it("the same webhook id delivered twice is processed once", async () => {
        const smtp = createFakeSmtp();
        const payload = order({ orderId: 4001, items: [{ productId: PRODUCT.large, quantity: 1 }] });
        const first = await deliver(smtp, { webhookId: "wh-same", payload });
        const second = await deliver(smtp, { webhookId: "wh-same", payload });

        assert.equal(first.duplicate, false);
        assert.equal(second.duplicate, true);
        assert.equal(second.email, null);
        assert.equal(smtp.sent.length, 1);
        assert.equal(await count("workspaces"), 1);
        assert.equal((await workspaces())[0]?.seat_limit, 4);
        assert.equal(await count("billing_events"), 1);
    });

    it("the same order re-sent under a NEW webhook id adds no licenses and sends no second email", async () => {
        const smtp = createFakeSmtp();
        const payload = order({ orderId: 4002, items: [{ productId: PRODUCT.large, quantity: 1 }] });
        await deliver(smtp, { webhookId: "wh-a", payload });
        const again = await deliver(smtp, { webhookId: "wh-b", payload });

        assert.equal(again.duplicate, false);
        assert.equal(again.email, null, "this delivery allocated nothing, so there is nothing to confirm");
        assert.equal(smtp.sent.length, 1);
        assert.equal((await workspaces())[0]?.seat_limit, 4, "licenses are not counted twice");
        assert.equal(await count("workspaces"), 1);
    });

    it("order create/update webhooks around the paid one produce one email in total", async () => {
        const smtp = createFakeSmtp();
        const payload = order({ orderId: 4003, items: [{ productId: PRODUCT.small, quantity: 1 }] });
        await deliver(smtp, { webhookId: "wh-1", topic: "orders/create", payload });
        await deliver(smtp, { webhookId: "wh-2", topic: "orders/paid", payload });
        await deliver(smtp, { webhookId: "wh-3", topic: "orders/updated", payload });
        await deliver(smtp, { webhookId: "wh-4", topic: "orders/fulfilled", payload });

        assert.equal(smtp.sent.length, 1);
        assert.equal(await count("workspaces"), 1);
    });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("10-11. database failures roll everything back and send nothing", () => {
    it("10. workspace creation failure: nothing is saved, no email, and Shopify's retry then succeeds once", async () => {
        const smtp = createFakeSmtp();
        await database.rows(`ALTER TABLE workspaces ADD CONSTRAINT test_block_name CHECK (name <> 'Boom Fail')`);
        const payload = order({ orderId: 5001, firstName: "Boom", lastName: "Fail", items: [{ productId: PRODUCT.large, quantity: 1 }] });

        try {
            await assert.rejects(deliver(smtp, { webhookId: "wh-retry", payload }), failedBecauseOf("test_block_name"));
            assert.equal(smtp.attempts, 0, "no email for a workspace that does not exist");
            assert.equal(await count("workspaces"), 0);
            assert.equal(await count("workspace_members"), 0);
            assert.equal(await count("shopify_orders"), 0, "the whole transaction rolled back");
            assert.equal(await count("billing_events"), 0, "the webhook is not marked as processed, so Shopify's retry is not skipped");
        } finally {
            await database.rows(`ALTER TABLE workspaces DROP CONSTRAINT test_block_name`);
        }

        const retry = await deliver(smtp, { webhookId: "wh-retry", payload });
        assert.equal(retry.duplicate, false);
        assert.equal(smtp.sent.length, 1);
        assert.equal(await count("workspaces"), 1);
    });

    it("11. license allocation failure for an existing customer: licenses unchanged, no email for the failed order", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 5101, customerId: 55, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
        await database.rows(`ALTER TABLE workspaces ADD CONSTRAINT test_seat_cap CHECK (seat_limit <= 5)`);
        const second = order({ orderId: 5102, customerId: 55, items: [{ productId: PRODUCT.large, quantity: 1 }] });

        try {
            await assert.rejects(deliver(smtp, { webhookId: "wh-2", payload: second }), failedBecauseOf("test_seat_cap"));
            assert.equal((await workspaces())[0]?.seat_limit, 4, "the failed allocation changed nothing");
            assert.equal(await count("shopify_orders"), 1, "the second order was rolled back with it");
            assert.equal(await count("billing_events"), 1);
            assert.equal(smtp.sent.length, 1, "no confirmation for an allocation that did not happen");
        } finally {
            await database.rows(`ALTER TABLE workspaces DROP CONSTRAINT test_seat_cap`);
        }

        await deliver(smtp, { webhookId: "wh-2", payload: second });
        assert.equal((await workspaces())[0]?.seat_limit, 8);
        assert.equal(smtp.sent.length, 2);
        assert.match(smtp.sent[1]!.text, /Your workspace now has 8 licenses in total\./);
    });
});

describe("12. an SMTP failure never undoes the order", () => {
    // The queue itself (backoff, retry limits, crash recovery, concurrency, secrets in logs) is tested in
    // shopify.email-outbox.test.ts. These two show the order-level promise.
    it("a temporary outage leaves the committed workspace in place and the email queued for a retry", async () => {
        const smtp = createFakeSmtp({ alwaysFail: smtpErrors.connectionRefused() });
        const { outbox } = await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 6001, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });

        assert.equal(outbox?.retryScheduled, 1);
        assert.equal((await workspaces())[0]?.seat_limit, 4, "the workspace and licenses are committed and untouched");
        assert.equal(await count("shopify_orders"), 1);
        const queued = await outboxRow(database, 6001);
        assert.equal(queued.purchase_email_status, "pending", "still owed, waiting for its next attempt");
        assert.equal(queued.purchase_email_attempts, 1);
        assert.ok(queued.purchase_email_next_attempt_at);
        assert.equal(smtp.sent.length, 0);
    });

    it("a permanent rejection abandons that one email, and the order stands", async () => {
        const smtp = createFakeSmtp({ alwaysFail: smtpError("550 mailbox unavailable", { code: "EENVELOPE", responseCode: 550 }) });
        const { outbox } = await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 6002, items: [{ productId: PRODUCT.small, quantity: 1 }] }) });

        assert.equal(outbox?.abandoned, 1);
        assert.equal((await workspaces())[0]?.seat_limit, 1);
        assert.equal((await outboxRow(database, 6002)).purchase_email_status, "abandoned");
        assert.equal(smtp.attempts, 1, "a permanent failure is never retried");
    });
});

describe("13-14. the customer's email address", () => {
    it("13. an order with no email at all fails loudly: nothing is saved and nothing is sent", async () => {
        const smtp = createFakeSmtp();
        const payload = order({ orderId: 7001, email: null, items: [{ productId: PRODUCT.large, quantity: 1 }] });

        await assert.rejects(deliver(smtp, { webhookId: "wh-1", payload }), /missing purchaser email/);
        assert.equal(smtp.attempts, 0);
        assert.equal(await count("workspaces"), 0);
        assert.equal(await count("shopify_orders"), 0);
        assert.equal(await count("billing_events"), 0, "so Shopify's retry is processed, not skipped as a duplicate");
    });

    it("14. the email goes to the purchaser's address, trimmed and lower-cased", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 7002, email: "  Buyer.Name@Example.COM ", items: [{ productId: PRODUCT.small, quantity: 1 }] }) });
        assert.equal(only(smtp.sent).to, "buyer.name@example.com");
        assert.equal((await workspaces())[0]?.owner_email, "buyer.name@example.com");
    });

    it("14b. falls back to the contact email, then the customer's email", async () => {
        const smtp = createFakeSmtp();
        await deliver(smtp, { webhookId: "wh-1", payload: order({ orderId: 7003, email: null, contactEmail: "contact@example.com", items: [{ productId: PRODUCT.small, quantity: 1 }] }) });
        assert.equal(smtp.sent[0]?.to, "contact@example.com");

        await database.reset();
        const smtp2 = createFakeSmtp();
        const withCustomerEmail = order({ orderId: 7004, email: null, items: [{ productId: PRODUCT.small, quantity: 1 }] });
        (withCustomerEmail.customer as Record<string, unknown>).email = "customer@example.com";
        await deliver(smtp2, { webhookId: "wh-2", payload: withCustomerEmail });
        assert.equal(smtp2.sent[0]?.to, "customer@example.com");
    });
});

// ---------------------------------------------------------------------------
// Through the real HTTP route
// ---------------------------------------------------------------------------

describe("the webhook route: signature, commit, then email in the background", () => {
    const sign = (body: string) => createHmac("sha256", TEST_WEBHOOK_SECRET).update(body).digest("base64");

    async function buildApp(smtp: FakeSmtp) {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        await app.register(fastifyRawBody, { field: "rawBody", global: false, runFirst: true, encoding: false });
        await app.register(errorHandlerPlugin);
        app.decorate("db", database.db);
        const emailDeps = { createTransport: smtp.createTransport };
        await app.register(shopifyRoutes, { prefix: "/api/v1/shopify", emailDeps });
        await app.register(shopifyOrderPaidWebhookRoutes, { prefix: "/shopify/webhooks", emailDeps });
        await app.ready();
        return app;
    }

    async function post(app: Awaited<ReturnType<typeof buildApp>>, input: { url?: string; webhookId: string; payload: Record<string, unknown>; signature?: string; topic?: string }) {
        const body = JSON.stringify(input.payload);
        return app.inject({
            method: "POST",
            url: input.url ?? "/shopify/webhooks/order-paid",
            headers: {
                "content-type": "application/json",
                "x-shopify-hmac-sha256": input.signature ?? sign(body),
                "x-shopify-topic": input.topic ?? "orders/paid",
                "x-shopify-webhook-id": input.webhookId,
                "x-shopify-shop-domain": TEST_SHOP_DOMAIN,
            },
            payload: body,
        });
    }

    it("a signed paid order returns 200, creates the workspace, and queues one confirmation to the buyer", async () => {
        const smtp = createFakeSmtp();
        const app = await buildApp(smtp);
        try {
            const response = await post(app, { webhookId: "wh-http-1", payload: order({ orderId: 8001, orderNumber: 1500, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
            assert.equal(response.statusCode, 200);
            assert.deepEqual(response.json(), { ok: true });

            await waitForQueuedShopifyPurchaseEmails();
            assert.equal((await workspaces())[0]?.seat_limit, 4);
            const message = only(smtp.sent);
            assert.equal(message.to, "buyer@example.com");
            assert.equal(message.subject, LARGE_SUBJECT);
            assert.match(message.text, /Order number: #1500/);
        } finally {
            await app.close();
        }
    });

    it("Shopify retrying the same webhook gets 200 and no second email", async () => {
        const smtp = createFakeSmtp();
        const app = await buildApp(smtp);
        try {
            const payload = order({ orderId: 8002, items: [{ productId: PRODUCT.small, quantity: 1 }] });
            assert.equal((await post(app, { webhookId: "wh-http-2", payload })).statusCode, 200);
            assert.equal((await post(app, { webhookId: "wh-http-2", payload })).statusCode, 200);
            await waitForQueuedShopifyPurchaseEmails();
            assert.equal(smtp.sent.length, 1);
            assert.equal(await count("workspaces"), 1);
        } finally {
            await app.close();
        }
    });

    it("an SMTP outage still answers 200, keeps the committed workspace, and leaves the email queued for the worker", async () => {
        const smtp = createFakeSmtp({ alwaysFail: smtpErrors.connectionRefused() });
        const app = await buildApp(smtp);
        try {
            const response = await post(app, { webhookId: "wh-http-3", payload: order({ orderId: 8003, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
            assert.equal(response.statusCode, 200, "an email problem must never make Shopify retry the order");
            await waitForQueuedShopifyPurchaseEmails();
            assert.equal(smtp.attempts, 1, "one immediate attempt; later attempts belong to the worker");
            assert.equal(await count("workspaces"), 1);
            const queued = await outboxRow(database, 8003);
            assert.equal(queued.purchase_email_status, "pending");
            assert.ok(queued.purchase_email_next_attempt_at && queued.purchase_email_next_attempt_at.getTime() > Date.now(), "the retry is scheduled in the future");
        } finally {
            await app.close();
        }
    });

    it("an invalid signature is rejected before anything is read or written", async () => {
        const smtp = createFakeSmtp();
        const app = await buildApp(smtp);
        try {
            const response = await post(app, { webhookId: "wh-http-4", signature: "bogus", payload: order({ orderId: 8004, items: [{ productId: PRODUCT.large, quantity: 1 }] }) });
            assert.equal(response.statusCode, 401);
            await waitForQueuedShopifyPurchaseEmails();
            assert.equal(smtp.attempts, 0);
            assert.equal(await count("billing_events"), 0);
            assert.equal(await count("workspaces"), 0);
        } finally {
            await app.close();
        }
    });

    it("an unsupported-product order returns 200 with no workspace and no email", async () => {
        const smtp = createFakeSmtp();
        const app = await buildApp(smtp);
        try {
            const response = await post(app, { webhookId: "wh-http-5", payload: order({ orderId: 8005, items: [{ productId: PRODUCT.unrelated, quantity: 1 }] }) });
            assert.equal(response.statusCode, 200);
            await waitForQueuedShopifyPurchaseEmails();
            assert.equal(smtp.attempts, 0);
            assert.equal(await count("workspaces"), 0);
        } finally {
            await app.close();
        }
    });

    it("the compatibility route /api/v1/shopify/webhook sends the same single email", async () => {
        const smtp = createFakeSmtp();
        const app = await buildApp(smtp);
        try {
            const response = await post(app, {
                url: "/api/v1/shopify/webhook",
                webhookId: "wh-http-6",
                payload: order({ orderId: 8006, items: [{ productId: PRODUCT.discover, quantity: 1 }] }),
            });
            assert.equal(response.statusCode, 200);
            await waitForQueuedShopifyPurchaseEmails();
            assert.equal(only(smtp.sent).subject, DISCOVER_SUBJECT);
        } finally {
            await app.close();
        }
    });
});
