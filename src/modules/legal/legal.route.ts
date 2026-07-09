import type { FastifyPluginAsync } from "fastify";

import { privacyPageHtml, termsPageHtml } from "./legal.templates";

export const legalRoutes: FastifyPluginAsync = async (app) => {
    app.get(
        "/privacy",
        {
            schema: { hide: true },
        },
        async (_request, reply) => {
            return reply.type("text/html").send(privacyPageHtml);
        }
    );

    app.get(
        "/terms",
        {
            schema: { hide: true },
        },
        async (_request, reply) => {
            return reply.type("text/html").send(termsPageHtml);
        }
    );
};
