import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import z from "zod";

import { billingEvents, revenuecatSubscriptions, storeEntitlements } from "@db/schema";
import { BadRequestError, EntitlementOwnedByAnotherUserError } from "@core/errors/http-errors";
import { getEntitlementState } from "./entitlement.service";

const entitlementResponseSchema = z.object({
    hasAccess: z.boolean(),
    source: z.enum(["workspace", "individual_iap", "individual_stripe"]).nullable(),
    expiresAt: z.string().datetime().nullable(),
    providerStatus: z.string().nullable(),
    autoRenewing: z.boolean().nullable(),
    workspace: z
        .object({
            id: z.string().uuid(),
            name: z.string(),
            role: z.string(),
            memberStatus: z.string(),
            plan: z.string(),
            seatLimit: z.number().int(),
            subscriptionStatus: z.string(),
        })
        .nullable(),
    individual: z
        .object({
            provider: z.enum(["revenuecat", "stripe"]),
            productId: z.string().nullable(),
            status: z.string().nullable(),
        })
        .nullable(),
});

const revenuecatSyncBodySchema = z.object({
    appUserId: z.string().trim().min(1).max(255).optional(),
    platform: z.enum(["ios", "android", "macos"]),
    action: z.enum(["purchase", "restore", "status_check"]),
    entitlementId: z.enum(["pro"]),
    isActive: z.boolean(),
    autoRenewing: z.boolean(),
    expiryDate: z.string().datetime().nullable().optional(),
    productId: z.string().trim().min(1).max(255).nullable().optional(),
    transactionId: z.string().trim().min(1).max(255).nullable().optional(),
    originalTransactionId: z.string().trim().min(1).max(255),
    customerInfo: z
        .object({
            originalAppUserId: z.string().trim().min(1).max(255).optional(),
            activeSubscriptions: z.array(z.string().trim().min(1).max(255)).optional(),
            latestExpirationDate: z.string().datetime().nullable().optional(),
            entitlementsActive: z.array(z.string().trim().min(1).max(255)).optional(),
        })
        .passthrough()
        .optional(),
});

function isRevenuecatAccessActive(isActive: boolean, expiresAt: Date | null): boolean {
    if (!isActive) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
}

function mapRevenuecatStore(platform: "ios" | "android" | "macos"): "app_store" | "play_store" {
    return platform === "android" ? "play_store" : "app_store";
}

function mapRevenuecatStatus(isActive: boolean, expiresAt: Date | null): "active" | "expired" {
    if (!isActive) return "expired";
    if (!expiresAt) return "active";
    return expiresAt.getTime() > Date.now() ? "active" : "expired";
}

async function writeRevenuecatAuditEvent(
    app: Parameters<FastifyPluginAsyncZod>[0],
    payload: Record<string, unknown>,
    eventType: string
) {
    await app.db.insert(billingEvents).values({
        provider: "revenuecat",
        eventId: randomUUID(),
        eventType,
        payloadJson: payload,
    });
}

export const entitlementRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        "/me",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Get unified access state for the current user",
                response: {
                    200: entitlementResponseSchema,
                },
            },
        },
        async (req) => {
            return getEntitlementState(app, req.authUser!.sub);
        }
    );

    app.post(
        "/revenuecat/sync",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Sync individual App Store/Play Store entitlement snapshot from RevenueCat",
                body: revenuecatSyncBodySchema,
                response: {
                    200: z.object({
                        ok: z.literal(true),
                        data: entitlementResponseSchema,
                    }),
                    409: z.object({
                        code: z.literal("ENTITLEMENT_OWNED_BY_ANOTHER_USER"),
                        message: z.string(),
                    }),
                },
            },
        },
        async (req, reply) => {
            const userId = req.authUser!.sub;
            const {
                appUserId,
                platform,
                action,
                entitlementId,
                isActive,
                autoRenewing,
                expiryDate,
                productId,
                transactionId,
                originalTransactionId,
                customerInfo,
            } = req.body;

            if (appUserId && appUserId !== userId) {
                req.log.warn(
                    { bodyAppUserId: appUserId, jwtUserId: userId },
                    "RevenueCat appUserId mismatched with JWT subject; overriding with authenticated user id"
                );
            }

            const expiresAt = expiryDate ? new Date(expiryDate) : null;
            if (expiryDate && Number.isNaN(expiresAt?.getTime())) {
                throw new BadRequestError("Invalid expiryDate");
            }

            const now = new Date();
            const store = mapRevenuecatStore(platform);
            const status = mapRevenuecatStatus(isActive, expiresAt);

            await writeRevenuecatAuditEvent(
                app,
                {
                    userId,
                    bodyAppUserId: appUserId ?? null,
                    action,
                    platform,
                    store,
                    entitlementId,
                    isActive,
                    autoRenewing,
                    expiryDate: expiryDate ?? null,
                    productId: productId ?? null,
                    transactionId: transactionId ?? null,
                    originalTransactionId,
                },
                `client_sync.${action}`
            );

            try {
                await app.db.transaction(async (tx) => {
                    const [existingEntitlement] = await tx
                        .select()
                        .from(storeEntitlements)
                        .where(
                            and(
                                eq(storeEntitlements.store, store),
                                eq(storeEntitlements.originalTransactionId, originalTransactionId)
                            )
                        )
                        .limit(1);

                    const canClaimOwnership = action === "purchase" || action === "restore";

                    if (!existingEntitlement) {
                        await tx.insert(storeEntitlements).values({
                            platform,
                            store,
                            originalTransactionId,
                            latestTransactionId: transactionId ?? null,
                            productId: productId ?? null,
                            entitlementId,
                            expiresAt,
                            isActive,
                            ownerUserId: canClaimOwnership ? userId : null,
                            status,
                            lastSeenAt: now,
                        });
                    } else if (existingEntitlement.ownerUserId === null) {
                        if (canClaimOwnership) {
                            await tx
                                .update(storeEntitlements)
                                .set({
                                    platform,
                                    latestTransactionId: transactionId ?? null,
                                    productId: productId ?? null,
                                    entitlementId,
                                    expiresAt,
                                    isActive,
                                    ownerUserId: userId,
                                    status,
                                    lastSeenAt: now,
                                    updatedAt: now,
                                })
                                .where(eq(storeEntitlements.id, existingEntitlement.id));
                        }
                    } else if (existingEntitlement.ownerUserId !== userId) {
                        await tx.insert(billingEvents).values({
                            provider: "revenuecat",
                            eventId: randomUUID(),
                            eventType: "ownership_conflict",
                            payloadJson: {
                                authUserId: userId,
                                currentOwnerUserId: existingEntitlement.ownerUserId,
                                action,
                                platform,
                                store,
                                originalTransactionId,
                                transactionId: transactionId ?? null,
                            },
                        });

                        throw new EntitlementOwnedByAnotherUserError();
                    } else {
                        await tx
                            .update(storeEntitlements)
                            .set({
                                platform,
                                latestTransactionId: transactionId ?? null,
                                productId: productId ?? null,
                                entitlementId,
                                expiresAt,
                                isActive,
                                status,
                                lastSeenAt: now,
                                updatedAt: now,
                            })
                            .where(eq(storeEntitlements.id, existingEntitlement.id));
                    }

                    const [ownedEntitlement] = await tx
                        .select()
                        .from(storeEntitlements)
                        .where(
                            and(
                                eq(storeEntitlements.store, store),
                                eq(storeEntitlements.originalTransactionId, originalTransactionId),
                                eq(storeEntitlements.ownerUserId, userId),
                                or(isNull(storeEntitlements.expiresAt), gt(storeEntitlements.expiresAt, now))
                            )
                        )
                        .limit(1);

                    if (!ownedEntitlement) {
                        return;
                    }

                    await tx
                        .insert(revenuecatSubscriptions)
                        .values({
                            userId,
                            appUserId: userId,
                            platform,
                            entitlementId,
                            isActive: isRevenuecatAccessActive(isActive, expiresAt),
                            autoRenewing,
                            expiresAt,
                            productId: productId ?? null,
                            transactionId: transactionId ?? null,
                            originalTransactionId,
                            customerInfo: customerInfo ?? null,
                            lastSource: "revenuecat_client_sync",
                            lastSyncedAt: now,
                        })
                        .onConflictDoUpdate({
                            target: revenuecatSubscriptions.userId,
                            set: {
                                appUserId: userId,
                                platform,
                                entitlementId,
                                isActive: isRevenuecatAccessActive(isActive, expiresAt),
                                autoRenewing,
                                expiresAt,
                                productId: productId ?? null,
                                transactionId: transactionId ?? null,
                                originalTransactionId,
                                customerInfo: customerInfo ?? null,
                                lastSource: "revenuecat_client_sync",
                                lastSyncedAt: now,
                                updatedAt: now,
                            },
                        });
                });
            } catch (error) {
                if (error instanceof EntitlementOwnedByAnotherUserError) {
                    return reply.status(409).send({
                        code: "ENTITLEMENT_OWNED_BY_ANOTHER_USER",
                        message: error.message,
                    });
                }

                throw error;
            }

            return {
                ok: true as const,
                data: await getEntitlementState(app, userId),
            };
        }
    );
};
