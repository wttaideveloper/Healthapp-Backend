import { and, desc, eq, ne, sql } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";

import { users, workspaceMembers, workspaces } from "@db/schema";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@core/errors/http-errors";
import { normalizeEmail } from "./workspace.util";

const idParamSchema = z.object({
    id: z.string().uuid(),
});

const memberIdParamSchema = z.object({
    id: z.string().uuid(),
    memberId: z.string().uuid(),
});

const addMemberBodySchema = z.object({
    email: z.string().trim().email(),
    role: z.enum(["admin", "member"]).default("member"),
});

const updateMemberBodySchema = z.object({
    role: z.enum(["admin", "member"]).optional(),
    status: z.enum(["active", "revoked"]).optional(),
});

const workspaceSummarySchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    role: z.string(),
    status: z.string(),
    subscriptionStatus: z.string(),
    plan: z.string(),
    seatLimit: z.number().int(),
    activeSeatCount: z.number().int(),
    expiresAt: z.string().datetime().nullable(),
});

const memberResponseSchema = z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    email: z.string().email(),
    role: z.string(),
    status: z.string(),
    joinedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

function serializeMember(row: typeof workspaceMembers.$inferSelect) {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        userId: row.userId,
        email: row.email,
        role: row.role,
        status: row.status,
        joinedAt: row.joinedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

async function getActiveSeatCount(app: Parameters<FastifyPluginAsyncZod>[0], workspaceId: string): Promise<number> {
    const [countRow] = await app.db
        .select({ count: sql<number>`count(*)` })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.status, "revoked")));

    return Number(countRow?.count ?? 0);
}

async function findUserIdByEmail(app: Parameters<FastifyPluginAsyncZod>[0], email: string): Promise<string | null> {
    const [user] = await app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    return user?.id ?? null;
}

async function requireWorkspaceManager(
    app: Parameters<FastifyPluginAsyncZod>[0],
    userId: string,
    workspaceId: string
) {
    const [row] = await app.db
        .select({
            workspace: workspaces,
            member: workspaceMembers,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
            and(
                eq(workspaceMembers.workspaceId, workspaceId),
                eq(workspaceMembers.userId, userId),
                eq(workspaceMembers.status, "active")
            )
        )
        .limit(1);

    if (!row) {
        throw new NotFoundError("Workspace not found");
    }

    if (!["owner", "admin"].includes(row.member.role)) {
        throw new ForbiddenError("Only workspace owners and admins can manage members");
    }

    return row;
}

export const workspaceRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        "/me",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "List workspaces available to the current user",
                response: {
                    200: z.array(workspaceSummarySchema),
                },
            },
        },
        async (req) => {
            const rows = await app.db
                .select({
                    workspaceId: workspaces.id,
                    name: workspaces.name,
                    role: workspaceMembers.role,
                    status: workspaces.status,
                    subscriptionStatus: workspaces.subscriptionStatus,
                    plan: workspaces.plan,
                    seatLimit: workspaces.seatLimit,
                    expiresAt: workspaces.expiresAt,
                })
                .from(workspaceMembers)
                .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
                .where(and(eq(workspaceMembers.userId, req.authUser!.sub), eq(workspaceMembers.status, "active")))
                .orderBy(desc(workspaces.createdAt));

            const counts = await Promise.all(rows.map((row) => getActiveSeatCount(app, row.workspaceId)));
            return rows.map((row, index) => ({
                id: row.workspaceId,
                name: row.name,
                role: row.role,
                status: row.status,
                subscriptionStatus: row.subscriptionStatus,
                plan: row.plan,
                seatLimit: row.seatLimit,
                activeSeatCount: counts[index] ?? 0,
                expiresAt: row.expiresAt?.toISOString() ?? null,
            }));
        }
    );

    app.get(
        "/:id/members",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "List workspace members",
                params: idParamSchema,
                response: {
                    200: z.array(memberResponseSchema),
                },
            },
        },
        async (req) => {
            await requireWorkspaceManager(app, req.authUser!.sub, req.params.id);

            const members = await app.db
                .select()
                .from(workspaceMembers)
                .where(eq(workspaceMembers.workspaceId, req.params.id))
                .orderBy(desc(workspaceMembers.createdAt));

            return members.map(serializeMember);
        }
    );

    app.post(
        "/:id/members",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Invite a member to the current user's workspace",
                params: idParamSchema,
                body: addMemberBodySchema,
                response: {
                    201: memberResponseSchema,
                },
            },
        },
        async (req, reply) => {
            const { workspace } = await requireWorkspaceManager(app, req.authUser!.sub, req.params.id);

            if (workspace.status !== "active") {
                throw new ForbiddenError("Workspace is not active");
            }

            const activeSeatCount = await getActiveSeatCount(app, workspace.id);
            if (activeSeatCount >= workspace.seatLimit) {
                throw new ForbiddenError("Workspace seat limit reached");
            }

            const email = normalizeEmail(req.body.email);
            const userId = await findUserIdByEmail(app, email);
            const now = new Date();
            const [existingMember] = await app.db
                .select()
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.email, email)))
                .limit(1);

            if (existingMember && existingMember.status !== "revoked") {
                throw new ConflictError("This email is already a member of the workspace");
            }

            if (existingMember) {
                const [reactivatedMember] = await app.db
                    .update(workspaceMembers)
                    .set({
                        userId: userId ?? existingMember.userId,
                        role: req.body.role,
                        status: userId ? "active" : "invited",
                        revokedAt: null,
                        invitedByUserId: req.authUser!.sub,
                        joinedAt: userId ? now : null,
                        updatedAt: now,
                    })
                    .where(eq(workspaceMembers.id, existingMember.id))
                    .returning();

                return reply.status(201).send(serializeMember(reactivatedMember));
            }

            const [createdMember] = await app.db
                .insert(workspaceMembers)
                .values({
                    workspaceId: workspace.id,
                    userId,
                    email,
                    role: req.body.role,
                    status: userId ? "active" : "invited",
                    invitedByUserId: req.authUser!.sub,
                    joinedAt: userId ? now : null,
                })
                .onConflictDoNothing()
                .returning();

            if (!createdMember) {
                throw new ConflictError("This email is already a member of the workspace");
            }

            return reply.status(201).send(serializeMember(createdMember));
        }
    );

    app.patch(
        "/:id/members/:memberId",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Update or revoke a workspace member",
                params: memberIdParamSchema,
                body: updateMemberBodySchema,
                response: {
                    200: memberResponseSchema,
                },
            },
        },
        async (req) => {
            await requireWorkspaceManager(app, req.authUser!.sub, req.params.id);

            const [member] = await app.db
                .select()
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.id, req.params.memberId), eq(workspaceMembers.workspaceId, req.params.id)))
                .limit(1);

            if (!member) {
                throw new NotFoundError("Workspace member not found");
            }

            if (member.role === "owner") {
                throw new BadRequestError("Workspace owner can only be changed by a platform admin");
            }

            const now = new Date();
            const updates: Partial<typeof workspaceMembers.$inferInsert> = { updatedAt: now };
            if (req.body.role !== undefined) updates.role = req.body.role;
            if (req.body.status !== undefined) {
                updates.status = req.body.status;
                updates.revokedAt = req.body.status === "revoked" ? now : null;
                updates.joinedAt = req.body.status === "active" && !member.joinedAt ? now : member.joinedAt;
            }

            const [updatedMember] = await app.db
                .update(workspaceMembers)
                .set(updates)
                .where(eq(workspaceMembers.id, member.id))
                .returning();

            return serializeMember(updatedMember);
        }
    );

    app.delete(
        "/:id/members/:memberId",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Revoke a workspace member",
                params: memberIdParamSchema,
                response: {
                    200: memberResponseSchema,
                },
            },
        },
        async (req) => {
            await requireWorkspaceManager(app, req.authUser!.sub, req.params.id);

            const [member] = await app.db
                .select()
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.id, req.params.memberId), eq(workspaceMembers.workspaceId, req.params.id)))
                .limit(1);

            if (!member) {
                throw new NotFoundError("Workspace member not found");
            }

            if (member.role === "owner") {
                throw new BadRequestError("Workspace owner can only be revoked by a platform admin");
            }

            const [updatedMember] = await app.db
                .update(workspaceMembers)
                .set({
                    status: "revoked",
                    revokedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(workspaceMembers.id, member.id))
                .returning();

            return serializeMember(updatedMember);
        }
    );
};
