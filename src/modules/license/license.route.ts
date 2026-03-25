import { and, desc, eq, sql } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";

import { users, licenses, licenseActivations, revenuecatSubscriptions, stripeSubscriptions } from "@db/schema";
import { BadRequestError, ForbiddenError, NotFoundError } from "@core/errors/http-errors";
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
    entitlementId: z.enum(["pro"]),
    isActive: z.boolean(),
    autoRenewing: z.boolean(),
    expiryDate: z.string().datetime().nullable().optional(),
    productId: z.string().trim().min(1).max(255).nullable().optional(),
    transactionId: z.string().trim().min(1).max(255).nullable().optional(),
    originalTransactionId: z.string().trim().min(1).max(255).nullable().optional(),
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
                },
            },
        },
        async (req) => {
            const userId = req.authUser!.sub;
            const {
                appUserId,
                platform,
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

            await app.db
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
                    originalTransactionId: originalTransactionId ?? null,
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
                        originalTransactionId: originalTransactionId ?? null,
                        customerInfo: customerInfo ?? null,
                        lastSource: "revenuecat_client_sync",
                        lastSyncedAt: now,
                        updatedAt: now,
                    },
                });

            await app.db
                .update(users)
                .set({
                    isLicensed: normalizedIsLicensed,
                    updatedAt: now,
                })
                .where(eq(users.id, userId));

            return {
                ok: true as const,
                data: {
                    isLicensed: normalizedIsLicensed,
                    expiresAt: expiresAt ? expiresAt.toISOString() : null,
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
            const [user] = await app.db.select().from(users).where(eq(users.id, req.authUser!.sub)).limit(1);
            if (!user) {
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

            const [revenuecatSubscription] = await app.db
                .select()
                .from(revenuecatSubscriptions)
                .where(eq(revenuecatSubscriptions.userId, user.id))
                .limit(1);

            const [stripeSubscription] = await app.db
                .select()
                .from(stripeSubscriptions)
                .where(eq(stripeSubscriptions.userId, user.id))
                .orderBy(desc(stripeSubscriptions.updatedAt))
                .limit(1);

            const revenuecatIsLicensed = revenuecatSubscription
                ? isRevenuecatLicenseActive(revenuecatSubscription.isActive, revenuecatSubscription.expiresAt)
                : false;
            const stripeIsLicensed = stripeSubscription
                ? isStripeLicenseActive(stripeSubscription.status, stripeSubscription.currentPeriodEnd)
                : false;

            if (!user.licenseId) {
                const provider: "stripe" | "revenuecat" | null = stripeIsLicensed
                    ? "stripe"
                    : revenuecatIsLicensed
                        ? "revenuecat"
                        : null;
                const providerStatus = stripeIsLicensed
                    ? stripeSubscription?.providerStatus ?? stripeSubscription?.status ?? null
                    : revenuecatSubscription
                        ? (revenuecatSubscription.isActive ? "active" : "inactive")
                        : null;
                const autoRenewing = stripeIsLicensed
                    ? stripeSubscription?.autoRenewing ?? null
                    : revenuecatSubscription?.autoRenewing ?? null;
                const expiresAt = stripeIsLicensed
                    ? stripeSubscription?.currentPeriodEnd?.toISOString() ?? null
                    : revenuecatSubscription?.expiresAt?.toISOString() ?? null;

                return {
                    isLicensed: stripeIsLicensed || revenuecatIsLicensed,
                    expiresAt,
                    provider,
                    providerStatus,
                    autoRenewing,
                    license: null,
                    activations: [],
                };
            }

            const [license] = await app.db.select().from(licenses).where(eq(licenses.id, user.licenseId)).limit(1);
            const enterpriseIsLicensed = license
                ? isEnterpriseLicenseActive(license.isActive, license.expiresAt)
                : false;

            if (!license) {
                const provider: "stripe" | "revenuecat" | null = stripeIsLicensed
                    ? "stripe"
                    : revenuecatIsLicensed
                        ? "revenuecat"
                        : null;
                const providerStatus = stripeIsLicensed
                    ? stripeSubscription?.providerStatus ?? stripeSubscription?.status ?? null
                    : revenuecatSubscription
                        ? (revenuecatSubscription.isActive ? "active" : "inactive")
                        : null;
                const autoRenewing = stripeIsLicensed
                    ? stripeSubscription?.autoRenewing ?? null
                    : revenuecatSubscription?.autoRenewing ?? null;
                const expiresAt = stripeIsLicensed
                    ? stripeSubscription?.currentPeriodEnd?.toISOString() ?? null
                    : revenuecatSubscription?.expiresAt?.toISOString() ?? null;

                return {
                    isLicensed: stripeIsLicensed || revenuecatIsLicensed,
                    expiresAt,
                    provider,
                    providerStatus,
                    autoRenewing,
                    license: null,
                    activations: [],
                };
            }

            const activationRows = await app.db
                .select()
                .from(licenseActivations)
                .where(and(eq(licenseActivations.userId, user.id), eq(licenseActivations.licenseId, license.id)))
                .orderBy(desc(licenseActivations.activatedAt));

            return {
                isLicensed: enterpriseIsLicensed,
                expiresAt: license.expiresAt?.toISOString() ?? null,
                provider: "enterprise" as const,
                providerStatus: license.isActive ? "active" : "inactive",
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
    );
};
