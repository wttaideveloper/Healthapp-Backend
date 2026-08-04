import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
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

/** Swagger UI is developer tooling: off in production unless explicitly forced on. */
const isSwaggerEnabled =
    env.ENABLE_SWAGGER === "true" ||
    (env.ENABLE_SWAGGER !== "false" && env.NODE_ENV !== "production");

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: {
            level: env.LOG_LEVEL,
            transport:
                env.NODE_ENV === "development"
                    ? { target: "pino-pretty" }
                    : undefined,
        },
        // The app listens on 127.0.0.1 behind nginx, which sets X-Forwarded-For.
        // Without this every request would appear to come from 127.0.0.1 and the
        // rate limiter would throttle all clients as a single bucket.
        trustProxy: env.TRUST_PROXY === "true",
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

    /* ---------------- SECURITY HEADERS ---------------- */
    await app.register(fastifyHelmet, {
        // The public /privacy and /terms pages ship an inline <style> block, so
        // inline styles must be allowed. No inline scripts exist anywhere.
        // CSP is disabled when Swagger UI is served because swagger-ui requires
        // inline scripts; Swagger is developer-only and off in production.
        contentSecurityPolicy: isSwaggerEnabled
            ? false
            : {
                  directives: {
                      defaultSrc: ["'self'"],
                      baseUri: ["'self'"],
                      scriptSrc: ["'self'"],
                      styleSrc: ["'self'", "'unsafe-inline'"],
                      imgSrc: ["'self'", "data:"],
                      fontSrc: ["'self'", "data:"],
                      connectSrc: ["'self'"],
                      objectSrc: ["'none'"],
                      frameAncestors: ["'none'"],
                      formAction: ["'self'"],
                      // Left off deliberately: deployments may still serve plain
                      // HTTP until certbot has run.
                      upgradeInsecureRequests: null,
                  },
              },
        // JSON API consumed cross-origin by the Expo web build. CORP/COEP would
        // add no protection here and risk breaking those reads.
        crossOriginResourcePolicy: false,
        crossOriginEmbedderPolicy: false,
    });

    /* ---------------- CORS ---------------- */
    await app.register(fastifyCors, {
        origin: true, // reflect request origin (good for localhost ports during dev)
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-bootstrap-token"],
        optionsSuccessStatus: 204,
    });

    /* ---------------- RATE LIMIT ---------------- */
    // Global ceiling. Individual auth/bootstrap routes tighten this via their
    // own `config.rateLimit`.
    await app.register(fastifyRateLimit, {
        global: true,
        max: env.RATE_LIMIT_GLOBAL_MAX,
        timeWindow: "1 minute",
        // Provider webhooks are authenticated by HMAC signature and arrive in
        // legitimate bursts; health checks are polled by Docker and the load
        // balancer. Throttling either causes outages, not protection.
        allowList: (req) => {
            const path = req.url.split("?")[0];
            return (
                path === "/api/v1/stripe/webhook" ||
                path === "/api/v1/shopify/webhook" ||
                path.startsWith("/api/v1/health")
            );
        },
    });

    /* ---------------- SWAGGER (non-production only) ---------------- */
    if (isSwaggerEnabled) {
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
    }

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
