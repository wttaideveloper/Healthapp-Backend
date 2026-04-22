import { randomUUID } from "node:crypto";
import { Pool } from "pg";

type RevenueCatRow = {
    id: string;
    user_id: string;
    platform: string;
    entitlement_id: string;
    is_active: boolean;
    expires_at: Date | null;
    product_id: string | null;
    transaction_id: string | null;
    original_transaction_id: string;
    created_at: Date;
    updated_at: Date;
};

type GroupWinner = RevenueCatRow & {
    store: "app_store" | "play_store";
};

function mapStore(platform: string): "app_store" | "play_store" {
    return platform === "android" ? "play_store" : "app_store";
}

function isCurrentlyActive(row: RevenueCatRow): boolean {
    if (!row.is_active) return false;
    if (!row.expires_at) return true;
    return row.expires_at.getTime() > Date.now();
}

function deriveStatus(row: RevenueCatRow): "active" | "expired" {
    return isCurrentlyActive(row) ? "active" : "expired";
}

function chooseWinner(rows: RevenueCatRow[]): GroupWinner {
    const sorted = [...rows].sort((left, right) => {
        const activeDelta = Number(isCurrentlyActive(right)) - Number(isCurrentlyActive(left));
        if (activeDelta !== 0) return activeDelta;

        const createdDelta = left.created_at.getTime() - right.created_at.getTime();
        if (createdDelta !== 0) return createdDelta;

        const updatedDelta = left.updated_at.getTime() - right.updated_at.getTime();
        if (updatedDelta !== 0) return updatedDelta;

        return left.user_id.localeCompare(right.user_id);
    });

    return {
        ...sorted[0],
        store: mapStore(sorted[0].platform),
    };
}

async function recomputeUserLicense(pool: Pool, userId: string) {
    await pool.query(
        `
        UPDATE users AS u
        SET
            is_licensed = EXISTS (
                SELECT 1
                FROM licenses AS l
                WHERE l.id = u.license_id
                  AND l.is_active = true
                  AND (l.expires_at IS NULL OR l.expires_at > now())
                  AND EXISTS (
                      SELECT 1
                      FROM license_activations AS la
                      WHERE la.user_id = u.id
                        AND la.license_id = l.id
                  )
            )
            OR EXISTS (
                SELECT 1
                FROM stripe_subscriptions AS ss
                WHERE ss.user_id = u.id
                  AND ss.status IN ('active', 'trialing')
                  AND (ss.current_period_end IS NULL OR ss.current_period_end > now())
            )
            OR EXISTS (
                SELECT 1
                FROM store_entitlements AS se
                WHERE se.owner_user_id = u.id
                  AND se.is_active = true
                  AND (se.expires_at IS NULL OR se.expires_at > now())
            ),
            updated_at = now()
        WHERE u.id = $1
        `,
        [userId]
    );
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is not set");
    }

    const pool = new Pool({ connectionString: databaseUrl });

    try {
        await pool.query("BEGIN");

        const result = await pool.query<RevenueCatRow>(
            `
            SELECT
                id,
                user_id,
                platform,
                entitlement_id,
                is_active,
                expires_at,
                product_id,
                transaction_id,
                original_transaction_id,
                created_at,
                updated_at
            FROM revenuecat_subscriptions
            WHERE original_transaction_id IS NOT NULL
              AND btrim(original_transaction_id) <> ''
            ORDER BY created_at ASC, updated_at ASC
            `
        );

        const groups = new Map<string, RevenueCatRow[]>();
        for (const row of result.rows) {
            const store = mapStore(row.platform);
            const key = `${store}:${row.original_transaction_id}`;
            const items = groups.get(key) ?? [];
            items.push(row);
            groups.set(key, items);
        }

        const affectedUsers = new Set<string>();
        let duplicateGroups = 0;
        let insertedOrUpdatedEntitlements = 0;
        let revokedLegacyRows = 0;

        for (const [key, rows] of groups.entries()) {
            const winner = chooseWinner(rows);
            const now = new Date();

            await pool.query(
                `
                INSERT INTO store_entitlements (
                    platform,
                    store,
                    original_transaction_id,
                    latest_transaction_id,
                    product_id,
                    entitlement_id,
                    expires_at,
                    is_active,
                    owner_user_id,
                    status,
                    last_seen_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                )
                ON CONFLICT (store, original_transaction_id)
                DO UPDATE SET
                    platform = EXCLUDED.platform,
                    latest_transaction_id = EXCLUDED.latest_transaction_id,
                    product_id = EXCLUDED.product_id,
                    entitlement_id = EXCLUDED.entitlement_id,
                    expires_at = EXCLUDED.expires_at,
                    is_active = EXCLUDED.is_active,
                    owner_user_id = EXCLUDED.owner_user_id,
                    status = EXCLUDED.status,
                    last_seen_at = EXCLUDED.last_seen_at,
                    updated_at = now()
                `,
                [
                    winner.platform,
                    winner.store,
                    winner.original_transaction_id,
                    winner.transaction_id,
                    winner.product_id,
                    winner.entitlement_id,
                    winner.expires_at,
                    winner.is_active,
                    winner.user_id,
                    deriveStatus(winner),
                    now,
                ]
            );
            insertedOrUpdatedEntitlements += 1;
            affectedUsers.add(winner.user_id);

            if (rows.length > 1) {
                duplicateGroups += 1;

                await pool.query(
                    `
                    INSERT INTO billing_events (provider, event_id, event_type, payload_json)
                    VALUES ($1, $2, $3, $4::jsonb)
                    `,
                    [
                        "revenuecat_cleanup",
                        randomUUID(),
                        "duplicate_original_transaction_resolved",
                        JSON.stringify({
                            key,
                            winnerUserId: winner.user_id,
                            winnerRevenueCatRowId: winner.id,
                            loserUserIds: rows.filter((row) => row.user_id !== winner.user_id).map((row) => row.user_id),
                        }),
                    ]
                );
            }

            for (const row of rows) {
                if (row.user_id === winner.user_id) {
                    continue;
                }

                revokedLegacyRows += 1;
                affectedUsers.add(row.user_id);

                await pool.query(
                    `
                    UPDATE revenuecat_subscriptions
                    SET
                        is_active = false,
                        updated_at = now()
                    WHERE id = $1
                    `,
                    [row.id]
                );
            }
        }

        for (const userId of affectedUsers) {
            await recomputeUserLicense(pool, userId);
        }

        await pool.query("COMMIT");

        console.log("Store entitlement reconciliation complete.");
        console.log(`Legacy RevenueCat rows scanned: ${result.rowCount}`);
        console.log(`Entitlements inserted/updated: ${insertedOrUpdatedEntitlements}`);
        console.log(`Duplicate groups resolved: ${duplicateGroups}`);
        console.log(`Legacy rows revoked: ${revokedLegacyRows}`);
        console.log(`Users recomputed: ${affectedUsers.size}`);
    } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error("Failed to reconcile store entitlements.");
    console.error(error);
    process.exit(1);
});
