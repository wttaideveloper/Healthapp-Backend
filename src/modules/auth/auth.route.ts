import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { and, eq } from "drizzle-orm";
import z from "zod";

import { users } from "@db/schema";
import { ConflictError, UnauthorizedError } from "@core/errors/http-errors";
import { hashPassword, verifyPassword } from "@core/security/password";
import { env } from "@config/env";

const registerBodySchema = z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
});

const loginBodySchema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
});

const authResponseSchema = z.object({
    accessToken: z.string(),
    user: z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string().email(),
        role: z.enum(["user", "admin"]),
        isLicensed: z.boolean(),
        isEmailVerified: z.boolean(),
        status: z.enum(["pending", "active"]),
    }),
});

const meResponseSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    role: z.enum(["user", "admin"]),
    isLicensed: z.boolean(),
    isEmailVerified: z.boolean(),
    status: z.enum(["pending", "active"]),
    licenseId: z.string().uuid().nullable(),
});

function sanitizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function isBootstrapAdminEmail(email: string): boolean {
    if (!env.ADMIN_EMAILS) {
        return false;
    }

    const admins = env.ADMIN_EMAILS
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);

    return admins.includes(email);
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/register",
        {
            schema: {
                summary: "Register a user",
                body: registerBodySchema,
                response: {
                    201: authResponseSchema,
                },
            },
        },
        async (req, reply) => {
            const email = sanitizeEmail(req.body.email);

            const [existing] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
            if (existing) {
                throw new ConflictError("Email already exists");
            }

            const passwordHash = await hashPassword(req.body.password);

            const [newUser] = await app.db
                .insert(users)
                .values({
                    name: req.body.name.trim(),
                    email,
                    passwordHash,
                    role: isBootstrapAdminEmail(email) ? "admin" : "user",
                    status: "active",
                    isEmailVerified: true,
                })
                .returning();

            const accessToken = await reply.jwtSign({
                sub: newUser.id,
                role: newUser.role,
                email: newUser.email,
            });

            return reply.status(201).send({
                accessToken,
                user: {
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    role: newUser.role,
                    isLicensed: newUser.isLicensed,
                    isEmailVerified: newUser.isEmailVerified,
                    status: newUser.status,
                },
            });
        }
    );

    app.post(
        "/login",
        {
            schema: {
                summary: "Log in user",
                body: loginBodySchema,
                response: {
                    200: authResponseSchema,
                },
            },
        },
        async (req, reply) => {
            const email = sanitizeEmail(req.body.email);

            const [foundUser] = await app.db
                .select()
                .from(users)
                .where(and(eq(users.email, email), eq(users.status, "active")))
                .limit(1);

            if (!foundUser) {
                throw new UnauthorizedError("Invalid email or password");
            }

            const isPasswordValid = await verifyPassword(req.body.password, foundUser.passwordHash);
            if (!isPasswordValid) {
                throw new UnauthorizedError("Invalid email or password");
            }

            const accessToken = await reply.jwtSign({
                sub: foundUser.id,
                role: foundUser.role,
                email: foundUser.email,
            });

            return {
                accessToken,
                user: {
                    id: foundUser.id,
                    name: foundUser.name,
                    email: foundUser.email,
                    role: foundUser.role,
                    isLicensed: foundUser.isLicensed,
                    isEmailVerified: foundUser.isEmailVerified,
                    status: foundUser.status,
                },
            };
        }
    );

    app.get(
        "/me",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Get current authenticated user",
                response: {
                    200: meResponseSchema,
                },
            },
        },
        async (req) => {
            const [foundUser] = await app.db
                .select()
                .from(users)
                .where(eq(users.id, req.authUser!.sub))
                .limit(1);

            if (!foundUser) {
                throw new UnauthorizedError("Authenticated user not found");
            }

            return {
                id: foundUser.id,
                name: foundUser.name,
                email: foundUser.email,
                role: foundUser.role,
                isLicensed: foundUser.isLicensed,
                isEmailVerified: foundUser.isEmailVerified,
                status: foundUser.status,
                licenseId: foundUser.licenseId,
            };
        }
    );
};
