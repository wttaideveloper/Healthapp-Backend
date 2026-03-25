import "fastify";
import type { Pool } from "pg";

import type { DB } from "@db/index";
import type { AuthUser, UserRole } from "@core/auth/types";

declare module "@fastify/jwt" {
    interface FastifyJWT {
        payload: AuthUser;
        user: AuthUser;
    }
}

declare module "fastify" {
    interface FastifyInstance {
        db: DB;
        pgPool: Pool;
        isDbLive: boolean;
        authenticate: (req: FastifyRequest) => Promise<void>;
        authorize: (roles: UserRole[]) => (req: FastifyRequest) => Promise<void>;
    }

    interface FastifyRequest {
        authUser: AuthUser | null;
        tx?: DB;
    }
}
