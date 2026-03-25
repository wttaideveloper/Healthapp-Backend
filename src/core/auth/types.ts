export const UserRoleValues = ["user", "admin"] as const;

export type UserRole = (typeof UserRoleValues)[number];

export interface AuthUser {
    sub: string;
    role: UserRole;
    email: string;
}
