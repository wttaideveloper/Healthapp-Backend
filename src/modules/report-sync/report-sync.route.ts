import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
    deleteBodySchema,
    groupCreateBodySchema,
    groupListQuerySchema,
    groupResponseSchema,
    groupUpdateBodySchema,
    recordParamsSchema,
    relationshipDeleteBodySchema,
    relationshipParamsSchema,
    relationshipPutBodySchema,
    reportCreateBodySchema,
    reportListQuerySchema,
    reportResponseSchema,
    reportUpdateBodySchema,
    syncPullQuerySchema,
    syncPullResponseSchema,
    syncPushBodySchema,
    syncPushResponseSchema,
} from "./report-sync.schema";
import {
    applySyncMutations,
    getGroup,
    getReport,
    listGroups,
    listReports,
    pullSyncChanges,
} from "./report-sync.service";

const privateRateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

export const reportSyncRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/reports",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            bodyLimit: 512 * 1024,
            schema: {
                summary: "Create an account-owned health report",
                body: reportCreateBodySchema,
                response: { 201: syncPushResponseSchema },
            },
        },
        async (req, reply) => {
            const result = await applySyncMutations(app.db, req.authUser!.sub, [
                { ...req.body, type: "report.create" },
            ]);
            return reply.status(201).send(result);
        }
    );

    app.get(
        "/reports",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "List the authenticated user's reports",
                querystring: reportListQuerySchema,
                response: {
                    200: z.object({
                        items: z.array(reportResponseSchema.extend({ groupIds: z.array(z.string()) })),
                        nextCursor: z.string().nullable(),
                    }),
                },
            },
        },
        async (req) => listReports(app.db, req.authUser!.sub, req.query.limit, req.query.cursor)
    );

    app.get(
        "/reports/:id",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "Get one account-owned report",
                params: recordParamsSchema,
                response: { 200: reportResponseSchema.extend({ groupIds: z.array(z.string()) }) },
            },
        },
        async (req) => getReport(app.db, req.authUser!.sub, req.params.id)
    );

    app.patch(
        "/reports/:id",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            bodyLimit: 512 * 1024,
            schema: {
                summary: "Update a report with optimistic concurrency",
                params: recordParamsSchema,
                body: reportUpdateBodySchema,
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) =>
            applySyncMutations(app.db, req.authUser!.sub, [
                { ...req.body, type: "report.update", id: req.params.id },
            ])
    );

    app.delete(
        "/reports/:id",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "Soft-delete a report and emit tombstones",
                params: recordParamsSchema,
                body: deleteBodySchema,
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) =>
            applySyncMutations(app.db, req.authUser!.sub, [
                { ...req.body, type: "report.delete", id: req.params.id },
            ])
    );

    app.post(
        "/report-groups",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            bodyLimit: 32 * 1024,
            schema: {
                summary: "Create an account-owned report group",
                body: groupCreateBodySchema,
                response: { 201: syncPushResponseSchema },
            },
        },
        async (req, reply) => {
            const result = await applySyncMutations(app.db, req.authUser!.sub, [
                { ...req.body, type: "group.create" },
            ]);
            return reply.status(201).send(result);
        }
    );

    app.get(
        "/report-groups",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "List the authenticated user's report groups",
                querystring: groupListQuerySchema,
                response: {
                    200: z.object({ items: z.array(groupResponseSchema), nextCursor: z.string().nullable() }),
                },
            },
        },
        async (req) => listGroups(app.db, req.authUser!.sub, req.query.limit, req.query.cursor)
    );

    app.get(
        "/report-groups/:id",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "Get one account-owned report group",
                params: recordParamsSchema,
                response: { 200: groupResponseSchema.extend({ reportIds: z.array(z.string()) }) },
            },
        },
        async (req) => getGroup(app.db, req.authUser!.sub, req.params.id)
    );

    app.patch(
        "/report-groups/:id",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            bodyLimit: 32 * 1024,
            schema: {
                summary: "Update a report group with optimistic concurrency",
                params: recordParamsSchema,
                body: groupUpdateBodySchema,
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) =>
            applySyncMutations(app.db, req.authUser!.sub, [
                { ...req.body, type: "group.update", id: req.params.id },
            ])
    );

    app.delete(
        "/report-groups/:id",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "Soft-delete a report group and its relationships",
                params: recordParamsSchema,
                body: deleteBodySchema,
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) =>
            applySyncMutations(app.db, req.authUser!.sub, [
                { ...req.body, type: "group.delete", id: req.params.id },
            ])
    );

    app.put(
        "/report-groups/:id/reports",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "Add an owned report to an owned group",
                params: recordParamsSchema,
                body: relationshipPutBodySchema,
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) =>
            applySyncMutations(app.db, req.authUser!.sub, [
                {
                    type: "relationship.put",
                    groupId: req.params.id,
                    reportId: req.body.reportId,
                    mutationId: req.body.mutationId,
                    expectedVersion: req.body.expectedVersion,
                },
            ])
    );

    app.delete(
        "/report-groups/:id/reports/:reportId",
        {
            preHandler: app.authenticate,
            config: privateRateLimit,
            schema: {
                summary: "Remove an owned report from an owned group",
                params: relationshipParamsSchema,
                body: relationshipDeleteBodySchema.omit({ reportId: true }),
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) =>
            applySyncMutations(app.db, req.authUser!.sub, [
                {
                    type: "relationship.delete",
                    groupId: req.params.id,
                    reportId: req.params.reportId,
                    mutationId: req.body.mutationId,
                    expectedVersion: req.body.expectedVersion,
                },
            ])
    );

    app.post(
        "/report-sync/mutations",
        {
            preHandler: app.authenticate,
            bodyLimit: 2 * 1024 * 1024,
            config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
            schema: {
                summary: "Atomically upload an idempotent batch of offline changes",
                body: syncPushBodySchema,
                response: { 200: syncPushResponseSchema },
            },
        },
        async (req) => applySyncMutations(app.db, req.authUser!.sub, req.body.mutations)
    );

    app.get(
        "/report-sync/changes",
        {
            preHandler: app.authenticate,
            config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
            schema: {
                summary: "Download reports, groups, relationship changes, and tombstones",
                querystring: syncPullQuerySchema,
                response: { 200: syncPullResponseSchema },
            },
        },
        async (req) => pullSyncChanges(app.db, req.authUser!.sub, req.query.cursor, req.query.limit)
    );
};
