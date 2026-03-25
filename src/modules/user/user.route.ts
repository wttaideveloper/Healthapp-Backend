import { eq } from "drizzle-orm";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { users } from "@db/schema";
import { getUserSchema } from "./user.schema";
import { ForbiddenError, NotFoundError } from "@core/errors/http-errors";

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        "/:id",
        {
            preHandler: app.authenticate,
            schema: getUserSchema,
        },
        async (req) => {
            const [user] = await app.db.select().from(users).where(eq(users.id, req.params.id)).limit(1);

            if (!user) {
                throw new NotFoundError("User not found");
            }

            if (req.authUser!.role !== "admin" && req.authUser!.sub !== user.id) {
                throw new ForbiddenError("You can only access your own user record");
            }

            return {
                id: user.id,
                name: user.name,
                email: user.email,
                isEmailVerified: user.isEmailVerified,
                role: user.role,
                isLicensed: user.isLicensed,
            };
        }
    );
};
