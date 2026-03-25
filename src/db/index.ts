import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, PoolClient } from "pg";
import { sql } from "drizzle-orm";

export type DB = NodePgDatabase<Record<string, never>>;
export type PgPool = Pool;
export type PgClient = PoolClient;

/**
 * App-level DB (connection pool)
 */
export function createDb(pool: Pool): DB {
    return drizzle(pool) as DB;
}

/**
 * Transaction-level DB (single client)
 */
export function createTx(client: PoolClient): DB {
    return drizzle(client) as DB;
}

/**
 * Health check
 */
export async function ping(db: DB) {
    await db.execute(sql`select 1`);
    return true;
}
