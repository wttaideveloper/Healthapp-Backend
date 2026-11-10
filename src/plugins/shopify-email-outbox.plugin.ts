import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { Pool, type PoolConfig } from "pg";

import { env } from "@config/env";
import { createDb } from "../db";
import {
    PURCHASE_EMAIL_SHUTDOWN_GRACE_MS,
    drainQueuedShopifyPurchaseEmails,
    startPurchaseEmailOutboxWorker,
    type OutboxDb,
    type PurchaseEmailOutboxDeps,
    type PurchaseEmailWorker,
} from "../modules/shopify/shopify.email-outbox";

/**
 * The worker's own connection pool, kept apart from the one that serves HTTP requests so that a dead connection, a slow
 * query or a timeout here can never touch the API. Every setting is about not hanging:
 *   query_timeout / statement_timeout   give up on a query client-side and server-side (20 s)
 *   connectionTimeoutMillis             give up on opening a connection (10 s)
 *   idle_in_transaction_session_timeout never leave a transaction open and holding locks (30 s)
 *   keepAlive                           let the OS notice a connection that silently died
 * The outbox adds its own per-call deadline (25 s) on top, so even a pool that never answers cannot stall a pass.
 */
export function buildWorkerPoolConfig(connectionString: string): PoolConfig {
    return {
        connectionString,
        max: 2,
        application_name: "healthage-shopify-email-worker",
        connectionTimeoutMillis: 10_000,
        query_timeout: 20_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 30_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
    };
}

export type ShopifyEmailOutboxPluginOptions = {
    /** Test seam: use this database instead of creating the worker's own pool. */
    db?: OutboxDb;
    deps?: PurchaseEmailOutboxDeps;
    intervalMs?: number;
    initialDelayMs?: number;
    alertIntervalMs?: number;
    /** How long shutdown waits for emails being sent. */
    shutdownGraceMs?: number;
};

const POOL_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Runs the Shopify purchase email worker for the life of the server, and makes shutdown wait for emails being sent.
 *
 * It starts when the app is ready, makes its first pass a few seconds later (which is how emails left pending, due for a
 * retry, or stuck mid-send by a previous process are recovered after a restart), then scans every 30 seconds.
 *
 * On shutdown (plugins close in reverse order, so this runs BEFORE the main database plugin closes its pool):
 *   1. the worker stops starting new emails and waits, up to the grace period, for the one it is sending;
 *   2. the immediate sends started by the webhook are waited for too (they are detached from the HTTP request, so the
 *      server closing does not cover them);
 *   3. only then is the worker's own pool closed.
 * An email still being sent when the grace period ends is left `processing`: its lease lets the worker recover it after
 * the restart. The Docker stop grace period must be longer than `shutdownGraceMs` (docker-compose.yml sets it to 40 s).
 *
 * Several servers can run it at once: claiming is lease-based and safe across processes. Set SHOPIFY_EMAIL_WORKER_ENABLED=false
 * to switch the worker off on a server (the immediate send after a purchase, and the shutdown wait for it, still happen;
 * only the retries and recovery stop).
 */
async function shopifyEmailOutboxCore(app: FastifyInstance, options: ShopifyEmailOutboxPluginOptions) {
    const grace = options.shutdownGraceMs ?? PURCHASE_EMAIL_SHUTDOWN_GRACE_MS;
    let worker: PurchaseEmailWorker | undefined;
    let pool: Pool | undefined;

    app.addHook("onReady", async () => {
        if (env.SHOPIFY_EMAIL_WORKER_ENABLED === "false") {
            app.log.warn("Shopify purchase email worker is disabled (SHOPIFY_EMAIL_WORKER_ENABLED=false): retries and crash recovery are off");
            return;
        }

        let db = options.db;
        if (!db) {
            pool = new Pool(buildWorkerPoolConfig(env.DATABASE_URL));
            pool.on("error", (err) => {
                // An idle connection dying must not crash the process; the next pass opens a new one.
                app.log.error({ err }, "Shopify purchase email worker pool error");
            });
            db = createDb(pool);
        }

        worker = startPurchaseEmailOutboxWorker({
            db,
            log: app.log,
            deps: options.deps,
            intervalMs: options.intervalMs,
            initialDelayMs: options.initialDelayMs,
            alertIntervalMs: options.alertIntervalMs,
        });
        app.log.info("Shopify purchase email worker started");
    });

    app.addHook("onClose", async () => {
        const stopped = await worker?.stop({ timeoutMs: grace });
        const drained = await drainQueuedShopifyPurchaseEmails(grace);

        if (stopped?.timedOut || !drained.drained) {
            app.log.warn(
                { workerStillSending: stopped?.timedOut ?? false, immediateSendsStillRunning: drained.remaining },
                "Shutting down while Shopify purchase emails were still being sent; they stay 'processing' and the worker recovers them after the restart"
            );
        }

        if (pool) {
            let timer: NodeJS.Timeout | undefined;
            const gaveUp = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    app.log.warn("Shopify purchase email worker pool did not close in time; continuing shutdown");
                    resolve();
                }, POOL_CLOSE_TIMEOUT_MS);
            });
            await Promise.race([pool.end().catch(() => undefined), gaveUp]);
            if (timer) clearTimeout(timer);
        }
    });
}

export const shopifyEmailOutboxPlugin = fp<ShopifyEmailOutboxPluginOptions>(shopifyEmailOutboxCore, {
    name: "shopify-email-outbox-plugin",
    dependencies: ["db-plugin"],
});
