/**
 * Durable outbox for the Shopify purchase confirmation email.
 *
 * The obligation to email a customer is a row state on `shopify_orders` (`purchase_email_*` columns, migration 0010),
 * written in the SAME transaction that creates the workspace or allocates the licenses. So the promise to send can
 * never be lost to a crash or a rollback, and an email can never describe licenses that were not saved.
 *
 *   none ──enqueue (atomic with the licenses)──▶ pending ──claim──▶ processing ──send ok──▶ sent
 *                                                   ▲                    │
 *                                                   └─ temporary failure ┤  (exponential backoff, then try again)
 *                                                      anything else, or out of attempts ──▶ abandoned
 *
 * Guarantees, and their limits:
 *
 *  - Safe concurrent claiming: a worker claims ONE row with a single `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
 *    LOCKED)`, so two workers (two processes, two servers) can never hold the same order.
 *  - Recovery: a claim is a LEASE (`purchase_email_locked_until`). A worker that dies leaves the row `processing`; when the
 *    lease passes, the next worker takes it over. A claim counts as an attempt, so a worker that keeps crashing cannot loop
 *    forever: when the attempts are used up the row is moved to `abandoned`.
 *  - Completion only applies if the worker still holds ITS lease, and a worker whose lease has run out does not send at all.
 *  - Only a failure that PROVES the message did not reach the mail server is retried (see shopify.email-delivery.ts). A
 *    mid-send drop or timeout is "unknown delivery" and is never repeated: it is abandoned and raised for a person.
 *  - The result is written with retries. If the database is still unreachable after a send that SUCCEEDED, the outcome is
 *    remembered in this process (`unrecordedOutcomes`) so that when the row is reclaimed here it is recorded, not sent again.
 *    That memory does not survive a restart, and another server cannot see it: that is the one remaining duplicate window.
 *  - An order cancelled or (partly) refunded while its email was queued is not confirmed: it is skipped at claim time.
 *  - Every database call has a timeout, so a hung connection cannot wedge the worker; each pass catches its own failures.
 *  - Historical orders are never touched: every existing row is `none`, and nothing here selects `none`.
 *
 *  - It is AT-LEAST-ONCE, not exactly-once. A duplicate needs the mail server to accept the message AND the result to be
 *    lost: the process dying between the two, or the database staying down for longer than the lease (see above).
 *  - `abandoned` needs a person: see the README ("Monitoring" and "Requeue an abandoned email").
 */
import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import z from "zod";

import { shopifyOrders } from "@db/schema";

import {
    attemptSendPurchaseEmail,
    formatErrorNote,
    maskEmailForLog,
    summarizeEmailError,
    type ShopifyPurchaseEmailSendDeps,
} from "./shopify.email-delivery";
import { isShopifyOrderContributingLicenses } from "./shopify.license";
import type { ShopifyPurchaseEmail } from "./shopify.purchase-email";

export type OutboxDb = Pick<FastifyInstance["db"], "select" | "update" | "execute">;

export const PURCHASE_EMAIL_STATUS = {
    none: "none",
    pending: "pending",
    processing: "processing",
    sent: "sent",
    abandoned: "abandoned",
} as const;

/** Attempts per email, the first send included. */
export const PURCHASE_EMAIL_MAX_ATTEMPTS = 8;
/** How long a claim is held. Much longer than the longest single send, so a live worker never loses its lease. */
export const PURCHASE_EMAIL_LEASE_MS = 5 * 60_000;
/** The wait after a failed attempt: 1 min, doubling, capped at 1 hour. */
export const PURCHASE_EMAIL_BACKOFF_BASE_MS = 60_000;
export const PURCHASE_EMAIL_BACKOFF_CAP_MS = 60 * 60_000;
/** The worker's scan interval, its first scan after start-up, and the most emails it sends per scan. */
export const PURCHASE_EMAIL_WORKER_INTERVAL_MS = 30_000;
export const PURCHASE_EMAIL_WORKER_INITIAL_DELAY_MS = 5_000;
export const PURCHASE_EMAIL_WORKER_BATCH_LIMIT = 25;
/** The longest any single database call may take before the outbox gives up on it. */
export const PURCHASE_EMAIL_DB_TIMEOUT_MS = 25_000;
/** Waits between attempts to record a result in the database (about 46 s in all), never past the lease. */
export const PURCHASE_EMAIL_COMPLETION_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
/** How long shutdown waits for a send in progress before letting go (the lease recovers it after a restart). */
export const PURCHASE_EMAIL_SHUTDOWN_GRACE_MS = 25_000;
/** Alerting: how often the "needs attention" report repeats, how late counts as overdue, how far back abandoned ones count. */
export const PURCHASE_EMAIL_ALERT_INTERVAL_MS = 60 * 60_000;
export const PURCHASE_EMAIL_OVERDUE_AFTER_MS = 30 * 60_000;
export const PURCHASE_EMAIL_ABANDONED_REPORT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The stable `alert` field on the log lines that should page someone. Match on these in the log pipeline. */
export const PURCHASE_EMAIL_ALERT = {
    abandoned: "shopify_purchase_email_abandoned",
    unrecorded: "shopify_purchase_email_unrecorded",
    attention: "shopify_purchase_email_attention",
} as const;

/** An abandoned row whose note starts with this is NOT a failure: the order was cancelled or refunded, so no email is owed. */
export const SKIPPED_NOTE_PREFIX = "Skipped:";

/** Wait before the next try after `failedAttempts` failures: 1, 2, 4, 8, 16, 32, 60, 60 ... minutes. */
export function purchaseEmailBackoffMs(failedAttempts: number): number {
    const exponent = Math.max(failedAttempts - 1, 0);
    return Math.min(PURCHASE_EMAIL_BACKOFF_BASE_MS * 2 ** exponent, PURCHASE_EMAIL_BACKOFF_CAP_MS);
}

/**
 * A result a worker had but could not save because the database was unreachable. Keyed by Shopify order id. Only the
 * results that must NOT be repeated are kept: a delivered email, or an abandonment after an ambiguous send.
 */
export type UnrecordedOutcome = { kind: "sent" } | { kind: "abandoned"; note: string };
export type UnrecordedOutcomes = Map<string, UnrecordedOutcome>;

const sharedUnrecordedOutcomes: UnrecordedOutcomes = new Map();
const UNRECORDED_CAP = 500;

/** For tests. */
export function clearUnrecordedPurchaseEmailOutcomes(): void {
    sharedUnrecordedOutcomes.clear();
}

export function unrecordedPurchaseEmailOutcomeCount(): number {
    return sharedUnrecordedOutcomes.size;
}

export type PurchaseEmailOutboxDeps = ShopifyPurchaseEmailSendDeps & {
    /** The clock. Tests move it to step through backoffs and lease expiry. */
    now?: () => Date;
    leaseMs?: number;
    maxAttempts?: number;
    backoffMs?: (failedAttempts: number) => number;
    /** Longest any single database call may take. */
    dbTimeoutMs?: number;
    /** Waits between attempts to record a result. Tests pass an instant one. */
    sleep?: (ms: number) => Promise<void>;
    /** Delays between attempts to record a result in the database; its length is the number of retries. */
    completionRetryDelaysMs?: readonly number[];
    /** Where unrecorded results are remembered. Defaults to a process-wide map. */
    unrecordedOutcomes?: UnrecordedOutcomes;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Database calls never wait forever
// ---------------------------------------------------------------------------

export class OutboxDbTimeoutError extends Error {
    readonly code = "EOUTBOXDBTIMEOUT";
    constructor(label: string, ms: number) {
        super(`Database call "${label}" took longer than ${ms} ms`);
        this.name = "OutboxDbTimeoutError";
    }
}

/**
 * Gives a database call a deadline. node-postgres has no default query timeout, so one dead connection could otherwise
 * stall the worker for good (a pass never overlaps itself). The call itself may still finish later; every write it
 * could make is guarded by the lease, so a late finish is harmless.
 */
function guarded<T>(label: string, ms: number, call: () => PromiseLike<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OutboxDbTimeoutError(label, ms)), ms);
    });
    let started: Promise<T>;
    try {
        started = Promise.resolve(call());
    } catch (error) {
        started = Promise.reject(error);
    }
    return Promise.race([started, deadline]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

// ---------------------------------------------------------------------------
// The stored snapshot
// ---------------------------------------------------------------------------

const lineSchema = z.object({
    productId: z.enum(["small_venue_kit", "large_venue_kit", "discover_your_health_age"]),
    label: z.string().min(1),
    quantity: z.number().int().positive(),
    licenses: z.number().int().positive(),
});

/** What is stored in `purchase_email_payload`, and re-checked every time it is read back. */
export const purchaseEmailSnapshotSchema = z.object({
    recipientEmail: z.string().min(3),
    customerName: z.string(),
    orderNumber: z.string().nullable(),
    scenario: z.enum(["new_workspace", "existing_workspace"]),
    workspaceName: z.string(),
    workspaceOwnerEmail: z.string().min(3),
    accountExists: z.boolean(),
    lines: z.array(lineSchema).min(1),
    licensesAdded: z.number().int().positive(),
    workspaceTotalLicenses: z.number().int().positive(),
    purchasedAt: z.string().nullable(),
    accessExpiresAt: z.string().nullable(),
    hasOtherItems: z.boolean(),
    workspaceId: z.string().min(1),
    shopifyOrderId: z.string().min(1),
});

const iso = (date: Date) => sql`${date.toISOString()}::timestamptz`;

// ---------------------------------------------------------------------------
// Enqueue: called INSIDE the paid-order transaction
// ---------------------------------------------------------------------------

/**
 * Records that this order owes its customer a confirmation, atomically with the licenses it just allocated. Returns true
 * when the email is now queued. It is a no-op (false) if one was already queued or sent for this order, so a repeated
 * delivery can never queue a second email, and it never queues a snapshot that would not pass validation: a bug in the
 * email must not be able to fail the order.
 */
export async function enqueueShopifyPurchaseEmail(
    db: Pick<FastifyInstance["db"], "update">,
    log: FastifyBaseLogger,
    input: { shopifyOrderRecordId: string; email: ShopifyPurchaseEmail; now?: Date }
): Promise<boolean> {
    const parsed = purchaseEmailSnapshotSchema.safeParse(input.email);
    if (!parsed.success) {
        log.error(
            { shopifyOrderId: input.email.shopifyOrderId, issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
            "Shopify purchase email was not queued: its content failed validation"
        );
        return false;
    }

    const now = input.now ?? new Date();
    const queued = await db
        .update(shopifyOrders)
        .set({
            purchaseEmailStatus: PURCHASE_EMAIL_STATUS.pending,
            purchaseEmailPayload: parsed.data,
            purchaseEmailAttempts: 0,
            purchaseEmailNextAttemptAt: now,
            purchaseEmailLockedUntil: null,
            purchaseEmailSentAt: null,
            purchaseEmailLastError: null,
            updatedAt: now,
        })
        .where(and(eq(shopifyOrders.id, input.shopifyOrderRecordId), eq(shopifyOrders.purchaseEmailStatus, PURCHASE_EMAIL_STATUS.none)))
        .returning({ id: shopifyOrders.id });

    if (queued.length !== 1) {
        log.warn({ shopifyOrderId: input.email.shopifyOrderId }, "Shopify purchase email was not queued: one is already queued or sent for this order");
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export type ClaimedPurchaseEmail = {
    id: string;
    shopifyOrderId: string;
    /** This claim's attempt number, counting from 1. */
    attempt: number;
    /** The lease this claim holds; completion is conditional on still holding it. */
    leaseUntil: Date;
    /** The raw stored snapshot, validated by `processClaimedPurchaseEmail`. */
    payload: unknown;
    /** The ORDER's status and seat count as of the claim (read in the same statement), to catch a cancellation or refund. */
    orderStatus: string;
    orderSeatQuantity: number;
};

/**
 * Claims the next email that is due: a `pending` one whose time has come, or a `processing` one whose worker's lease has
 * run out. One statement, atomic: `FOR UPDATE SKIP LOCKED` makes concurrent workers pass over rows another worker is
 * claiming, and the outer UPDATE re-checks nothing else has changed. Returns null when nothing is due.
 */
export async function claimNextPurchaseEmail(
    db: Pick<FastifyInstance["db"], "execute">,
    options: { now: Date; leaseMs: number; maxAttempts: number; shopifyOrderId?: string; dbTimeoutMs?: number }
): Promise<ClaimedPurchaseEmail | null> {
    const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
    const onlyThisOrder = options.shopifyOrderId ? sql`AND shopify_order_id = ${options.shopifyOrderId}` : sql``;

    const result = (await guarded(
        "claim",
        options.dbTimeoutMs ?? PURCHASE_EMAIL_DB_TIMEOUT_MS,
        () => db.execute(sql`
        UPDATE shopify_orders
        SET purchase_email_status = 'processing',
            purchase_email_attempts = purchase_email_attempts + 1,
            purchase_email_locked_until = ${iso(leaseUntil)},
            updated_at = ${iso(options.now)}
        WHERE id = (
            SELECT id FROM shopify_orders
            WHERE purchase_email_payload IS NOT NULL
              AND purchase_email_attempts < ${options.maxAttempts}
              AND (
                    (purchase_email_status = 'pending' AND purchase_email_next_attempt_at <= ${iso(options.now)})
                 OR (purchase_email_status = 'processing' AND purchase_email_locked_until < ${iso(options.now)})
              )
              ${onlyThisOrder}
            ORDER BY purchase_email_next_attempt_at NULLS LAST, created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, shopify_order_id, purchase_email_attempts AS attempts, purchase_email_payload AS payload,
                  status AS order_status, seat_quantity AS order_seat_quantity
    `)
    )) as unknown as { rows: Array<Record<string, unknown>> };

    const row = result.rows[0];
    if (!row) return null;

    return {
        id: String(row.id),
        shopifyOrderId: String(row.shopify_order_id),
        attempt: Number(row.attempts),
        leaseUntil,
        payload: row.payload,
        orderStatus: String(row.order_status),
        orderSeatQuantity: Number(row.order_seat_quantity),
    };
}

// ---------------------------------------------------------------------------
// Completion: each one applies only if this worker still holds its lease
// ---------------------------------------------------------------------------

const holdingLease = (claim: ClaimedPurchaseEmail) =>
    and(
        eq(shopifyOrders.id, claim.id),
        eq(shopifyOrders.purchaseEmailStatus, PURCHASE_EMAIL_STATUS.processing),
        eq(shopifyOrders.purchaseEmailLockedUntil, claim.leaseUntil)
    );

type UpdateDb = Pick<FastifyInstance["db"], "update">;

async function markSent(db: UpdateDb, claim: ClaimedPurchaseEmail, now: Date, timeoutMs: number): Promise<boolean> {
    const rows = await guarded("record sent", timeoutMs, () =>
        db
            .update(shopifyOrders)
            .set({
                purchaseEmailStatus: PURCHASE_EMAIL_STATUS.sent,
                purchaseEmailSentAt: now,
                purchaseEmailLockedUntil: null,
                purchaseEmailNextAttemptAt: null,
                purchaseEmailLastError: null,
                updatedAt: now,
            })
            .where(holdingLease(claim))
            .returning({ id: shopifyOrders.id })
    );
    return rows.length === 1;
}

async function markRetry(db: UpdateDb, claim: ClaimedPurchaseEmail, now: Date, nextAttemptAt: Date, note: string, timeoutMs: number): Promise<boolean> {
    const rows = await guarded("schedule retry", timeoutMs, () =>
        db
            .update(shopifyOrders)
            .set({
                purchaseEmailStatus: PURCHASE_EMAIL_STATUS.pending,
                purchaseEmailNextAttemptAt: nextAttemptAt,
                purchaseEmailLockedUntil: null,
                purchaseEmailLastError: note,
                updatedAt: now,
            })
            .where(holdingLease(claim))
            .returning({ id: shopifyOrders.id })
    );
    return rows.length === 1;
}

async function markAbandoned(db: UpdateDb, claim: ClaimedPurchaseEmail, now: Date, note: string, timeoutMs: number): Promise<boolean> {
    const rows = await guarded("record abandoned", timeoutMs, () =>
        db
            .update(shopifyOrders)
            .set({
                purchaseEmailStatus: PURCHASE_EMAIL_STATUS.abandoned,
                purchaseEmailNextAttemptAt: null,
                purchaseEmailLockedUntil: null,
                purchaseEmailLastError: note.slice(0, 400),
                updatedAt: now,
            })
            .where(holdingLease(claim))
            .returning({ id: shopifyOrders.id })
    );
    return rows.length === 1;
}

type RecordResult = { recorded: true; held: boolean } | { recorded: false; error: unknown };

/**
 * Writes a result, retrying if the database is briefly unavailable. It never waits past the lease: after that another
 * worker may own the email, and a late write would be refused anyway.
 */
async function recordWithRetry(
    write: () => Promise<boolean>,
    claim: ClaimedPurchaseEmail,
    log: FastifyBaseLogger,
    deps: PurchaseEmailOutboxDeps,
    context: Record<string, unknown>
): Promise<RecordResult> {
    const clock = deps.now ?? (() => new Date());
    const sleep = deps.sleep ?? defaultSleep;
    const delays = deps.completionRetryDelaysMs ?? PURCHASE_EMAIL_COMPLETION_RETRY_DELAYS_MS;

    for (let retry = 0; ; retry += 1) {
        try {
            return { recorded: true, held: await write() };
        } catch (error) {
            const delay = delays[retry];
            if (delay === undefined || clock().getTime() + delay >= claim.leaseUntil.getTime()) return { recorded: false, error };
            log.warn({ ...context, retryInMs: delay, err: summarizeEmailError(error) }, "Could not record the result of a Shopify purchase email; retrying the database write");
            await sleep(delay);
        }
    }
}

function rememberUnrecorded(deps: PurchaseEmailOutboxDeps, shopifyOrderId: string, outcome: UnrecordedOutcome): void {
    const memory = deps.unrecordedOutcomes ?? sharedUnrecordedOutcomes;
    if (memory.size >= UNRECORDED_CAP && !memory.has(shopifyOrderId)) {
        const oldest = memory.keys().next().value;
        if (oldest !== undefined) memory.delete(oldest);
    }
    memory.set(shopifyOrderId, outcome);
}

// ---------------------------------------------------------------------------
// Process one claim
// ---------------------------------------------------------------------------

export type PurchaseEmailOutcome =
    | "sent"
    | "retry_scheduled"
    | "abandoned"
    /** The order was cancelled or refunded before the email went out, so none was sent (stored as `abandoned` with a "Skipped:" note). */
    | "skipped"
    | "lost_lease"
    /** The database stayed unreachable, so the result could not be saved; see `unrecordedOutcomes`. */
    | "unrecorded";

/** Sends one claimed email and records the result. Never throws on an email or database problem. */
export async function processClaimedPurchaseEmail(
    db: UpdateDb,
    log: FastifyBaseLogger,
    claim: ClaimedPurchaseEmail,
    deps: PurchaseEmailOutboxDeps = {}
): Promise<PurchaseEmailOutcome> {
    const clock = deps.now ?? (() => new Date());
    const maxAttempts = deps.maxAttempts ?? PURCHASE_EMAIL_MAX_ATTEMPTS;
    const dbMs = deps.dbTimeoutMs ?? PURCHASE_EMAIL_DB_TIMEOUT_MS;
    const memory = deps.unrecordedOutcomes ?? sharedUnrecordedOutcomes;
    const context = { shopifyOrderId: claim.shopifyOrderId, attempt: claim.attempt, maxAttempts };

    // 0. An earlier pass in this process already finished this email but could not save the result. Save it now. Sending
    //    again is exactly what must not happen.
    const earlier = memory.get(claim.shopifyOrderId);
    if (earlier) {
        const write = earlier.kind === "sent" ? () => markSent(db, claim, clock(), dbMs) : () => markAbandoned(db, claim, clock(), earlier.note, dbMs);
        const saved = await recordWithRetry(write, claim, log, deps, context);
        if (!saved.recorded) {
            log.error({ ...context, alert: PURCHASE_EMAIL_ALERT.unrecorded, err: summarizeEmailError(saved.error) }, "Still cannot record the result of a Shopify purchase email; it will NOT be sent again by this process");
            return "unrecorded";
        }
        memory.delete(claim.shopifyOrderId);
        log.warn({ ...context, leaseHeld: saved.held }, "Recorded the result of a Shopify purchase email that an earlier pass could not save; it was not sent again");
        return earlier.kind === "sent" ? "sent" : "abandoned";
    }

    // 1. The stored snapshot must still be valid.
    const snapshot = purchaseEmailSnapshotSchema.safeParse(claim.payload);
    if (!snapshot.success) {
        const saved = await recordWithRetry(() => markAbandoned(db, claim, clock(), "The stored email content is invalid", dbMs), claim, log, deps, context);
        log.error({ ...context, alert: PURCHASE_EMAIL_ALERT.abandoned, reason: "invalid_snapshot" }, "Shopify purchase email abandoned: the stored content is invalid");
        return saved.recorded ? (saved.held ? "abandoned" : "lost_lease") : "unrecorded";
    }
    const email = snapshot.data;
    const recipient = maskEmailForLog(email.recipientEmail);

    // 2. An order cancelled or (partly) refunded while the email was queued is not confirmed. The status was read in the same
    //    statement as the claim.
    const inactive = !isShopifyOrderContributingLicenses(claim.orderStatus)
        ? "the order was cancelled or refunded"
        : claim.orderSeatQuantity < email.licensesAdded
          ? "part of the order was refunded after the confirmation was queued"
          : null;
    if (inactive) {
        const note = `${SKIPPED_NOTE_PREFIX} ${inactive} before the confirmation was sent`;
        const saved = await recordWithRetry(() => markAbandoned(db, claim, clock(), note, dbMs), claim, log, deps, context);
        log.warn({ ...context, reason: inactive, orderStatus: claim.orderStatus }, "Shopify purchase confirmation email skipped: the order is no longer a live purchase");
        return saved.recorded ? (saved.held ? "skipped" : "lost_lease") : "unrecorded";
    }

    // 3. A worker that stalled (a slow database, a long pause) may find its lease already over: another worker can own this
    //    email now. Sending anyway is the one way two workers could both mail it, so check the lease right before sending.
    if (clock().getTime() >= claim.leaseUntil.getTime()) {
        log.warn({ ...context }, "Shopify purchase email not sent: this worker's lease expired before it could send; another worker may take it over");
        return "lost_lease";
    }

    // 4. Send.
    const result = await attemptSendPurchaseEmail(email, deps);

    // 5a. Delivered.
    if (result.ok) {
        const saved = await recordWithRetry(() => markSent(db, claim, clock(), dbMs), claim, log, deps, context);
        if (!saved.recorded) {
            // Delivered, and we cannot say so. Remember it, so that when this row is reclaimed here it is recorded, not re-sent.
            rememberUnrecorded(deps, claim.shopifyOrderId, { kind: "sent" });
            log.error(
                { ...context, alert: PURCHASE_EMAIL_ALERT.unrecorded, recipient, err: summarizeEmailError(saved.error) },
                "Shopify purchase confirmation email was SENT but the database would not record it; it is remembered in memory so this process will not send it again"
            );
            return "unrecorded";
        }
        if (saved.held) {
            log.info({ ...context, workspaceId: email.workspaceId, recipient }, "Sent Shopify purchase confirmation email");
            return "sent";
        }
        log.warn(
            { ...context, recipient },
            "Sent Shopify purchase confirmation email, but this worker no longer held its lease (another worker took the order over, or the result was already recorded); a duplicate copy is possible"
        );
        return "lost_lease";
    }

    const note = formatErrorNote(result.error);

    // 5b. Not delivered, and provably so: schedule the next attempt.
    if (result.failure === "retry" && claim.attempt < maxAttempts) {
        const now = clock();
        const wait = (deps.backoffMs ?? purchaseEmailBackoffMs)(claim.attempt);
        const saved = await recordWithRetry(() => markRetry(db, claim, now, new Date(now.getTime() + wait), note, dbMs), claim, log, deps, context);
        log.warn({ ...context, recipient, retryInMs: wait, err: result.error, leaseHeld: saved.recorded ? saved.held : null }, "Temporary problem sending Shopify purchase confirmation email; it will be retried");
        // If the retry could not be saved the row stays `processing`; its lease will run out and it will be tried again. That is safe: nothing was delivered.
        return saved.recorded ? (saved.held ? "retry_scheduled" : "lost_lease") : "unrecorded";
    }

    // 5c. Abandon: out of attempts, rejected for good, or delivery unknown. All three raise the alert.
    const reason =
        result.failure === "retry"
            ? `Gave up after ${claim.attempt} attempts. ${note}`
            : result.failure === "unknown_delivery"
              ? `Delivery outcome unknown (${result.stage}); not retried because the server may already have the message. ${note}`
              : `Permanent failure (${result.stage}). ${note}`;
    const saved = await recordWithRetry(() => markAbandoned(db, claim, clock(), reason, dbMs), claim, log, deps, context);
    log.error(
        { ...context, alert: PURCHASE_EMAIL_ALERT.abandoned, recipient, stage: result.stage, failure: result.failure, err: result.error, leaseHeld: saved.recorded ? saved.held : null },
        "Shopify purchase confirmation email abandoned; it will not be retried automatically and needs a person"
    );
    if (!saved.recorded) {
        // Do not let the lease run out and a later claim mail it again after an ambiguous send.
        rememberUnrecorded(deps, claim.shopifyOrderId, { kind: "abandoned", note: reason });
        return "unrecorded";
    }
    return saved.held ? "abandoned" : "lost_lease";
}

// ---------------------------------------------------------------------------
// Run the outbox
// ---------------------------------------------------------------------------

export type PurchaseEmailRunSummary = {
    claimed: number;
    sent: number;
    retryScheduled: number;
    abandoned: number;
    skipped: number;
    lostLease: number;
    unrecorded: number;
    /** Stuck `processing` rows that had no attempts left and were moved to `abandoned` by the recovery sweep. */
    recoveredAsAbandoned: number;
};

/**
 * A worker that died with no attempts left can never be retried: move those rows to `abandoned` so they are visible
 * to a person instead of sitting in `processing` forever.
 */
export async function abandonExhaustedPurchaseEmails(
    db: Pick<FastifyInstance["db"], "execute">,
    log: FastifyBaseLogger,
    options: { now: Date; maxAttempts: number; dbTimeoutMs?: number }
): Promise<number> {
    const result = (await guarded(
        "recover exhausted",
        options.dbTimeoutMs ?? PURCHASE_EMAIL_DB_TIMEOUT_MS,
        () => db.execute(sql`
        UPDATE shopify_orders
        SET purchase_email_status = 'abandoned',
            purchase_email_locked_until = NULL,
            purchase_email_next_attempt_at = NULL,
            purchase_email_last_error = 'A worker stopped while sending and no attempts were left',
            updated_at = ${iso(options.now)}
        WHERE purchase_email_status = 'processing'
          AND purchase_email_locked_until < ${iso(options.now)}
          AND purchase_email_attempts >= ${options.maxAttempts}
        RETURNING shopify_order_id
    `)
    )) as unknown as { rows: Array<Record<string, unknown>> };

    for (const row of result.rows) {
        log.error(
            { shopifyOrderId: String(row.shopify_order_id), alert: PURCHASE_EMAIL_ALERT.abandoned, reason: "worker_stopped_no_attempts_left" },
            "Shopify purchase email abandoned: a worker stopped while sending and no attempts were left"
        );
    }
    return result.rows.length;
}

/**
 * One pass over the outbox: recover exhausted rows, then claim and send due emails one at a time (up to `limit`).
 * With `shopifyOrderId` it only looks at that order (the immediate send after a purchase). `shouldStop` lets shutdown
 * end a pass between emails.
 */
export async function runPurchaseEmailOutbox(
    db: OutboxDb,
    log: FastifyBaseLogger,
    deps: PurchaseEmailOutboxDeps = {},
    options: { shopifyOrderId?: string; limit?: number; shouldStop?: () => boolean } = {}
): Promise<PurchaseEmailRunSummary> {
    const clock = deps.now ?? (() => new Date());
    const maxAttempts = deps.maxAttempts ?? PURCHASE_EMAIL_MAX_ATTEMPTS;
    const leaseMs = deps.leaseMs ?? PURCHASE_EMAIL_LEASE_MS;
    const dbTimeoutMs = deps.dbTimeoutMs ?? PURCHASE_EMAIL_DB_TIMEOUT_MS;
    const limit = options.limit ?? PURCHASE_EMAIL_WORKER_BATCH_LIMIT;

    const summary: PurchaseEmailRunSummary = { claimed: 0, sent: 0, retryScheduled: 0, abandoned: 0, skipped: 0, lostLease: 0, unrecorded: 0, recoveredAsAbandoned: 0 };

    summary.recoveredAsAbandoned = await abandonExhaustedPurchaseEmails(db, log, { now: clock(), maxAttempts, dbTimeoutMs });

    while (summary.claimed < limit && !options.shouldStop?.()) {
        const claim = await claimNextPurchaseEmail(db, { now: clock(), leaseMs, maxAttempts, shopifyOrderId: options.shopifyOrderId, dbTimeoutMs });
        if (!claim) break;

        summary.claimed += 1;
        const outcome = await processClaimedPurchaseEmail(db, log, claim, deps);
        if (outcome === "sent") summary.sent += 1;
        else if (outcome === "retry_scheduled") summary.retryScheduled += 1;
        else if (outcome === "abandoned") summary.abandoned += 1;
        else if (outcome === "skipped") summary.skipped += 1;
        else if (outcome === "unrecorded") summary.unrecorded += 1;
        else summary.lostLease += 1;
    }

    return summary;
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

export type PurchaseEmailAttention = {
    /** Abandoned in the last 7 days and needing a person (cancelled/refunded "Skipped:" ones are not counted). */
    abandoned: number;
    /** `pending` and more than 30 minutes overdue: the worker is not keeping up, or is not running. */
    overdue: number;
    /** `processing` with a lease that ran out more than 30 minutes ago. */
    stuck: number;
    /** How long the longest-waiting one has needed attention: since abandoned, since due, or since its lease lapsed. */
    oldestAgeMinutes: number;
    orderIds: string[];
};

/**
 * Looks for purchase emails that need a person and, if there are any, logs ONE error line with the stable `alert` key
 * `shopify_purchase_email_attention` (counts, the oldest age, and up to 10 Shopify order ids). The worker repeats it every
 * hour while the problem lasts, so a missed page is not the end of it. Returns null when everything is healthy.
 */
export async function reportPurchaseEmailsNeedingAttention(
    db: Pick<FastifyInstance["db"], "execute">,
    log: FastifyBaseLogger,
    options: { now: Date; dbTimeoutMs?: number; overdueAfterMs?: number; abandonedWindowMs?: number }
): Promise<PurchaseEmailAttention | null> {
    const overdueBefore = new Date(options.now.getTime() - (options.overdueAfterMs ?? PURCHASE_EMAIL_OVERDUE_AFTER_MS));
    const abandonedSince = new Date(options.now.getTime() - (options.abandonedWindowMs ?? PURCHASE_EMAIL_ABANDONED_REPORT_WINDOW_MS));

    const result = (await guarded(
        "attention report",
        options.dbTimeoutMs ?? PURCHASE_EMAIL_DB_TIMEOUT_MS,
        () => db.execute(sql`
        SELECT purchase_email_status AS kind, shopify_order_id,
               -- how long it has needed attention: since it was abandoned, since it fell due, or since its lease lapsed
               CASE purchase_email_status
                    WHEN 'abandoned' THEN updated_at
                    WHEN 'pending' THEN purchase_email_next_attempt_at
                    ELSE purchase_email_locked_until
               END AS since
        FROM shopify_orders
        WHERE (purchase_email_status = 'abandoned'
               AND updated_at > ${iso(abandonedSince)}
               AND coalesce(purchase_email_last_error, '') NOT LIKE ${`${SKIPPED_NOTE_PREFIX}%`})
           OR (purchase_email_status = 'pending' AND purchase_email_next_attempt_at < ${iso(overdueBefore)})
           OR (purchase_email_status = 'processing' AND purchase_email_locked_until < ${iso(overdueBefore)})
        ORDER BY since
        LIMIT 500
    `)
    )) as unknown as { rows: Array<Record<string, unknown>> };

    if (result.rows.length === 0) return null;

    const count = (kind: string) => result.rows.filter((row) => row.kind === kind).length;
    const oldest = Math.min(...result.rows.map((row) => new Date(row.since as string | Date).getTime()));
    const report: PurchaseEmailAttention = {
        abandoned: count("abandoned"),
        overdue: count("pending"),
        stuck: count("processing"),
        oldestAgeMinutes: Math.max(Math.round((options.now.getTime() - oldest) / 60_000), 0),
        orderIds: result.rows.slice(0, 10).map((row) => String(row.shopify_order_id)),
    };

    log.error(
        { alert: PURCHASE_EMAIL_ALERT.attention, ...report },
        `Shopify purchase emails need attention: ${report.abandoned} abandoned, ${report.overdue} overdue, ${report.stuck} stuck`
    );
    return report;
}

// ---------------------------------------------------------------------------
// The immediate send after a purchase
// ---------------------------------------------------------------------------

const pendingDeliveries = new Set<Promise<void>>();

/**
 * Sends a just-committed order's confirmation in the background, so the webhook answers Shopify at once. If it fails
 * or the process dies, nothing is lost: the order is already queued in the database and the worker picks it up.
 */
export function queueShopifyPurchaseEmailDelivery(
    db: OutboxDb,
    log: FastifyBaseLogger,
    shopifyOrderId: string,
    deps?: PurchaseEmailOutboxDeps
): void {
    const task: Promise<void> = runPurchaseEmailOutbox(db, log, deps, { shopifyOrderId, limit: 1 })
        .then(() => undefined)
        .catch((error: unknown) => {
            log.error({ err: summarizeEmailError(error), shopifyOrderId }, "Immediate Shopify purchase email send failed; the worker will pick it up");
        })
        .finally(() => {
            pendingDeliveries.delete(task);
        });
    pendingDeliveries.add(task);
}

/** Resolves when every immediate send has finished. For tests. */
export async function waitForQueuedShopifyPurchaseEmails(): Promise<void> {
    await Promise.allSettled([...pendingDeliveries]);
}

/**
 * For shutdown: waits for the immediate sends already in progress, but no longer than `timeoutMs`. Anything still running
 * after that is left; it stays `processing`, and its lease lets the worker recover it after the restart.
 */
export async function drainQueuedShopifyPurchaseEmails(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
    if (pendingDeliveries.size === 0) return { drained: true, remaining: 0 };

    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const finished = Promise.allSettled([...pendingDeliveries]).then(() => true as const);
    const drained = await Promise.race([finished, expired]);
    if (timer) clearTimeout(timer);
    return { drained, remaining: pendingDeliveries.size };
}

// ---------------------------------------------------------------------------
// The background worker
// ---------------------------------------------------------------------------

export type PurchaseEmailWorker = {
    /** Runs one pass now (used by tests, and by the timer). */
    tick(): Promise<PurchaseEmailRunSummary | null>;
    /**
     * Stops the timer, stops the pass in progress from starting another email, and waits for the email being sent, but no
     * longer than `timeoutMs`. `timedOut` is true if it was still working when the wait ended.
     */
    stop(options?: { timeoutMs?: number }): Promise<{ timedOut: boolean }>;
};

/**
 * Starts the periodic worker: a first pass shortly after start-up (this is the recovery after a restart: it picks up
 * emails that were pending, due for a retry, or stuck in `processing` when the previous process stopped), then one
 * every `intervalMs`. Passes never overlap. A failed pass (a database error or timeout) is logged and the next one tries
 * again. After each pass it checks for emails that need a person and, while any do, repeats the alert at most once per
 * `alertIntervalMs`.
 */
export function startPurchaseEmailOutboxWorker(options: {
    db: OutboxDb;
    log: FastifyBaseLogger;
    deps?: PurchaseEmailOutboxDeps;
    intervalMs?: number;
    initialDelayMs?: number;
    alertIntervalMs?: number;
}): PurchaseEmailWorker {
    const intervalMs = options.intervalMs ?? PURCHASE_EMAIL_WORKER_INTERVAL_MS;
    const alertIntervalMs = options.alertIntervalMs ?? PURCHASE_EMAIL_ALERT_INTERVAL_MS;
    const clock = options.deps?.now ?? (() => new Date());
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<PurchaseEmailRunSummary | null> | undefined;
    let lastAlertAt: number | undefined;

    const checkForAttention = async () => {
        const now = clock();
        if (lastAlertAt !== undefined && now.getTime() - lastAlertAt < alertIntervalMs) return;
        try {
            const report = await reportPurchaseEmailsNeedingAttention(options.db, options.log, { now, dbTimeoutMs: options.deps?.dbTimeoutMs });
            if (report) lastAlertAt = now.getTime();
        } catch (error) {
            options.log.error({ err: summarizeEmailError(error) }, "Shopify purchase email attention check failed; it will try again");
        }
    };

    const tick = (): Promise<PurchaseEmailRunSummary | null> => {
        if (running) return running;
        running = runPurchaseEmailOutbox(options.db, options.log, options.deps, { shouldStop: () => stopped })
            .then((summary) => {
                if (summary.claimed > 0 || summary.recoveredAsAbandoned > 0) {
                    options.log.info({ ...summary }, "Shopify purchase email worker pass finished");
                }
                return summary;
            })
            .catch((error: unknown) => {
                options.log.error({ err: summarizeEmailError(error) }, "Shopify purchase email worker pass failed; it will try again");
                return null;
            })
            .then(async (summary) => {
                if (!stopped) await checkForAttention();
                return summary;
            })
            .finally(() => {
                running = undefined;
            });
        return running;
    };

    const schedule = (delayMs: number) => {
        if (stopped) return;
        timer = setTimeout(() => {
            void tick().finally(() => schedule(intervalMs));
        }, delayMs);
    };
    schedule(options.initialDelayMs ?? PURCHASE_EMAIL_WORKER_INITIAL_DELAY_MS);

    return {
        tick,
        async stop(stopOptions = {}) {
            stopped = true;
            if (timer) clearTimeout(timer);
            const current = running;
            if (!current) return { timedOut: false };

            let waitTimer: NodeJS.Timeout | undefined;
            const expired = new Promise<false>((resolve) => {
                waitTimer = setTimeout(() => resolve(false), stopOptions.timeoutMs ?? PURCHASE_EMAIL_SHUTDOWN_GRACE_MS);
            });
            const finished = await Promise.race([current.then(() => true as const), expired]);
            if (waitTimer) clearTimeout(waitTimer);
            return { timedOut: !finished };
        },
    };
}
