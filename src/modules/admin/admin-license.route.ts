import { desc, eq, sql } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";

import { licenseActivations, licenses, users } from "@db/schema";
import { NotFoundError } from "@core/errors/http-errors";
import { generateLicenseKey, hashLicenseKey } from "@core/security/license-key";

const domainRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function normalizeDomainList(domainList?: string | null): string | null | undefined {
    if (domainList === undefined) return undefined;
    if (domainList === null) return null;

    const normalized = domainList
        .split(",")
        .map((value) => value.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean);

    if (normalized.length === 0) return null;
    return normalized.join(",");
}

function validateDomainList(value?: string | null): boolean {
    if (value === undefined || value === null || value.trim() === "") return true;
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    return parts.length > 0 && parts.every((part) => domainRegex.test(part.replace(/^@/, "")));
}

const createLicenseBodySchema = z.object({
    organizationName: z.string().trim().min(2).max(200),
    allowedEmailDomain: z.string().trim().min(1).max(500).optional().refine(validateDomainList, {
        message: "allowedEmailDomain must be a comma-separated list of domains (e.g. conference.org,gmail.com)",
    }),
    maxActivations: z.number().int().positive().optional(),
    expiresAt: z.string().datetime().optional(),
    isActive: z.boolean().optional(),
});

const updateLicenseBodySchema = z.object({
    organizationName: z.string().trim().min(2).max(200).optional(),
    allowedEmailDomain: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .nullable()
        .optional()
        .refine(validateDomainList, {
            message: "allowedEmailDomain must be a comma-separated list of domains (e.g. conference.org,gmail.com)",
        }),
    maxActivations: z.number().int().positive().nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    isActive: z.boolean().optional(),
});

const idParamSchema = z.object({
    id: z.string().uuid(),
});

const adminLicenseSchema = z.object({
    id: z.string().uuid(),
    organizationName: z.string(),
    allowedEmailDomain: z.string().nullable(),
    maxActivations: z.number().int().nullable(),
    expiresAt: z.string().datetime().nullable(),
    isActive: z.boolean(),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    activationCount: z.number().int(),
});

export const adminLicenseRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/licenses",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Create organization site license",
                body: createLicenseBodySchema,
                response: {
                    201: z.object({
                        licenseKey: z.string(),
                        license: adminLicenseSchema,
                    }),
                },
            },
        },
        async (req, reply) => {
            const licenseKey = generateLicenseKey();
            const licenseKeyHash = hashLicenseKey(licenseKey);

            const [createdLicense] = await app.db
                .insert(licenses)
                .values({
                    organizationName: req.body.organizationName,
                    allowedEmailDomain: normalizeDomainList(req.body.allowedEmailDomain),
                    maxActivations: req.body.maxActivations ?? null,
                    expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
                    isActive: req.body.isActive ?? true,
                    createdByUserId: req.authUser!.sub,
                    licenseKeyHash,
                })
                .returning();

            return reply.status(201).send({
                licenseKey,
                license: {
                    id: createdLicense.id,
                    organizationName: createdLicense.organizationName,
                    allowedEmailDomain: createdLicense.allowedEmailDomain,
                    maxActivations: createdLicense.maxActivations,
                    expiresAt: createdLicense.expiresAt?.toISOString() ?? null,
                    isActive: createdLicense.isActive,
                    createdByUserId: createdLicense.createdByUserId,
                    createdAt: createdLicense.createdAt.toISOString(),
                    updatedAt: createdLicense.updatedAt.toISOString(),
                    activationCount: 0,
                },
            });
        }
    );

    app.get(
        "/licenses",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "List all organization licenses",
                response: {
                    200: z.array(adminLicenseSchema),
                },
            },
        },
        async () => {
            const rows = await app.db
                .select({
                    id: licenses.id,
                    organizationName: licenses.organizationName,
                    allowedEmailDomain: licenses.allowedEmailDomain,
                    maxActivations: licenses.maxActivations,
                    expiresAt: licenses.expiresAt,
                    isActive: licenses.isActive,
                    createdByUserId: licenses.createdByUserId,
                    createdAt: licenses.createdAt,
                    updatedAt: licenses.updatedAt,
                    activationCount: sql<number>`count(${licenseActivations.id})`,
                })
                .from(licenses)
                .leftJoin(licenseActivations, eq(licenseActivations.licenseId, licenses.id))
                .groupBy(licenses.id)
                .orderBy(desc(licenses.createdAt));

            return rows.map((row) => ({
                id: row.id,
                organizationName: row.organizationName,
                allowedEmailDomain: row.allowedEmailDomain,
                maxActivations: row.maxActivations,
                expiresAt: row.expiresAt?.toISOString() ?? null,
                isActive: row.isActive,
                createdByUserId: row.createdByUserId,
                createdAt: row.createdAt.toISOString(),
                updatedAt: row.updatedAt.toISOString(),
                activationCount: Number(row.activationCount ?? 0),
            }));
        }
    );

    app.patch(
        "/licenses/:id",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Update organization site license",
                params: idParamSchema,
                body: updateLicenseBodySchema,
                response: {
                    200: adminLicenseSchema,
                },
            },
        },
        async (req) => {
            const updates: Partial<typeof licenses.$inferInsert> = {};

            if (req.body.organizationName !== undefined) {
                updates.organizationName = req.body.organizationName;
            }

            if (req.body.allowedEmailDomain !== undefined) {
                updates.allowedEmailDomain = normalizeDomainList(req.body.allowedEmailDomain);
            }

            if (req.body.maxActivations !== undefined) {
                updates.maxActivations = req.body.maxActivations;
            }

            if (req.body.expiresAt !== undefined) {
                updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
            }

            if (req.body.isActive !== undefined) {
                updates.isActive = req.body.isActive;
            }

            if (Object.keys(updates).length === 0) {
                throw new NotFoundError("No updatable fields provided");
            }

            const [updatedLicense] = await app.db
                .update(licenses)
                .set(updates)
                .where(eq(licenses.id, req.params.id))
                .returning();

            if (!updatedLicense) {
                throw new NotFoundError("License not found");
            }

            const [countRow] = await app.db
                .select({
                    count: sql<number>`count(*)`,
                })
                .from(licenseActivations)
                .where(eq(licenseActivations.licenseId, updatedLicense.id));

            return {
                id: updatedLicense.id,
                organizationName: updatedLicense.organizationName,
                allowedEmailDomain: updatedLicense.allowedEmailDomain,
                maxActivations: updatedLicense.maxActivations,
                expiresAt: updatedLicense.expiresAt?.toISOString() ?? null,
                isActive: updatedLicense.isActive,
                createdByUserId: updatedLicense.createdByUserId,
                createdAt: updatedLicense.createdAt.toISOString(),
                updatedAt: updatedLicense.updatedAt.toISOString(),
                activationCount: Number(countRow?.count ?? 0),
            };
        }
    );

    app.get(
        "/licenses/:id/activations",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "List activation records for a license",
                params: idParamSchema,
                response: {
                    200: z.array(
                        z.object({
                            activationId: z.string().uuid(),
                            userId: z.string().uuid(),
                            name: z.string(),
                            email: z.string().email(),
                            deviceId: z.string(),
                            platform: z.string().nullable(),
                            activatedAt: z.string().datetime(),
                        })
                    ),
                },
            },
        },
        async (req) => {
            const [license] = await app.db.select().from(licenses).where(eq(licenses.id, req.params.id)).limit(1);
            if (!license) {
                throw new NotFoundError("License not found");
            }

            const rows = await app.db
                .select({
                    activationId: licenseActivations.id,
                    userId: users.id,
                    name: users.name,
                    email: users.email,
                    deviceId: licenseActivations.deviceId,
                    platform: licenseActivations.platform,
                    activatedAt: licenseActivations.activatedAt,
                })
                .from(licenseActivations)
                .innerJoin(users, eq(users.id, licenseActivations.userId))
                .where(eq(licenseActivations.licenseId, req.params.id))
                .orderBy(desc(licenseActivations.activatedAt));

            return rows.map((row) => ({
                activationId: row.activationId,
                userId: row.userId,
                name: row.name,
                email: row.email,
                deviceId: row.deviceId,
                platform: row.platform,
                activatedAt: row.activatedAt.toISOString(),
            }));
        }
    );

    app.delete(
        "/licenses/:id",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Delete organization site license",
                params: idParamSchema,
                response: {
                    200: z.object({ deleted: z.literal(true) }),
                },
            },
        },
        async (req) => {
            const [deleted] = await app.db
                .delete(licenses)
                .where(eq(licenses.id, req.params.id))
                .returning({ id: licenses.id });

            if (!deleted) {
                throw new NotFoundError("License not found");
            }

            return { deleted: true as const };
        }
    );
};
