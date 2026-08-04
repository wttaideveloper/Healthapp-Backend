import { desc } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";

import { auditLogs } from "@db/schema";

/**
 * Audit log read API.
 *
 * One endpoint, platform-admin only. Returns a bounded newest-first window; the
 * admin console does search, filtering, sorting, and pagination client-side over
 * that window, matching how every other directory view in the console works.
 *
 * Reads are deliberately NOT audited — logging a read of the audit log on every
 * page view would bury the administrative actions the trail exists to surface.
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

const auditLogQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const auditLogResponseSchema = z.object({
    id: z.string().uuid(),
    action: z.string(),
    actorUserId: z.string().uuid().nullable(),
    actorEmail: z.string().nullable(),
    actorRole: z.string().nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    targetLabel: z.string().nullable(),
    workspaceId: z.string().uuid().nullable(),
    workspaceName: z.string().nullable(),
    result: z.string(),
    metadata: z.unknown().nullable(),
    createdAt: z.string().datetime(),
});

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        "/audit-logs",
        {
            preHandler: app.authorize(["admin"]),
            schema: {
                summary: "List administrative audit events, newest first",
                querystring: auditLogQuerySchema,
                response: {
                    200: z.array(auditLogResponseSchema),
                },
            },
        },
        async (req) => {
            const rows = await app.db
                .select()
                .from(auditLogs)
                .orderBy(desc(auditLogs.createdAt))
                .limit(req.query.limit);

            return rows.map((row) => ({
                id: row.id,
                action: row.action,
                actorUserId: row.actorUserId,
                actorEmail: row.actorEmail,
                actorRole: row.actorRole,
                targetType: row.targetType,
                targetId: row.targetId,
                targetLabel: row.targetLabel,
                workspaceId: row.workspaceId,
                workspaceName: row.workspaceName,
                result: row.result,
                metadata: row.metadata ?? null,
                createdAt: row.createdAt.toISOString(),
            }));
        }
    );
};
