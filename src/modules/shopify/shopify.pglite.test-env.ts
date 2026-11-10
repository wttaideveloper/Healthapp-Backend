/**
 * Test support for the Shopify purchase-flow tests. Test-only: the `.test-env.ts` suffix keeps it out of the build.
 *
 * - `createTestDatabase()`: a real, in-memory Postgres (PGlite) with the project's own migrations applied, so the
 *   provisioning SQL (upserts, row locks, advisory locks, transactions and rollbacks) runs for real. Nothing here
 *   touches a real database, and no connection string is read.
 * - `createFakeSmtp()`: a mocked SMTP transport that records messages and can fail on demand. No email is ever sent.
 * - `createCapturingLogger()`: a logger that records every call so tests can assert on what was (not) logged.
 * - `shopifyOrderPayload()`: a Shopify `orders/paid` payload with test data.
 */
import "./shopify.test-env";

import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import {
    SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID,
    SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
    SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
} from "./shopify.constants";
import type { ShopifyPurchaseEmailTransport } from "./shopify.email-delivery";
import type { ShopifyPurchaseEmail } from "./shopify.purchase-email";

export const TEST_SHOP_DOMAIN = "qfiprz-kw.myshopify.com";
export const TEST_WEBHOOK_SECRET = "shopify-webhook-secret";

export const PRODUCT = {
    large: SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
    small: SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
    discover: SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID,
    /** Not a HealthAge product: must never create a workspace or an email. */
    unrelated: "9999999999999",
} as const;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type TestDatabase = {
    /** Shaped like `app.db` for the code under test. */
    db: FastifyInstance["db"];
    app: FastifyInstance;
    /** Runs raw SQL and returns the rows. */
    rows<T = Record<string, unknown>>(query: string): Promise<T[]>;
    /** Runs one or more raw SQL statements (for test triggers and the like). */
    exec(statements: string): Promise<void>;
    /** Empties every table the Shopify flow writes to. */
    reset(): Promise<void>;
    close(): Promise<void>;
};

const TABLES = ["audit_logs", "billing_events", "shopify_orders", "shopify_subscriptions", "shopify_shops", "workspace_members", "workspaces", "users"];

export async function createTestDatabase(): Promise<TestDatabase> {
    const client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../migrations") });

    const asAppDb = db as unknown as FastifyInstance["db"];
    return {
        db: asAppDb,
        app: { db: asAppDb } as unknown as FastifyInstance,
        async rows<T>(query: string): Promise<T[]> {
            const result = await client.query<T>(query);
            return result.rows;
        },
        async exec(statements: string) {
            await client.exec(statements);
        },
        async reset() {
            await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
        },
        async close() {
            await client.close();
        },
    };
}

/** The outbox columns of one order, by Shopify order id. */
export type OutboxRow = {
    purchase_email_status: string;
    purchase_email_attempts: number;
    purchase_email_next_attempt_at: Date | null;
    purchase_email_locked_until: Date | null;
    purchase_email_sent_at: Date | null;
    purchase_email_last_error: string | null;
    purchase_email_payload: Record<string, unknown> | null;
};

export async function outboxRow(database: TestDatabase, shopifyOrderId: string | number): Promise<OutboxRow> {
    const [row] = await database.rows<OutboxRow>(
        `SELECT purchase_email_status, purchase_email_attempts, purchase_email_next_attempt_at, purchase_email_locked_until,
                purchase_email_sent_at, purchase_email_last_error, purchase_email_payload
         FROM shopify_orders WHERE shopify_order_id = '${String(shopifyOrderId)}'`
    );
    if (!row) throw new Error(`No shopify_orders row for order ${shopifyOrderId}`);
    return row;
}

/**
 * A clock the tests move by hand, to step through backoffs and lease expiry. It starts a minute AFTER the real time, so
 * a row queued by the code under test (which stamps the real time) is already due when the first pass runs.
 */
export function createTestClock(startOffsetMs = 60_000) {
    let current = Date.now() + startOffsetMs;
    return {
        now: (): Date => new Date(current),
        advance(ms: number): void {
            current += ms;
        },
    };
}

/** Inserts an existing HealthAge account (a row in `users`) so a purchase sees "an account already exists". */
export async function insertUser(database: TestDatabase, input: { email: string; name: string }): Promise<void> {
    await database.rows(
        `INSERT INTO users (name, email, password_hash) VALUES ('${input.name.replace(/'/g, "''")}', '${input.email}', 'not-a-real-hash')`
    );
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type LoggedCall = { level: string; obj: unknown; msg: string };

export type CapturingLogger = FastifyBaseLogger & {
    calls: LoggedCall[];
    /** Everything logged, serialized: for "this secret never appears" assertions. */
    dump(): string;
};

export function createCapturingLogger(): CapturingLogger {
    const calls: LoggedCall[] = [];
    const record =
        (level: string) =>
        (obj: unknown, msg?: string): void => {
            calls.push(typeof obj === "string" ? { level, obj: undefined, msg: obj } : { level, obj, msg: msg ?? "" });
        };

    const logger = {
        calls,
        level: "trace",
        trace: record("trace"),
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        fatal: record("fatal"),
        silent: () => undefined,
        child: () => logger,
        dump: () => JSON.stringify(calls, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value)),
    };
    return logger as unknown as CapturingLogger;
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export type SentMessage = { from: string; to: string; subject: string; text: string; html: string };

export type FakeSmtp = {
    transport: ShopifyPurchaseEmailTransport;
    /** Messages the (fake) mail server accepted. */
    sent: SentMessage[];
    /** Every sendMail call, accepted or not. */
    attempts: number;
    createTransport: () => ShopifyPurchaseEmailTransport;
};

/**
 * `failures` is consumed one per attempt, in order: an Error makes that attempt fail, `null` lets it through.
 * Once the list is used up every attempt succeeds. `alwaysFail` makes every attempt fail with that error.
 */
export function createFakeSmtp(options: { failures?: ReadonlyArray<Error | null>; alwaysFail?: Error } = {}): FakeSmtp {
    const pending = [...(options.failures ?? [])];
    const smtp: FakeSmtp = {
        sent: [],
        attempts: 0,
        transport: {
            async sendMail(message) {
                smtp.attempts += 1;
                const failure = options.alwaysFail ?? pending.shift() ?? null;
                if (failure) throw failure;
                smtp.sent.push(message);
                return { accepted: [message.to] };
            },
        },
        createTransport: () => smtp.transport,
    };
    return smtp;
}

/** An error shaped like the ones nodemailer throws. */
export function smtpError(message: string, fields: { code?: string; responseCode?: number; command?: string }): Error {
    return Object.assign(new Error(message), fields);
}

export const instantSleep = async (): Promise<void> => undefined;

// ---------------------------------------------------------------------------
// Shopify payloads
// ---------------------------------------------------------------------------

export type TestLineItem = { productId: string; quantity: number; title?: string; variantTitle?: string };

export type OrderPayloadOptions = {
    orderId: number;
    orderNumber?: number | null;
    email?: string | null;
    contactEmail?: string | null;
    firstName?: string;
    lastName?: string;
    customerId?: number;
    items: readonly TestLineItem[];
    processedAt?: string;
    financialStatus?: string;
    cancelledAt?: string | null;
};

const PRODUCT_TITLES: Record<string, string> = {
    [PRODUCT.large]: "Large Venue Kit",
    [PRODUCT.small]: "Small Venue Kit",
    [PRODUCT.discover]: "Discover Your Health Age",
    [PRODUCT.unrelated]: "HealthAge T-Shirt",
};

export function shopifyOrderPayload(options: OrderPayloadOptions): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        id: options.orderId,
        order_number: options.orderNumber === undefined ? 1000 + (options.orderId % 1000) : options.orderNumber,
        financial_status: options.financialStatus ?? "paid",
        fulfillment_status: null,
        currency: "USD",
        total_price: "100.00",
        processed_at: options.processedAt ?? "2026-11-02T10:00:00.000Z",
        cancelled_at: options.cancelledAt ?? null,
        customer: {
            id: options.customerId ?? 7000 + options.orderId,
            first_name: options.firstName ?? "Pat",
            last_name: options.lastName ?? "Morgan",
        },
        line_items: options.items.map((item, index) => ({
            id: options.orderId * 100 + index,
            product_id: Number(item.productId),
            variant_id: 5000 + index,
            variant_title: item.variantTitle ?? null,
            title: item.title ?? PRODUCT_TITLES[item.productId] ?? "Product",
            quantity: item.quantity,
        })),
    };
    if (options.email !== null) payload.email = options.email ?? "buyer@example.com";
    if (options.contactEmail) payload.contact_email = options.contactEmail;
    return payload;
}

/** The consumer of the purchase email in the happy path: a `ShopifyPurchaseEmail` or a clear failure. */
export function expectPurchaseEmail(email: ShopifyPurchaseEmail | null): ShopifyPurchaseEmail {
    if (!email) throw new Error("Expected a purchase email to be produced for this delivery, but there was none.");
    return email;
}
