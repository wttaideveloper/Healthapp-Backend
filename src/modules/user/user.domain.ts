import { Brand } from "@core/types/brand";

/* ---------- Branded IDs ---------- */

export type UserId = Brand<string, "UserId">;

/* ---------- Domain Enums ---------- */
export const UserRoleValues = ["user", "admin"] as const;
export const UserStatusValues = ["pending", "active"] as const;

export type UserStatus = typeof UserStatusValues[number];
export type UserRole = typeof UserRoleValues[number];

/* ---------- Domain Entity ---------- */

export interface User {
    id: UserId;
    name: string;
    email: string;

    passwordHash: string;

    role: UserRole;

    isEmailVerified: boolean;

    status: UserStatus;

    createdAt: Date;
    updatedAt: Date;
}
