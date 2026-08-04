import { desc, eq, sql } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";

import { env } from "@config/env";
import { users } from "@db/schema";
import { ConflictError, ForbiddenError, NotFoundError } from "@core/errors/http-errors";
import { hashPassword } from "@core/security/password";
import { getEntitlementState } from "@modules/entitlement/entitlement.service";

const createAdminBodySchema = z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
});

const createAdminHeadersSchema = z.object({
    "x-bootstrap-token": z.string().min(1).optional(),
});

const promoteAdminBodySchema = z.object({
    email: z.string().trim().email(),
});

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export const adminUserRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/users/promote-admin",
        {
            config: {
                rateLimit: {
                    max: env.RATE_LIMIT_ADMIN_BOOTSTRAP_MAX,
                    timeWindow: "1 minute",
                },
            },
            schema: {
                summary: "Promote existing user to admin",
                headers: createAdminHeadersSchema,
                body: promoteAdminBodySchema,
                response: {
                    200: z.object({
                        id: z.string().uuid(),
                        email: z.string().email(),
                        role: z.literal("admin"),
                    }),
                },
            },
        },
        async (req) => {
            let isAuthorizedByAdminJwt = false;

            if (req.headers.authorization) {
                try {
                    await app.authenticate(req);
                    isAuthorizedByAdminJwt = req.authUser?.role === "admin";
                } catch {
                    isAuthorizedByAdminJwt = false;
                }
            }

            const providedToken = req.headers["x-bootstrap-token"];
            const isAuthorizedByBootstrapToken =
                !isAuthorizedByAdminJwt &&
                Boolean(env.ADMIN_BOOTSTRAP_TOKEN) &&
                providedToken === env.ADMIN_BOOTSTRAP_TOKEN;

            if (!isAuthorizedByAdminJwt && !isAuthorizedByBootstrapToken) {
                throw new ForbiddenError(
                    "Only admins can promote users. For recovery, provide valid x-bootstrap-token"
                );
            }

            const targetEmail = normalizeEmail(req.body.email);

            const [promotedUser] = await app.db
                .update(users)
                .set({
                    role: "admin",
                    status: "active",
                    isEmailVerified: true,
                })
                .where(eq(users.email, targetEmail))
                .returning({
                    id: users.id,
                    email: users.email,
                    role: users.role,
                });

            if (!promotedUser) {
                throw new NotFoundError("User not found for this email");
            }

            return {
                id: promotedUser.id,
                email: promotedUser.email,
                role: "admin" as const,
            };
        }
    );

    app.get(
        "/users",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "List users",
                response: {
                    200: z.array(
                        z.object({
                            id: z.string().uuid(),
                            name: z.string(),
                            email: z.string().email(),
                            role: z.enum(["user", "admin"]),
                            status: z.enum(["pending", "active"]),
                            hasAccess: z.boolean(),
                            isEmailVerified: z.boolean(),
                            createdAt: z.string().datetime(),
                        })
                    ),
                },
            },
        },
        async () => {
            const rows = await app.db.select().from(users).orderBy(desc(users.createdAt));

            return Promise.all(
                rows.map(async (row) => {
                    const entitlement = await getEntitlementState(app, row.id);
                    return {
                        id: row.id,
                        name: row.name,
                        email: row.email,
                        role: row.role,
                        status: row.status,
                        hasAccess: entitlement.hasAccess,
                        isEmailVerified: row.isEmailVerified,
                        createdAt: row.createdAt.toISOString(),
                    };
                })
            );
        }
    );

    app.post(
        "/users/admin",
        {
            config: {
                rateLimit: {
                    max: env.RATE_LIMIT_ADMIN_BOOTSTRAP_MAX,
                    timeWindow: "1 minute",
                },
            },
            schema: {
                summary: "Create admin user",
                headers: createAdminHeadersSchema,
                body: createAdminBodySchema,
                response: {
                    201: z.object({
                        id: z.string().uuid(),
                        name: z.string(),
                        email: z.string().email(),
                        role: z.literal("admin"),
                    }),
                },
            },
        },
        async (req, reply) => {
            let isAuthorizedByAdminJwt = false;

            if (req.headers.authorization) {
                try {
                    await app.authenticate(req);
                    isAuthorizedByAdminJwt = req.authUser?.role === "admin";
                } catch {
                    isAuthorizedByAdminJwt = false;
                }
            }

            let isAuthorizedByBootstrapToken = false;
            if (!isAuthorizedByAdminJwt && env.ADMIN_BOOTSTRAP_TOKEN) {
                const [adminCountRow] = await app.db
                    .select({ count: sql<number>`count(*)` })
                    .from(users)
                    .where(eq(users.role, "admin"));

                const adminCount = Number(adminCountRow?.count ?? 0);
                const providedToken = req.headers["x-bootstrap-token"];

                if (adminCount === 0 && providedToken === env.ADMIN_BOOTSTRAP_TOKEN) {
                    isAuthorizedByBootstrapToken = true;
                }
            }

            if (!isAuthorizedByAdminJwt && !isAuthorizedByBootstrapToken) {
                throw new ForbiddenError(
                    "Only admins can create another admin. For first admin setup, provide valid x-bootstrap-token"
                );
            }

            const email = normalizeEmail(req.body.email);

            const [existingUser] = await app.db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, email))
                .limit(1);

            if (existingUser) {
                throw new ConflictError("Email already exists");
            }

            const passwordHash = await hashPassword(req.body.password);

            const [createdAdmin] = await app.db
                .insert(users)
                .values({
                    name: req.body.name.trim(),
                    email,
                    passwordHash,
                    role: "admin",
                    status: "active",
                    isEmailVerified: true,
                })
                .returning();

            return reply.status(201).send({
                id: createdAdmin.id,
                name: createdAdmin.name,
                email: createdAdmin.email,
                role: "admin",
            });
        }
    );
};
