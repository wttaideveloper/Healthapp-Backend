import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyCors from "@fastify/cors";
import fastifyRawBody from "fastify-raw-body";
import Fastify, { FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { env } from "@config/env";
import { errorHandlerPlugin } from "@plugins/error-handler.plugin";
import { dbLivePlugin } from "@plugins/db-live.plugin";
import { dbPlugin } from "@plugins/db.plugin";
import { authPlugin } from "@plugins/auth.plugin";
import { healthRoutes } from "./modules/health/health.route";
import { authRoutes } from "./modules/auth/auth.route";
import { entitlementRoutes } from "./modules/entitlement/entitlement.route";
import { stripeRoutes } from "./modules/stripe/stripe.route";
import { adminUserRoutes } from "./modules/admin/admin-user.route";
import { adminWorkspaceRoutes } from "./modules/admin/admin-workspace.route";
import { workspaceRoutes } from "./modules/workspace/workspace.route";
import { legalRoutes } from "./modules/legal/legal.route";
import { shopifyRoutes } from "./modules/shopify/shopify.route";

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: {
            level: env.LOG_LEVEL,
            transport:
                env.NODE_ENV === "development"
                    ? { target: "pino-pretty" }
                    : undefined,
        },
    });

    /* ---------------- ZOD SETUP ---------------- */
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(fastifyRawBody, {
        field: "rawBody",
        global: false,
        runFirst: true,
        encoding: false,
    });

    /* ---------------- CORS ---------------- */
    await app.register(fastifyCors, {
        origin: true, // reflect request origin (good for localhost ports during dev)
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-bootstrap-token"],
        optionsSuccessStatus: 204,
    });

    /* ---------------- SWAGGER ---------------- */
    await app.register(fastifySwagger, {
        openapi: {
            info: {
                title: "HealthAge API",
                version: "1.0.0",
            },
        },
    });

    await app.register(fastifySwaggerUi, {
        routePrefix: "/docs",
    });

    /* ---------------- PLUGINS (ORDER MATTERS) ---------------- */
    await app.register(dbPlugin);            // app.db + app.pgPool
    await app.register(dbLivePlugin);        // app.isDbLive
    await app.register(authPlugin);
    await app.register(errorHandlerPlugin);   // custom error handler

    /* ---------------- PUBLIC LEGAL PAGES ---------------- */
    await app.register(legalRoutes);

    /* ---------------- ROUTES (TYPED) ---------------- */

    const typedApp = app.withTypeProvider<ZodTypeProvider>();
    typedApp.register(healthRoutes, { prefix: '/api/v1/health' });
    typedApp.register(authRoutes, { prefix: "/api/v1/auth" });
    typedApp.register(entitlementRoutes, { prefix: "/api/v1/entitlements" });
    typedApp.register(workspaceRoutes, { prefix: "/api/v1/workspaces" });
    typedApp.register(stripeRoutes, { prefix: "/api/v1/stripe" });
    typedApp.register(shopifyRoutes, { prefix: "/api/v1/shopify" });
    typedApp.register(adminUserRoutes, { prefix: "/api/v1/admin" });
    typedApp.register(adminWorkspaceRoutes, { prefix: "/api/v1/admin" });

    return app;
}
