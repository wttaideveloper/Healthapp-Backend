import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createDb, ping } from "../db";

function parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function dbPluginCore(app: FastifyInstance) {
    const connectTimeoutMs = parsePositiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 15000);
    const startupPingTimeoutMs = parsePositiveInt(process.env.DB_STARTUP_PING_TIMEOUT_MS, connectTimeoutMs + 5000);
    const livenessCheckIntervalMs = parsePositiveInt(process.env.DB_LIVENESS_CHECK_INTERVAL_MS, 15000);

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL!,
        connectionTimeoutMillis: connectTimeoutMs,
    });

    const db = createDb(pool);

    app.decorate("db", db);
    app.decorate("pgPool", pool);
    app.decorate("isDbLive", false);

    pool.on("error", (err) => {
        app.log.error({ err }, "Unexpected PostgreSQL pool error");
        app.isDbLive = false;
    });

    const checkDbLiveness = async (
        timeoutMs: number,
        logContext: "startup" | "background" = "background",
    ): Promise<boolean> => {
        try {
            await withTimeout(ping(db), timeoutMs, "Database ping");
            if (!app.isDbLive) {
                app.log.info("Database connection recovered");
            }
            app.isDbLive = true;
            return true;
        } catch (err) {
            if (app.isDbLive) {
                app.log.warn({ err }, "Database connectivity lost");
            } else if (logContext === "startup") {
                app.log.error({ err }, "Database connection failed");
            }
            app.isDbLive = false;
            return false;
        }
    };

    await checkDbLiveness(startupPingTimeoutMs, "startup");

    const livenessTimer = setInterval(() => {
        void checkDbLiveness(connectTimeoutMs);
    }, livenessCheckIntervalMs);

    app.addHook("onClose", async () => {
        clearInterval(livenessTimer);
        await pool.end();
    });
}

export const dbPlugin = fp(dbPluginCore, {
    name: 'db-plugin'
});
