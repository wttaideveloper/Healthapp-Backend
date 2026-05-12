import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import z from "zod";
import nodemailer from "nodemailer";
import { createHash, randomInt } from "node:crypto";

import { passwordResets, users } from "@db/schema";
import { BadRequestError, ConflictError, UnauthorizedError } from "@core/errors/http-errors";
import { hashPassword, verifyPassword } from "@core/security/password";
import { env } from "@config/env";
import { getEntitlementState, linkWorkspaceMembershipsForUser } from "@modules/entitlement/entitlement.service";

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
        hasAccess: z.boolean(),
        isEmailVerified: z.boolean(),
        status: z.enum(["pending", "active"]),
    }),
});

const forgotPasswordBodySchema = z.object({
    email: z.string().trim().email(),
});

const forgotPasswordResponseSchema = z.object({
    ok: z.literal(true),
    message: z.string(),
});

const resetPasswordBodySchema = z.object({
    email: z.string().trim().email(),
    otp: z
        .string()
        .trim()
        .regex(/^\d{6}$/, "OTP must be a 6-digit code"),
    newPassword: z.string().min(8).max(128),
});

const resetPasswordResponseSchema = z.object({
    ok: z.literal(true),
    message: z.string(),
});

const meResponseSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    role: z.enum(["user", "admin"]),
    hasAccess: z.boolean(),
    isEmailVerified: z.boolean(),
    status: z.enum(["pending", "active"]),
    entitlement: z.object({
        source: z.enum(["workspace", "individual_iap", "individual_stripe"]).nullable(),
        expiresAt: z.string().datetime().nullable(),
        providerStatus: z.string().nullable(),
    }),
});

function sanitizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function hashResetToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
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
    const smtpTransport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
        },
    });

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
            await linkWorkspaceMembershipsForUser(app, newUser);
            const entitlement = await getEntitlementState(app, newUser.id);

            return reply.status(201).send({
                accessToken,
                user: {
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    role: newUser.role,
                    hasAccess: entitlement.hasAccess,
                    isEmailVerified: newUser.isEmailVerified,
                    status: newUser.status,
                },
            });
        }
    );

    app.post(
        "/forgot-password",
        {
            schema: {
                summary: "Request password reset email",
                body: forgotPasswordBodySchema,
                response: {
                    200: forgotPasswordResponseSchema,
                },
            },
        },
        async (req) => {
            const email = sanitizeEmail(req.body.email);

            const [foundUser] = await app.db
                .select()
                .from(users)
                .where(and(eq(users.email, email), eq(users.status, "active")))
                .limit(1);

            if (foundUser) {
                const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
                const tokenHash = hashResetToken(otp);
                const expiresAt = new Date(Date.now() + 1000 * 60 * 10);

                await app.db.insert(passwordResets).values({
                    userId: foundUser.id,
                    tokenHash,
                    expiresAt,
                });

                await smtpTransport.sendMail({
                    from: env.EMAIL_FROM ?? env.SMTP_USER,
                    to: foundUser.email,
                    subject: "Your HealthAge password reset code",
                    text: `Your HealthAge password reset OTP is ${otp}. It expires in 10 minutes.`,
                    html: `<p>Your HealthAge password reset OTP is <strong>${otp}</strong>.</p><p>This code expires in 10 minutes.</p>`,
                });
            }

            return {
                ok: true as const,
                message: "If an account with that email exists, a reset link has been sent.",
            };
        }
    );

    app.post(
        "/reset-password",
        {
            schema: {
                summary: "Reset password with reset token",
                body: resetPasswordBodySchema,
                response: {
                    200: resetPasswordResponseSchema,
                },
            },
        },
        async (req) => {
            const email = sanitizeEmail(req.body.email);
            const now = new Date();
            const [foundUser] = await app.db
                .select()
                .from(users)
                .where(and(eq(users.email, email), eq(users.status, "active")))
                .limit(1);

            if (!foundUser) {
                throw new BadRequestError("Invalid OTP or email");
            }

            const tokenHash = hashResetToken(req.body.otp);

            const [activeReset] = await app.db
                .select()
                .from(passwordResets)
                .where(
                    and(
                        eq(passwordResets.userId, foundUser.id),
                        eq(passwordResets.tokenHash, tokenHash),
                        isNull(passwordResets.consumedAt),
                        gt(passwordResets.expiresAt, now)
                    )
                )
                .orderBy(desc(passwordResets.createdAt))
                .limit(1);

            if (!activeReset) {
                throw new BadRequestError("Invalid or expired OTP");
            }

            const newPasswordHash = await hashPassword(req.body.newPassword);

            await app.db.transaction(async (tx) => {
                await tx
                    .update(users)
                    .set({
                        passwordHash: newPasswordHash,
                        updatedAt: now,
                    })
                    .where(eq(users.id, activeReset.userId));

                await tx
                    .update(passwordResets)
                    .set({
                        consumedAt: now,
                    })
                    .where(eq(passwordResets.id, activeReset.id));
            });

            return {
                ok: true as const,
                message: "Password updated successfully.",
            };
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
            await linkWorkspaceMembershipsForUser(app, foundUser);
            const entitlement = await getEntitlementState(app, foundUser.id);

            return {
                accessToken,
                user: {
                    id: foundUser.id,
                    name: foundUser.name,
                    email: foundUser.email,
                    role: foundUser.role,
                    hasAccess: entitlement.hasAccess,
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
            await linkWorkspaceMembershipsForUser(app, foundUser);
            const entitlement = await getEntitlementState(app, foundUser.id);

            return {
                id: foundUser.id,
                name: foundUser.name,
                email: foundUser.email,
                role: foundUser.role,
                hasAccess: entitlement.hasAccess,
                isEmailVerified: foundUser.isEmailVerified,
                status: foundUser.status,
                entitlement: {
                    source: entitlement.source,
                    expiresAt: entitlement.expiresAt,
                    providerStatus: entitlement.providerStatus,
                },
            };
        }
    );
};
