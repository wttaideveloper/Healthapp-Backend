import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z from 'zod';

const healthResponseSchema = z.object({
    status: z.string(),
    timestamp: z.string(),
    upTime: z.number()
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        '/',
        {
            schema: {
                summary: 'Health Check',
                response: {
                    200: healthResponseSchema,
                },
            },
        },
        async () => {
            return {
                status: 'ok',
                timestamp: new Date().toISOString(),
                upTime: process.uptime(),
            };
        }
    );

    app.get("/ready", {
        schema: {
            summary: "Readiness Check",
            response: {
                200: z.object({
                    status: z.enum(["ready", "not_ready"]),
                    db: z.enum(["up", "down"]),
                }),
            },
        },
    },
        async () => {
            if (!app.isDbLive) {
                return {
                    status: "not_ready" as const,
                    db: "down" as const,
                };
            }

            return {
                status: "ready" as const,
                db: "up" as const,
            };
        });

};