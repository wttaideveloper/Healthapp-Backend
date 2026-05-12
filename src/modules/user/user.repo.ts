import { eq } from "drizzle-orm";

import {
    UserId,
    UserStatus,
    UserRole,
} from "./user.domain";

import { SelectUser, users } from "../../db/schema/users";
import { DB } from "../../db";

export function createUserRepository({ db }: { db: DB }) {
    return {
        async findById(id: UserId): Promise<SelectUser | null> {
            const [row] = await db
                .select()
                .from(users)
                .where(eq(users.id, id));

            return row ?? null;
        },

        async findByEmail(email: string): Promise<SelectUser | null> {
            const [row] = await db
                .select()
                .from(users)
                .where(eq(users.email, email));

            return row ?? null;
        },

        async create(data: typeof users.$inferInsert): Promise<SelectUser> {
            const [row] = await db
                .insert(users)
                .values(data)
                .returning();

            return row;
        },

        async setPassword(id: UserId, passwordHash: string): Promise<void> {
            await db
                .update(users)
                .set({ passwordHash })
                .where(eq(users.id, id));
        },

        async updateStatus(id: UserId, status: UserStatus): Promise<void> {
            await db
                .update(users)
                .set({ status })
                .where(eq(users.id, id));
        },

        async setRole(id: UserId, role: UserRole): Promise<void> {
            await db
                .update(users)
                .set({ role })
                .where(eq(users.id, id));
        },

        async markEmailVerified(id: UserId): Promise<void> {
            await db
                .update(users)
                .set({
                    isEmailVerified: true,
                    status: "active",
                })
                .where(eq(users.id, id));
        },

        async deleteUser(id: UserId): Promise<void> {
            await db
                .delete(users)
                .where(eq(users.id, id));
        },
    };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
