import { and, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { ConflictError, NotFoundError } from "@core/errors/http-errors";
import { users, workspaceMembers, workspaces } from "@db/schema";
import {
    AUDIT_ACTIONS,
    AUDIT_TARGETS,
    recordAuditEvent,
    type AuditActor,
    type AuditExecutor,
} from "@modules/audit/audit.service";

export type DeactivateLockedUser = {
    id: string;
    name: string;
    email: string;
    role: "user" | "admin";
    status: "pending" | "active" | "disabled";
};

export type RevokedMembershipAudit = {
    memberId: string;
    workspaceId: string;
    workspaceName: string | null;
    role: string;
    previousStatus: string;
};

export type DeactivateUserResult = {
    id: string;
    name: string;
    email: string;
    role: "user" | "admin";
    status: "disabled";
    alreadyDisabled: boolean;
    revokedMemberships: RevokedMembershipAudit[];
};

export type DeactivateUserStore = {
    lockUser(id: string): Promise<DeactivateLockedUser | null>;
    countActiveAdmins(): Promise<number>;
    findSoleOwnedActiveWorkspaces(user: { id: string; email: string }): Promise<Array<{ id: string; name: string }>>;
    listRevocableMemberships(user: { id: string; email: string }): Promise<RevokedMembershipAudit[]>;
    writeAudit(input: Parameters<typeof recordAuditEvent>[2]): Promise<void>;
    setUserDisabled(id: string, now: Date): Promise<void>;
    revokeUserMemberships(user: { id: string; email: string }, now: Date): Promise<void>;
};

export type DeactivateUserInput = {
    actorUserId: string;
    actor: AuditActor | null;
    targetUserId: string;
};

/**
 * Soft-deactivates a user account.
 *
 * Never deletes the user row, workspaces, other members, billing, or audit
 * history. Memberships for THIS user are revoked (status = revoked) so seats
 * return to their workspaces.
 */
export async function deactivateUser(store: DeactivateUserStore, input: DeactivateUserInput): Promise<DeactivateUserResult> {
    const target = await store.lockUser(input.targetUserId);
    if (!target) {
        throw new NotFoundError("User not found");
    }

    if (target.status === "disabled") {
        return {
            id: target.id,
            name: target.name,
            email: target.email,
            role: target.role,
            status: "disabled",
            alreadyDisabled: true,
            revokedMemberships: [],
        };
    }

    if (target.id === input.actorUserId) {
        throw new ConflictError("You cannot deactivate your own account.");
    }

    if (target.role === "admin") {
        const activeAdmins = await store.countActiveAdmins();
        if (activeAdmins <= 1) {
            throw new ConflictError("Cannot deactivate the last remaining active platform admin.");
        }
    }

    const soleOwned = await store.findSoleOwnedActiveWorkspaces(target);
    if (soleOwned.length > 0) {
        const names = soleOwned.map((workspace) => workspace.name).join(", ");
        throw new ConflictError(
            `Cannot deactivate this user because they are the sole owner of an active workspace (${names}). Transfer ownership or revoke the workspace first.`,
            { workspaces: soleOwned }
        );
    }

    const revokedMemberships = await store.listRevocableMemberships(target);

    await store.writeAudit({
        action: AUDIT_ACTIONS.USER_DEACTIVATED,
        actor: input.actor,
        target: { type: AUDIT_TARGETS.USER, id: target.id, label: target.email },
        metadata: {
            name: target.name,
            email: target.email,
            role: target.role,
            previousStatus: target.status,
            revokedMemberships,
        },
        throwOnFailure: true,
    });

    const now = new Date();
    await store.setUserDisabled(target.id, now);
    await store.revokeUserMemberships(target, now);

    return {
        id: target.id,
        name: target.name,
        email: target.email,
        role: target.role,
        status: "disabled",
        alreadyDisabled: false,
        revokedMemberships,
    };
}

function ownerIdentityKey(userId: string | null | undefined, email: string | null | undefined): string | null {
    if (userId) return `id:${userId}`;
    if (email && email.trim()) return `email:${email.trim().toLowerCase()}`;
    return null;
}

export function isSoleOwnerOfActiveWorkspace(input: {
    userId: string;
    email: string;
    workspace: { ownerUserId: string | null; ownerEmail: string };
    ownerMembers: Array<{ userId: string | null; email: string }>;
}): boolean {
    const email = input.email.trim().toLowerCase();
    const targetKeys = new Set([`id:${input.userId}`, `email:${email}`]);

    const ownerKeys = new Set<string>();
    const listed = ownerIdentityKey(input.workspace.ownerUserId, input.workspace.ownerEmail);
    if (listed) ownerKeys.add(listed);
    for (const member of input.ownerMembers) {
        const key = ownerIdentityKey(member.userId, member.email);
        if (key) ownerKeys.add(key);
    }

    const userIsOwner = [...ownerKeys].some((key) => targetKeys.has(key));
    if (!userIsOwner) return false;

    const remaining = [...ownerKeys].filter((key) => !targetKeys.has(key));
    return remaining.length === 0;
}

type DeactivateDb = Pick<FastifyInstance["db"], "select" | "update"> & AuditExecutor;

export function createDrizzleDeactivateStore(tx: DeactivateDb, log: FastifyBaseLogger): DeactivateUserStore {
    return {
        async lockUser(id) {
            const [row] = await tx.select().from(users).where(eq(users.id, id)).for("update").limit(1);
            if (!row) return null;
            return {
                id: row.id,
                name: row.name,
                email: row.email,
                role: row.role,
                status: row.status,
            };
        },

        async countActiveAdmins() {
            const [row] = await tx
                .select({ count: sql<number>`count(*)` })
                .from(users)
                .where(and(eq(users.role, "admin"), eq(users.status, "active")));
            return Number(row?.count ?? 0);
        },

        async findSoleOwnedActiveWorkspaces(user) {
            const email = user.email.trim().toLowerCase();
            const activeWorkspaces = await tx
                .select({
                    id: workspaces.id,
                    name: workspaces.name,
                    ownerUserId: workspaces.ownerUserId,
                    ownerEmail: workspaces.ownerEmail,
                })
                .from(workspaces)
                .where(eq(workspaces.status, "active"));

            if (activeWorkspaces.length === 0) return [];

            const ownerMembers = await tx
                .select({
                    workspaceId: workspaceMembers.workspaceId,
                    userId: workspaceMembers.userId,
                    email: workspaceMembers.email,
                })
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.role, "owner"), ne(workspaceMembers.status, "revoked")));

            return activeWorkspaces.filter((workspace) =>
                isSoleOwnerOfActiveWorkspace({
                    userId: user.id,
                    email,
                    workspace,
                    ownerMembers: ownerMembers
                        .filter((member) => member.workspaceId === workspace.id)
                        .map((member) => ({ userId: member.userId, email: member.email })),
                })
            );
        },

        async listRevocableMemberships(user) {
            const email = user.email.trim().toLowerCase();
            const rows = await tx
                .select({
                    memberId: workspaceMembers.id,
                    workspaceId: workspaceMembers.workspaceId,
                    workspaceName: workspaces.name,
                    role: workspaceMembers.role,
                    previousStatus: workspaceMembers.status,
                })
                .from(workspaceMembers)
                .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
                .where(
                    and(
                        ne(workspaceMembers.status, "revoked"),
                        or(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.email, email))
                    )
                );

            return rows;
        },

        async writeAudit(input) {
            await recordAuditEvent(tx, log, input);
        },

        async setUserDisabled(id, now) {
            await tx.update(users).set({ status: "disabled", updatedAt: now }).where(eq(users.id, id));
        },

        async revokeUserMemberships(user, now) {
            const email = user.email.trim().toLowerCase();
            await tx
                .update(workspaceMembers)
                .set({
                    status: "revoked",
                    revokedAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        ne(workspaceMembers.status, "revoked"),
                        or(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.email, email))
                    )
                );
        },
    };
}
