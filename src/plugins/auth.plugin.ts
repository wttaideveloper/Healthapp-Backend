import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { env } from "@config/env";
import type { AuthUser, UserRole } from "@core/auth/types";
import { ForbiddenError, UnauthorizedError } from "@core/errors/http-errors";

async function authPluginCore(app: FastifyInstance) {
    await app.register(fastifyJwt, {
        secret: env.JWT_SECRET,
        // Newly issued tokens carry an `exp` claim. Tokens issued before this
        // change have no `exp` and remain valid until JWT_SECRET is rotated.
        sign: {
            expiresIn: env.JWT_EXPIRES_IN,
        },
    });

    app.decorateRequest("authUser", null);

    app.decorate("authenticate", async function authenticate(req: FastifyRequest) {
        let payload: AuthUser;

        try {
            payload = await req.jwtVerify<AuthUser>();
        } catch (error) {
            // Same 401 + UNAUTHORIZED code as before; only the message differs so
            // clients can tell an expired session from a malformed token.
            const code = (error as { code?: string } | null)?.code;
            if (code === "FAST_JWT_EXPIRED" || code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED") {
                throw new UnauthorizedError("Access token has expired");
            }
            throw new UnauthorizedError("Invalid or missing access token");
        }

        // Defensive: reject structurally valid tokens that lack the claims every
        // downstream authorization check depends on.
        if (!payload || typeof payload.sub !== "string" || typeof payload.role !== "string") {
            throw new UnauthorizedError("Invalid or missing access token");
        }

        req.authUser = payload;
    });

    app.decorate("authorize", function authorize(roles: UserRole[]) {
        return async function authorizationGuard(req: FastifyRequest) {
            await app.authenticate(req);

            if (!req.authUser || !roles.includes(req.authUser.role)) {
                throw new ForbiddenError("Insufficient permissions");
            }
        };
    });
}

export const authPlugin = fp(authPluginCore, {
    name: "auth-plugin",
});
