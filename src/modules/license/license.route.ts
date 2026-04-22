import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import z from "zod";

import {
    billingEvents,
    users,
    licenses,
    licenseActivations,
    revenuecatSubscriptions,
    storeEntitlements,
    stripeSubscriptions,
} from "@db/schema";
import {
    BadRequestError,
    EntitlementOwnedByAnotherUserError,
    ForbiddenError,
    NotFoundError,
} from "@core/errors/http-errors";
import { hashLicenseKey } from "@core/security/license-key";

const activateLicenseBodySchema = z.object({
    licenseKey: z.string().trim().min(8).max(128),
    deviceId: z.string().trim().min(3).max(200),
    platform: z.string().trim().min(2).max(50).optional(),
});

const licenseResponseSchema = z.object({
    id: z.string().uuid(),
    organizationName: z.string(),
    allowedEmailDomain: z.string().nullable(),
    maxActivations: z.number().int().nullable(),
    expiresAt: z.string().datetime().nullable(),
    isActive: z.boolean(),
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

function getEmailDomain(email: string): string {
    const parts = email.toLowerCase().split("@");
    return parts.length === 2 ? parts[1] : "";
}

function parseAllowedDomains(value: string): string[] {
    return value
        .split(",")
        .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean);
}

function isRevenuecatLicenseActive(isActive: boolean, expiresAt: Date | null): boolean {
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

function isStoreEntitlementActive(isActive: boolean, expiresAt: Date | null): boolean {
    if (!isActive) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
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

async function getOwnedRevenuecatEntitlement(
    app: Parameters<FastifyPluginAsyncZod>[0],
    userId: string
) {
    const now = new Date();

    const [row] = await app.db
        .select()
        .from(storeEntitlements)
        .where(
            and(
                eq(storeEntitlements.ownerUserId, userId),
                eq(storeEntitlements.isActive, true),
                or(isNull(storeEntitlements.expiresAt), gt(storeEntitlements.expiresAt, now))
            )
        )
        .orderBy(desc(storeEntitlements.expiresAt), desc(storeEntitlements.updatedAt))
        .limit(1);

    return row ?? null;
}

async function getNormalizedLicenseState(
    app: Parameters<FastifyPluginAsyncZod>[0],
    userId: string
) {
    const [user] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
        return {
            isLicensed: false,
            expiresAt: null as string | null,
            provider: null as "enterprise" | "revenuecat" | "stripe" | null,
            providerStatus: null as string | null,
            autoRenewing: null as boolean | null,
            license: null as z.infer<typeof licenseResponseSchema> | null,
            activations: [] as Array<{
                id: string;
                deviceId: string;
                platform: string | null;
                activatedAt: string;
            }>,
        };
    }

    const [stripeSubscription, revenuecatEntitlement] = await Promise.all([
        app.db
            .select()
            .from(stripeSubscriptions)
            .where(eq(stripeSubscriptions.userId, user.id))
            .orderBy(desc(stripeSubscriptions.updatedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        getOwnedRevenuecatEntitlement(app, user.id),
    ]);

    const stripeIsLicensed = stripeSubscription
        ? isStripeLicenseActive(stripeSubscription.status, stripeSubscription.currentPeriodEnd)
        : false;
    const revenuecatIsLicensed = revenuecatEntitlement
        ? isStoreEntitlementActive(revenuecatEntitlement.isActive, revenuecatEntitlement.expiresAt)
        : false;

    if (!user.licenseId) {
        if (stripeIsLicensed) {
            return {
                isLicensed: true,
                expiresAt: stripeSubscription?.currentPeriodEnd?.toISOString() ?? null,
                provider: "stripe" as const,
                providerStatus: stripeSubscription?.providerStatus ?? stripeSubscription?.status ?? null,
                autoRenewing: stripeSubscription?.autoRenewing ?? null,
                license: null,
                activations: [],
            };
        }

        if (revenuecatIsLicensed) {
            return {
                isLicensed: true,
                expiresAt: revenuecatEntitlement?.expiresAt?.toISOString() ?? null,
                provider: "revenuecat" as const,
                providerStatus: revenuecatEntitlement?.status ?? "active",
                autoRenewing: null,
                license: null,
                activations: [],
            };
        }

        return {
            isLicensed: false,
            expiresAt: null,
            provider: null,
            providerStatus: null,
            autoRenewing: null,
            license: null,
            activations: [],
        };
    }

    const [license] = await app.db.select().from(licenses).where(eq(licenses.id, user.licenseId)).limit(1);
    if (!license) {
        if (stripeIsLicensed) {
            return {
                isLicensed: true,
                expiresAt: stripeSubscription?.currentPeriodEnd?.toISOString() ?? null,
                provider: "stripe" as const,
                providerStatus: stripeSubscription?.providerStatus ?? stripeSubscription?.status ?? null,
                autoRenewing: stripeSubscription?.autoRenewing ?? null,
                license: null,
                activations: [],
            };
        }

        if (revenuecatIsLicensed) {
            return {
                isLicensed: true,
                expiresAt: revenuecatEntitlement?.expiresAt?.toISOString() ?? null,
                provider: "revenuecat" as const,
                providerStatus: revenuecatEntitlement?.status ?? "active",
                autoRenewing: null,
                license: null,
                activations: [],
            };
        }

        return {
            isLicensed: false,
            expiresAt: null,
            provider: null,
            providerStatus: null,
            autoRenewing: null,
            license: null,
            activations: [],
        };
    }

    const enterpriseIsLicensed = isEnterpriseLicenseActive(license.isActive, license.expiresAt);
    const activationRows = await app.db
        .select()
        .from(licenseActivations)
        .where(and(eq(licenseActivations.userId, user.id), eq(licenseActivations.licenseId, license.id)))
        .orderBy(desc(licenseActivations.activatedAt));

    const normalizedEnterpriseLicense = enterpriseIsLicensed && activationRows.length > 0;

    if (normalizedEnterpriseLicense) {
        return {
            isLicensed: true,
            expiresAt: license.expiresAt?.toISOString() ?? null,
            provider: "enterprise" as const,
            providerStatus: "active",
            autoRenewing: null,
            license: {
                id: license.id,
                organizationName: license.organizationName,
                allowedEmailDomain: license.allowedEmailDomain,
                maxActivations: license.maxActivations,
                expiresAt: license.expiresAt?.toISOString() ?? null,
                isActive: license.isActive,
            },
            activations: activationRows.map((row) => ({
                id: row.id,
                deviceId: row.deviceId,
                platform: row.platform,
                activatedAt: row.activatedAt.toISOString(),
            })),
        };
    }

    if (stripeIsLicensed) {
        return {
            isLicensed: true,
            expiresAt: stripeSubscription?.currentPeriodEnd?.toISOString() ?? null,
            provider: "stripe" as const,
            providerStatus: stripeSubscription?.providerStatus ?? stripeSubscription?.status ?? null,
            autoRenewing: stripeSubscription?.autoRenewing ?? null,
            license: null,
            activations: [],
        };
    }

    if (revenuecatIsLicensed) {
        return {
            isLicensed: true,
            expiresAt: revenuecatEntitlement?.expiresAt?.toISOString() ?? null,
            provider: "revenuecat" as const,
            providerStatus: revenuecatEntitlement?.status ?? "active",
            autoRenewing: null,
            license: null,
            activations: [],
        };
    }

    return {
        isLicensed: false,
        expiresAt: null,
        provider: null,
        providerStatus: null,
        autoRenewing: null,
        license: null,
        activations: [],
    };
}

function isEnterpriseLicenseActive(isActive: boolean, expiresAt: Date | null): boolean {
    if (!isActive) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
}

function isStripeLicenseActive(status: string, expiresAt: Date | null): boolean {
    const allowedStatuses = new Set(["active", "trialing"]);
    if (!allowedStatuses.has(status)) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
}

export const licenseRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/activate",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Activate organization site license",
                body: activateLicenseBodySchema,
                response: {
                    200: z.object({
                        activated: z.boolean(),
                        license: licenseResponseSchema,
                    }),
                },
            },
        },
        async (req) => {
            const userId = req.authUser!.sub;
            const normalizedKeyHash = hashLicenseKey(req.body.licenseKey);

            const [user] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
            if (!user) {
                throw new NotFoundError("User not found");
            }

            const [license] = await app.db
                .select()
                .from(licenses)
                .where(and(eq(licenses.licenseKeyHash, normalizedKeyHash), eq(licenses.isActive, true)))
                .limit(1);

            if (!license) {
                throw new BadRequestError("Invalid or inactive license code");
            }

            if (license.expiresAt && license.expiresAt.getTime() <= Date.now()) {
                throw new ForbiddenError("License has expired");
            }

            if (license.allowedEmailDomain) {
                const userDomain = getEmailDomain(user.email);
                const allowedDomains = parseAllowedDomains(license.allowedEmailDomain);
                if (allowedDomains.length > 0 && !allowedDomains.includes(userDomain)) {
                    throw new ForbiddenError("Your email domain is not allowed for this organization license");
                }
            }

            const normalizedDeviceId = req.body.deviceId.trim().toLowerCase();
            const [existingDeviceActivation] = await app.db
                .select()
                .from(licenseActivations)
                .where(
                    and(
                        eq(licenseActivations.licenseId, license.id),
                        eq(licenseActivations.userId, user.id),
                        eq(licenseActivations.deviceId, normalizedDeviceId)
                    )
                )
                .limit(1);

            if (!existingDeviceActivation && license.maxActivations !== null) {
                const [countRow] = await app.db
                    .select({
                        count: sql<number>`count(*)`,
                    })
                    .from(licenseActivations)
                    .where(eq(licenseActivations.licenseId, license.id));

                if (Number(countRow?.count ?? 0) >= license.maxActivations) {
                    throw new ForbiddenError("Install limit reached for this license");
                }
            }

            if (!existingDeviceActivation) {
                await app.db.insert(licenseActivations).values({
                    userId: user.id,
                    licenseId: license.id,
                    deviceId: normalizedDeviceId,
                    platform: req.body.platform,
                });
            }

            await app.db
                .update(users)
                .set({
                    isLicensed: true,
                    licenseId: license.id,
                })
                .where(eq(users.id, user.id));

            return {
                activated: true,
                license: {
                    id: license.id,
                    organizationName: license.organizationName,
                    allowedEmailDomain: license.allowedEmailDomain,
                    maxActivations: license.maxActivations,
                    expiresAt: license.expiresAt?.toISOString() ?? null,
                    isActive: license.isActive,
                },
            };
        }
    );

    app.post(
        "/revenuecat/sync",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Sync RevenueCat entitlement snapshot from app",
                body: revenuecatSyncBodySchema,
                response: {
                    200: z.object({
                        ok: z.literal(true),
                        data: z.object({
                            isLicensed: z.boolean(),
                            expiresAt: z.string().datetime().nullable(),
                        }),
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

            const normalizedIsLicensed = isRevenuecatLicenseActive(isActive, expiresAt);
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
                                eq(storeEntitlements.ownerUserId, userId)
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
                            isActive,
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
                                isActive,
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

                    await tx
                        .update(users)
                        .set({
                            isLicensed: normalizedIsLicensed,
                            updatedAt: now,
                        })
                        .where(eq(users.id, userId));
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

            const normalizedLicense = await getNormalizedLicenseState(app, userId);

            return {
                ok: true as const,
                data: {
                    isLicensed: normalizedLicense.isLicensed,
                    expiresAt: normalizedLicense.expiresAt,
                },
            };
        }
    );

    app.get(
        "/me",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Get current user's assigned license",
                response: {
                    200: z.object({
                        isLicensed: z.boolean(),
                        expiresAt: z.string().datetime().nullable(),
                        provider: z.enum(["enterprise", "revenuecat", "stripe"]).nullable(),
                        providerStatus: z.string().nullable(),
                        autoRenewing: z.boolean().nullable(),
                        license: licenseResponseSchema.nullable(),
                        activations: z.array(
                            z.object({
                                id: z.string().uuid(),
                                deviceId: z.string(),
                                platform: z.string().nullable(),
                                activatedAt: z.string().datetime(),
                            })
                        ),
                    }),
                },
            },
        },
        async (req) => {
            return getNormalizedLicenseState(app, req.authUser!.sub);
        }
    );
};
