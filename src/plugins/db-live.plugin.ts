import { FastifyInstance } from "fastify";

export async function dbLivePlugin(app: FastifyInstance) {
    app.addHook("preHandler", async (req, reply) => {
        // Allow health routes always
        if (req.url.startsWith("/health") || req.url.startsWith("/api/v1/health")) return;

        if (!app.isDbLive) {
            return reply.status(503).send({
                error: {
                    code: "SERVICE_UNAVAILABLE",
                    message: "Database is unavailable",
                },
            });
        }
    });
}
