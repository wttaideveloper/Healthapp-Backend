import { and, eq, ne } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { BadRequestError, ConflictError, NotFoundError } from "@core/errors/http-errors";
import { workspaceMembers, workspaces } from "@db/schema";
import {
    AUDIT_ACTIONS,
    AUDIT_TARGETS,
    recordAuditEvent,
    type AuditActor,
    type AuditExecutor,
} from "@modules/audit/audit.service";
import { normalizeEmail } from "@modules/workspace/workspace.util";

export type LockedWorkspace = {
    id: string;
    name: string;
    ownerUserId: string | null;
    ownerEmail: string;
};

export type LockedMember = {
    id: string;
    workspaceId: string;
    userId: string | null;
    email: string;
    role: string;
    status: string;
};

export type OwnerEquivalentSeat = {
    id: string;
    userId: string | null;
    email: string;
};

export type PermanentlyDeleteMemberResult = {
    id: string;
    workspaceId: string;
    email: string;
    role: string;
    status: string;
    userId: string | null;
};

export type PermanentlyDeleteMemberStore = {
    lockWorkspace(id: string): Promise<LockedWorkspace | null>;
    lockMember(workspaceId: string, memberId: string): Promise<LockedMember | null>;
    listOwnerEquivalentSeats(workspaceId: string): Promise<OwnerEquivalentSeat[]>;
    writeAudit(input: Parameters<typeof recordAuditEvent>[2]): Promise<void>;
    deleteMember(id: string): Promise<void>;
};

export type PermanentlyDeleteMemberInput = {
    actor: AuditActor | null;
    workspaceId: string;
    memberId: string;
    confirmation: string;
};

function ownerIdentityKey(userId: string | null | undefined, email: string | null | undefined): string | null {
    if (userId) return `id:${userId}`;
    if (email && email.trim()) return `email:${email.trim().toLowerCase()}`;
    return null;
}

function memberIdentityKeys(member: { userId: string | null; email: string }): Set<string> {
    const keys = new Set<string>();
    const byId = ownerIdentityKey(member.userId, null);
    const byEmail = ownerIdentityKey(null, member.email);
    if (byId) keys.add(byId);
    if (byEmail) keys.add(byEmail);
    return keys;
}

/**
 * True when this seat is the last remaining owner identity for the workspace.
 *
 * Owner identity comes from the workspace listed owner plus non-revoked
 * owner-role members. A regular member who is not that identity is never blocked
 * by this guard — even if the workspace currently has no owner seats.
 */
export function isLastOwnerEquivalentSeat(input: {
    member: { id: string; role: string; userId: string | null; email: string };
    workspace: { ownerUserId: string | null; ownerEmail: string };
    ownerSeats: OwnerEquivalentSeat[];
}): boolean {
    const memberKeys = memberIdentityKeys(input.member);
    const listed = ownerIdentityKey(input.workspace.ownerUserId, input.workspace.ownerEmail);

    const ownerKeys = new Set<string>();
    if (listed) ownerKeys.add(listed);
    for (const seat of input.ownerSeats) {
        const key = ownerIdentityKey(seat.userId, seat.email);
        if (key) ownerKeys.add(key);
    }

    const memberIsOwner = [...ownerKeys].some((key) => memberKeys.has(key)) || input.member.role === "owner";
    if (!memberIsOwner) return false;

    const remaining = [...ownerKeys].filter((key) => !memberKeys.has(key));
    return remaining.length === 0;
}

/**
 * Permanently deletes one workspace_members row.
 *
 * Does not touch users, other members, the workspace, billing, or audit history.
 * The existing DELETE endpoint remains a soft revoke.
 */
export async function permanentlyDeleteMember(
    store: PermanentlyDeleteMemberStore,
    input: PermanentlyDeleteMemberInput
): Promise<PermanentlyDeleteMemberResult> {
    const workspace = await store.lockWorkspace(input.workspaceId);
    if (!workspace) {
        throw new NotFoundError("Workspace not found");
    }

    const member = await store.lockMember(input.workspaceId, input.memberId);
    if (!member) {
        throw new NotFoundError("Workspace member not found");
    }

    const expected = normalizeEmail(member.email);
    const provided = normalizeEmail(input.confirmation);
    if (!provided || provided !== expected) {
        throw new BadRequestError("Confirmation does not match the member email.");
    }

    if (member.role === "owner") {
        throw new ConflictError("This member is an owner. Transfer ownership before deleting.");
    }

    const ownerSeats = await store.listOwnerEquivalentSeats(workspace.id);
    if (isLastOwnerEquivalentSeat({ member, workspace, ownerSeats })) {
        throw new ConflictError("This member is the last remaining owner-equivalent seat.");
    }

    await store.writeAudit({
        action: AUDIT_ACTIONS.MEMBER_PERMANENTLY_DELETED,
        actor: input.actor,
        target: { type: AUDIT_TARGETS.MEMBER, id: member.id, label: member.email },
        workspace: { id: workspace.id, name: workspace.name },
        metadata: {
            deletionType: "permanent",
            email: member.email,
            role: member.role,
            status: member.status,
            userId: member.userId,
            confirmation: expected,
        },
        throwOnFailure: true,
    });

    await store.deleteMember(member.id);

    return {
        id: member.id,
        workspaceId: member.workspaceId,
        email: member.email,
        role: member.role,
        status: member.status,
        userId: member.userId,
    };
}

type PermanentDeleteDb = Pick<FastifyInstance["db"], "select" | "delete"> & AuditExecutor;

export function createDrizzlePermanentDeleteMemberStore(
    tx: PermanentDeleteDb,
    log: FastifyBaseLogger
): PermanentlyDeleteMemberStore {
    return {
        async lockWorkspace(id) {
            const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update").limit(1);
            if (!row) return null;
            return {
                id: row.id,
                name: row.name,
                ownerUserId: row.ownerUserId,
                ownerEmail: row.ownerEmail,
            };
        },

        async lockMember(workspaceId, memberId) {
            const [row] = await tx
                .select()
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
                .for("update")
                .limit(1);
            if (!row) return null;
            return {
                id: row.id,
                workspaceId: row.workspaceId,
                userId: row.userId,
                email: row.email,
                role: row.role,
                status: row.status,
            };
        },

        async listOwnerEquivalentSeats(workspaceId) {
            return tx
                .select({
                    id: workspaceMembers.id,
                    userId: workspaceMembers.userId,
                    email: workspaceMembers.email,
                })
                .from(workspaceMembers)
                .where(
                    and(
                        eq(workspaceMembers.workspaceId, workspaceId),
                        eq(workspaceMembers.role, "owner"),
                        ne(workspaceMembers.status, "revoked")
                    )
                );
        },

        async writeAudit(input) {
            await recordAuditEvent(tx, log, input);
        },

        async deleteMember(id) {
            await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, id));
        },
    };
}
