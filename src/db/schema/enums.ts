import { pgEnum } from "drizzle-orm/pg-core";

/* ---------------- User lifecycle ---------------- */

export const userStatusEnum = pgEnum("user_status", [
    "pending",
    "active",
    "disabled",
]);


/* ---------------- User roles ---------------- */

export const userRoleEnum = pgEnum("user_role", [
    "user",
    "admin",
]);
