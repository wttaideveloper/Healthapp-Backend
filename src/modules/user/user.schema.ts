import { z } from "zod";
import { UserId, UserRoleValues } from "./user.domain";

const roleEnum = z.enum(UserRoleValues).default("user");

const UserIdSchema = z.string().uuid().transform((val) => val as UserId);

export const getUserSchema = {
    params: z.object({
        id: UserIdSchema,
    }),
    response: {
        200: z.object({
            id: UserIdSchema,
            name: z.string(),
            email: z.email(),
            isEmailVerified: z.boolean(),
            role: roleEnum,
            isLicensed: z.boolean(),
        }),
    },
};
