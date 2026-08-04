import { and, desc, eq, ne, sql } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import nodemailer from "nodemailer";
import z from "zod";

import { env } from "@config/env";
import { users, workspaceMembers, workspaces } from "@db/schema";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@core/errors/http-errors";
import {
    normalizeEmail,
    workspaceMemberStatuses,
    workspaceRoles,
    workspaceStatuses,
    workspaceSubscriptionStatuses,
} from "@modules/workspace/workspace.util";
import {
    AUDIT_ACTIONS,
    AUDIT_TARGETS,
    auditActorFromRequest,
    buildAuditChangeSet,
    recordAuditEvent,
} from "@modules/audit/audit.service";

const idParamSchema = z.object({
    id: z.string().uuid(),
});

const memberIdParamSchema = z.object({
    id: z.string().uuid(),
    memberId: z.string().uuid(),
});

const createWorkspaceBodySchema = z.object({
    name: z.string().trim().min(2).max(200),
    ownerEmail: z.string().trim().email(),
    seatLimit: z.number().int().positive(),
    plan: z.string().trim().min(1).max(100).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    subscriptionStatus: z.enum(workspaceSubscriptionStatuses).optional(),
    status: z.enum(workspaceStatuses).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
});

const updateWorkspaceBodySchema = z.object({
    name: z.string().trim().min(2).max(200).optional(),
    ownerEmail: z.string().trim().email().optional(),
    seatLimit: z.number().int().positive().optional(),
    plan: z.string().trim().min(1).max(100).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    subscriptionStatus: z.enum(workspaceSubscriptionStatuses).optional(),
    status: z.enum(workspaceStatuses).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
});

const addMemberBodySchema = z.object({
    email: z.string().trim().email(),
    role: z.enum(workspaceRoles).default("member"),
});

const updateMemberBodySchema = z.object({
    role: z.enum(workspaceRoles).optional(),
    status: z.enum(workspaceMemberStatuses).optional(),
});

const workspaceResponseSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    ownerUserId: z.string().uuid().nullable(),
    ownerEmail: z.string().email(),
    status: z.string(),
    subscriptionStatus: z.string(),
    plan: z.string(),
    seatLimit: z.number().int(),
    activeSeatCount: z.number().int(),
    expiresAt: z.string().datetime().nullable(),
    notes: z.string().nullable(),
    createdByUserId: z.string().uuid().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

const memberResponseSchema = z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    email: z.string().email(),
    role: z.string(),
    status: z.string(),
    invitedByUserId: z.string().uuid().nullable(),
    joinedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

function inferDisplayName(email: string, explicitName?: string | null): string {
    if (explicitName && explicitName.trim().length > 0) return explicitName.trim();
    const localPart = email.split("@")[0] ?? "User";
    return localPart || "User";
}

function getWorkspaceInviteEmailContent(input: {
    organizationName: string;
    userName: string;
    userEmail: string;
    isOwner: boolean;
}) {
    const subject = input.isOwner
        ? `You’ve Been Added as Workspace Admin to ${input.organizationName}’s “Discover your health age” App Pro Account`
        : `You’ve Been Added to ${input.organizationName}’s “Discover your health age” App’s Pro Account`;

    const introRoleLine = input.isOwner
        ? "You have been added as the workspace administrator for your organization."
        : "Your organization administrator has granted you access to premium features as part of your organization’s subscription.";

    const text = `Hello ${input.userName},

You’ve been added to the Pro account for ${input.organizationName} on “Discover your health age” App.
${introRoleLine}

To get started:
1. Visit: https://health-age-admin.vercel.app/workspace-admin
2. Download the app for your device (iPhone, Android, Windows, or Mac)
3. Sign in using this email address: ${input.userEmail}
4. If you don’t already have an account, create one using this email address
5. Your Pro access will automatically be activated after login`;

    const html = `<p>Hello ${input.userName},</p>
<p>You’ve been added to the Pro account for <strong>${input.organizationName}</strong> on “Discover your health age” App.</p>
<p>${introRoleLine}</p>
<p>To get started:</p>
<ol>
<li>Visit: <a href="https://health-age-admin.vercel.app/workspace-admin">https://health-age-admin.vercel.app/workspace-admin</a></li>
<li>Download the app for your device (iPhone, Android, Windows, or Mac)</li>
<li>Sign in using this email address: <strong>${input.userEmail}</strong></li>
<li>If you don’t already have an account, create one using this email address</li>
<li>Your Pro access will automatically be activated after login</li>
</ol>`;

    return { subject, text, html };
}

function serializeWorkspace(row: typeof workspaces.$inferSelect, activeSeatCount: number) {
    return {
        id: row.id,
        name: row.name,
        ownerUserId: row.ownerUserId,
        ownerEmail: row.ownerEmail,
        status: row.status,
        subscriptionStatus: row.subscriptionStatus,
        plan: row.plan,
        seatLimit: row.seatLimit,
        activeSeatCount,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        notes: row.notes,
        createdByUserId: row.createdByUserId,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function serializeMember(row: typeof workspaceMembers.$inferSelect) {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        userId: row.userId,
        email: row.email,
        role: row.role,
        status: row.status,
        invitedByUserId: row.invitedByUserId,
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

/**
 * Workspace name for an audit row's `workspaceName` column.
 *
 * One indexed primary-key lookup. Member mutations are human-driven and
 * low-frequency, and denormalising the name is what keeps the audit row readable
 * after the workspace is renamed or deleted.
 */
async function getWorkspaceLabel(
    app: Parameters<FastifyPluginAsyncZod>[0],
    workspaceId: string
): Promise<string | null> {
    const [row] = await app.db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

    return row?.name ?? null;
}

/** Maps a member transition onto the most specific audit action it represents. */
function resolveMemberAuditAction(
    before: { role: string; status: string },
    after: { role: string; status: string }
) {
    if (before.status !== "revoked" && after.status === "revoked") {
        // An invite that never became active was withdrawn, not a member removed.
        return before.status === "invited" ? AUDIT_ACTIONS.INVITATION_REVOKED : AUDIT_ACTIONS.MEMBER_REMOVED;
    }
    if (before.status === "revoked" && after.status !== "revoked") {
        return AUDIT_ACTIONS.MEMBER_RESTORED;
    }
    if (before.role !== after.role) {
        return AUDIT_ACTIONS.MEMBER_ROLE_CHANGED;
    }
    return null;
}

async function findUserByEmail(app: Parameters<FastifyPluginAsyncZod>[0], email: string) {
    return app.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .then((rows) => rows[0] ?? null);
}

async function ensureWorkspaceCapacity(
    app: Parameters<FastifyPluginAsyncZod>[0],
    workspaceId: string,
    seatLimit: number
) {
    const activeSeatCount = await getActiveSeatCount(app, workspaceId);
    if (activeSeatCount >= seatLimit) {
        throw new ForbiddenError("Workspace seat limit reached");
    }
}

export const adminWorkspaceRoutes: FastifyPluginAsyncZod = async (app) => {
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
        "/workspaces",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Provision organization workspace after external payment",
                body: createWorkspaceBodySchema,
                response: {
                    201: workspaceResponseSchema,
                },
            },
        },
        async (req, reply) => {
            const ownerEmail = normalizeEmail(req.body.ownerEmail);
            const existingUser = await findUserByEmail(app, ownerEmail);
            const now = new Date();

            const createdWorkspace = await app.db.transaction(async (tx) => {
                const [workspace] = await tx
                    .insert(workspaces)
                    .values({
                        name: req.body.name.trim(),
                        ownerEmail,
                        ownerUserId: existingUser?.id ?? null,
                        seatLimit: req.body.seatLimit,
                        plan: req.body.plan?.trim() ?? "organization",
                        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
                        subscriptionStatus: req.body.subscriptionStatus ?? "active",
                        status: req.body.status ?? "active",
                        notes: req.body.notes ?? null,
                        createdByUserId: req.authUser!.sub,
                    })
                    .returning();

                await tx.insert(workspaceMembers).values({
                    workspaceId: workspace.id,
                    userId: existingUser?.id ?? null,
                    email: ownerEmail,
                    role: "owner",
                    status: existingUser ? "active" : "invited",
                    invitedByUserId: req.authUser!.sub,
                    joinedAt: existingUser ? now : null,
                });

                return workspace;
            });

            await recordAuditEvent(app.db, req.log, {
                action: AUDIT_ACTIONS.WORKSPACE_CREATED,
                actor: auditActorFromRequest(req),
                target: { type: AUDIT_TARGETS.WORKSPACE, id: createdWorkspace.id, label: createdWorkspace.name },
                workspace: { id: createdWorkspace.id, name: createdWorkspace.name },
                metadata: {
                    ownerEmail,
                    seatLimit: createdWorkspace.seatLimit,
                    plan: createdWorkspace.plan,
                    subscriptionStatus: createdWorkspace.subscriptionStatus,
                },
            });

            const ownerMail = getWorkspaceInviteEmailContent({
                organizationName: createdWorkspace.name,
                userName: inferDisplayName(ownerEmail, existingUser?.name),
                userEmail: ownerEmail,
                isOwner: true,
            });

            await smtpTransport.sendMail({
                from: env.EMAIL_FROM ?? env.SMTP_USER,
                to: ownerEmail,
                subject: ownerMail.subject,
                text: ownerMail.text,
                html: ownerMail.html,
            });

            return reply.status(201).send(serializeWorkspace(createdWorkspace, 1));
        }
    );

    app.get(
        "/workspaces",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "List organization workspaces",
                response: {
                    200: z.array(workspaceResponseSchema),
                },
            },
        },
        async () => {
            const rows = await app.db.select().from(workspaces).orderBy(desc(workspaces.createdAt));
            const counts = await Promise.all(rows.map((row) => getActiveSeatCount(app, row.id)));
            return rows.map((row, index) => serializeWorkspace(row, counts[index] ?? 0));
        }
    );

    app.get(
        "/workspaces/:id/members",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "List members for an organization workspace",
                params: idParamSchema,
                response: {
                    200: z.array(memberResponseSchema),
                },
            },
        },
        async (req) => {
            const [workspace] = await app.db.select().from(workspaces).where(eq(workspaces.id, req.params.id)).limit(1);
            if (!workspace) {
                throw new NotFoundError("Workspace not found");
            }

            const members = await app.db
                .select()
                .from(workspaceMembers)
                .where(eq(workspaceMembers.workspaceId, workspace.id))
                .orderBy(desc(workspaceMembers.createdAt));

            return members.map(serializeMember);
        }
    );

    app.get(
        "/workspaces/:id",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Get organization workspace details",
                params: idParamSchema,
                response: {
                    200: workspaceResponseSchema.extend({
                        members: z.array(memberResponseSchema),
                    }),
                },
            },
        },
        async (req) => {
            const [workspace] = await app.db.select().from(workspaces).where(eq(workspaces.id, req.params.id)).limit(1);
            if (!workspace) {
                throw new NotFoundError("Workspace not found");
            }

            const members = await app.db
                .select()
                .from(workspaceMembers)
                .where(eq(workspaceMembers.workspaceId, workspace.id))
                .orderBy(desc(workspaceMembers.createdAt));

            return {
                ...serializeWorkspace(workspace, await getActiveSeatCount(app, workspace.id)),
                members: members.map(serializeMember),
            };
        }
    );

    app.patch(
        "/workspaces/:id",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Update organization workspace access/subscription state",
                params: idParamSchema,
                body: updateWorkspaceBodySchema,
                response: {
                    200: workspaceResponseSchema,
                },
            },
        },
        async (req) => {
            const [existingWorkspace] = await app.db.select().from(workspaces).where(eq(workspaces.id, req.params.id)).limit(1);
            if (!existingWorkspace) {
                throw new NotFoundError("Workspace not found");
            }

            if (req.body.seatLimit !== undefined) {
                const activeSeatCount = await getActiveSeatCount(app, existingWorkspace.id);
                if (req.body.seatLimit < activeSeatCount) {
                    throw new BadRequestError("seatLimit cannot be lower than current non-revoked member count");
                }
            }

            const now = new Date();
            const updates: Partial<typeof workspaces.$inferInsert> = { updatedAt: now };

            if (req.body.name !== undefined) updates.name = req.body.name.trim();
            if (req.body.ownerEmail !== undefined) {
                const ownerEmail = normalizeEmail(req.body.ownerEmail);
                const ownerUser = await findUserByEmail(app, ownerEmail);
                updates.ownerEmail = ownerEmail;
                updates.ownerUserId = ownerUser?.id ?? null;
            }
            if (req.body.seatLimit !== undefined) updates.seatLimit = req.body.seatLimit;
            if (req.body.plan !== undefined) updates.plan = req.body.plan.trim();
            if (req.body.expiresAt !== undefined) updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
            if (req.body.subscriptionStatus !== undefined) updates.subscriptionStatus = req.body.subscriptionStatus;
            if (req.body.status !== undefined) {
                updates.status = req.body.status;
                updates.revokedAt = req.body.status === "revoked" ? now : null;
            }
            if (req.body.notes !== undefined) updates.notes = req.body.notes;

            const [updatedWorkspace] = await app.db
                .update(workspaces)
                .set(updates)
                .where(eq(workspaces.id, req.params.id))
                .returning();

            // One row per request, using the most specific action the change
            // represents. The full field diff always rides along in metadata, so
            // narrowing the action name never loses information.
            const changes = buildAuditChangeSet(existingWorkspace, updatedWorkspace, [
                "name",
                "ownerEmail",
                "seatLimit",
                "plan",
                "expiresAt",
                "subscriptionStatus",
                "status",
                "notes",
            ]);

            if (changes) {
                const becameRevoked =
                    existingWorkspace.status !== "revoked" && updatedWorkspace.status === "revoked";
                const subscriptionChanged =
                    existingWorkspace.subscriptionStatus !== updatedWorkspace.subscriptionStatus;

                await recordAuditEvent(app.db, req.log, {
                    action: becameRevoked
                        ? AUDIT_ACTIONS.WORKSPACE_REVOKED
                        : subscriptionChanged
                          ? AUDIT_ACTIONS.WORKSPACE_SUBSCRIPTION_CHANGED
                          : AUDIT_ACTIONS.WORKSPACE_UPDATED,
                    actor: auditActorFromRequest(req),
                    target: {
                        type: AUDIT_TARGETS.WORKSPACE,
                        id: updatedWorkspace.id,
                        label: updatedWorkspace.name,
                    },
                    workspace: { id: updatedWorkspace.id, name: updatedWorkspace.name },
                    metadata: { changes },
                });
            }

            return serializeWorkspace(updatedWorkspace, await getActiveSeatCount(app, updatedWorkspace.id));
        }
    );

    app.post(
        "/workspaces/:id/members",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Add or invite a workspace member by email",
                params: idParamSchema,
                body: addMemberBodySchema,
                response: {
                    201: memberResponseSchema,
                },
            },
        },
        async (req, reply) => {
            const [workspace] = await app.db.select().from(workspaces).where(eq(workspaces.id, req.params.id)).limit(1);
            if (!workspace) {
                throw new NotFoundError("Workspace not found");
            }

            await ensureWorkspaceCapacity(app, workspace.id, workspace.seatLimit);

            const email = normalizeEmail(req.body.email);
            const existingUser = await findUserByEmail(app, email);
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
                        userId: existingUser?.id ?? existingMember.userId,
                        role: req.body.role,
                        status: existingUser ? "active" : "invited",
                        revokedAt: null,
                        invitedByUserId: req.authUser!.sub,
                        joinedAt: existingUser ? new Date() : null,
                        updatedAt: new Date(),
                    })
                    .where(eq(workspaceMembers.id, existingMember.id))
                    .returning();

                await recordAuditEvent(app.db, req.log, {
                    action: AUDIT_ACTIONS.MEMBER_INVITED,
                    actor: auditActorFromRequest(req),
                    target: { type: AUDIT_TARGETS.MEMBER, id: reactivatedMember.id, label: email },
                    workspace: { id: workspace.id, name: workspace.name },
                    metadata: { role: req.body.role, reinvitedFromRevoked: true, status: reactivatedMember.status },
                });

                const reactivatedMail = getWorkspaceInviteEmailContent({
                    organizationName: workspace.name,
                    userName: inferDisplayName(email, existingUser?.name),
                    userEmail: email,
                    isOwner: req.body.role === "owner",
                });

                await smtpTransport.sendMail({
                    from: env.EMAIL_FROM ?? env.SMTP_USER,
                    to: email,
                    subject: reactivatedMail.subject,
                    text: reactivatedMail.text,
                    html: reactivatedMail.html,
                });

                return reply.status(201).send(serializeMember(reactivatedMember));
            }

            const [createdMember] = await app.db
                .insert(workspaceMembers)
                .values({
                    workspaceId: workspace.id,
                    userId: existingUser?.id ?? null,
                    email,
                    role: req.body.role,
                    status: existingUser ? "active" : "invited",
                    invitedByUserId: req.authUser!.sub,
                    joinedAt: existingUser ? new Date() : null,
                })
                .onConflictDoNothing()
                .returning();

            if (!createdMember) {
                throw new ConflictError("This email is already a member of the workspace");
            }

            await recordAuditEvent(app.db, req.log, {
                action: AUDIT_ACTIONS.MEMBER_INVITED,
                actor: auditActorFromRequest(req),
                target: { type: AUDIT_TARGETS.MEMBER, id: createdMember.id, label: email },
                workspace: { id: workspace.id, name: workspace.name },
                metadata: { role: req.body.role, status: createdMember.status },
            });

            const memberMail = getWorkspaceInviteEmailContent({
                organizationName: workspace.name,
                userName: inferDisplayName(email, existingUser?.name),
                userEmail: email,
                isOwner: req.body.role === "owner",
            });

            await smtpTransport.sendMail({
                from: env.EMAIL_FROM ?? env.SMTP_USER,
                to: email,
                subject: memberMail.subject,
                text: memberMail.text,
                html: memberMail.html,
            });

            return reply.status(201).send(serializeMember(createdMember));
        }
    );

    app.patch(
        "/workspaces/:id/members/:memberId",
        {
            preHandler: app.authorize(["admin"]),
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
            const [member] = await app.db
                .select()
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.id, req.params.memberId), eq(workspaceMembers.workspaceId, req.params.id)))
                .limit(1);

            if (!member) {
                throw new NotFoundError("Workspace member not found");
            }

            if (member.role === "owner" && req.body.status === "revoked") {
                throw new BadRequestError("Transfer ownership before revoking the owner");
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

            const memberAction = resolveMemberAuditAction(member, updatedMember);
            if (memberAction) {
                await recordAuditEvent(app.db, req.log, {
                    action: memberAction,
                    actor: auditActorFromRequest(req),
                    target: { type: AUDIT_TARGETS.MEMBER, id: updatedMember.id, label: updatedMember.email },
                    workspace: { id: req.params.id, name: await getWorkspaceLabel(app, req.params.id) },
                    metadata: buildAuditChangeSet(member, updatedMember, ["role", "status"]),
                });
            }

            return serializeMember(updatedMember);
        }
    );

    app.delete(
        "/workspaces/:id/members/:memberId",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "Revoke a workspace member",
                params: memberIdParamSchema,
                response: {
                    200: memberResponseSchema,
                },
            },
        },
        async (req) => {
            const [member] = await app.db
                .select()
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.id, req.params.memberId), eq(workspaceMembers.workspaceId, req.params.id)))
                .limit(1);

            if (!member) {
                throw new NotFoundError("Workspace member not found");
            }

            if (member.role === "owner") {
                throw new BadRequestError("Transfer ownership before revoking the owner");
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

            await recordAuditEvent(app.db, req.log, {
                action:
                    member.status === "invited"
                        ? AUDIT_ACTIONS.INVITATION_REVOKED
                        : AUDIT_ACTIONS.MEMBER_REMOVED,
                actor: auditActorFromRequest(req),
                target: { type: AUDIT_TARGETS.MEMBER, id: updatedMember.id, label: updatedMember.email },
                workspace: { id: req.params.id, name: await getWorkspaceLabel(app, req.params.id) },
                metadata: { role: updatedMember.role, previousStatus: member.status },
            });

            return serializeMember(updatedMember);
        }
    );
};
