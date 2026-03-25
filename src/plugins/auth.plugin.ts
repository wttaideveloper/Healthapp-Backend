import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { env } from "@config/env";
import type { AuthUser, UserRole } from "@core/auth/types";
import { ForbiddenError, UnauthorizedError } from "@core/errors/http-errors";

async function authPluginCore(app: FastifyInstance) {
    await app.register(fastifyJwt, {
        secret: env.JWT_SECRET,
    });

    app.decorateRequest("authUser", null);

    app.decorate("authenticate", async function authenticate(req: FastifyRequest) {
        try {
            await req.jwtVerify<AuthUser>();
            req.authUser = req.user;
        } catch {
            throw new UnauthorizedError("Invalid or missing access token");
        }
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
