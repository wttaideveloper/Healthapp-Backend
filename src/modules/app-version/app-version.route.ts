import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { appVersionParamsSchema, appVersionResponseSchema } from "./app-version.schema";
import { readAppVersionSettings, resolveAppVersionPolicies, type AppVersionPolicies } from "./app-version.service";

/**
 * Per IP. Clients ask at launch and when brought back to the foreground, so this leaves plenty of
 * headroom for many devices behind one shared network address.
 */
const appVersionRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/**
 * The answer is the same for everyone (no account, no credentials), so shared caches may keep it.
 * Short, so a changed configuration reaches clients within minutes of the server restarting.
 */
export const APP_VERSION_CACHE_CONTROL = "public, max-age=300";

export type AppVersionRouteOptions = {
    /** Tests pass their own configuration; the server reads it from the environment. */
    policies?: AppVersionPolicies;
};

/**
 * Public and unauthenticated on purpose: an app must be able to ask before anyone signs in, and the
 * answer never depends on an account. It only reports the configuration; whether to prompt for an
 * update or to block an unsupported version is decided by each client.
 */
export const appVersionRoutes: FastifyPluginAsyncZod<AppVersionRouteOptions> = async (app, options) => {
    // Resolved once at start-up, so an inconsistent configuration stops the server from starting.
    const policies = options.policies ?? resolveAppVersionPolicies(readAppVersionSettings());

    app.get(
        "/:platform",
        {
            config: appVersionRateLimit,
            schema: {
                summary: "Latest and minimum supported app version for a platform",
                params: appVersionParamsSchema,
                response: {
                    200: appVersionResponseSchema,
                },
            },
        },
        async (req, reply) => {
            reply.header("Cache-Control", APP_VERSION_CACHE_CONTROL);
            return policies[req.params.platform];
        }
    );
};
