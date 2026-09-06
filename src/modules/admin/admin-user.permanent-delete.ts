import { and, eq, or } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { BadRequestError, ConflictError, NotFoundError } from "@core/errors/http-errors";
import {
    emailVerifications,
    passwordResets,
    revenuecatSubscriptions,
    storeEntitlements,
    stripeCustomers,
    stripeSubscriptions,
    users,
    workspaceMembers,
    workspaces,
} from "@db/schema";
import {
    AUDIT_ACTIONS,
    AUDIT_TARGETS,
    recordAuditEvent,
    type AuditActor,
    type AuditExecutor,
} from "@modules/audit/audit.service";
import { normalizeEmail } from "@modules/workspace/workspace.util";

export type LockedUserForPermanentDelete = {
    id: string;
    name: string;
    email: string;
    role: "user" | "admin";
    status: "pending" | "active" | "disabled";
};

export type NamedWorkspace = {
    id: string;
    name: string;
    billingSource: string;
    status: string;
    shopifyShopId?: string | null;
};

function isShopifyLinkedWorkspace(workspace: NamedWorkspace): boolean {
    if (workspace.billingSource.trim().toLowerCase() === "shopify") return true;
    return Boolean(workspace.shopifyShopId);
}

export type StripeSubscriptionSnapshot = {
    status: string;
    currentPeriodEnd: Date | null;
};

export type RevenuecatSnapshot = {
    isActive: boolean;
    expiresAt: Date | null;
};

export type StoreEntitlementSnapshot = {
    isActive: boolean;
    expiresAt: Date | null;
    status: string;
};

export type PermanentlyDeleteUserResult = {
    id: string;
    email: string;
    name: string;
};

export type PermanentlyDeleteUserStore = {
    lockUser(id: string): Promise<LockedUserForPermanentDelete | null>;
    listOwnedWorkspaces(user: { id: string; email: string }): Promise<NamedWorkspace[]>;
    listOwnerMemberships(user: { id: string; email: string }): Promise<NamedWorkspace[]>;
    listMemberships(user: { id: string; email: string }): Promise<Array<{ id: string; workspaceId: string; role: string }>>;
    listStripeCustomers(userId: string): Promise<Array<{ id: string }>>;
    listStripeSubscriptions(userId: string): Promise<StripeSubscriptionSnapshot[]>;
    listRevenuecatSubscriptions(userId: string): Promise<RevenuecatSnapshot[]>;
    listStoreEntitlements(userId: string): Promise<StoreEntitlementSnapshot[]>;
    writeAudit(input: Parameters<typeof recordAuditEvent>[2]): Promise<void>;
    deleteEmailVerifications(userId: string): Promise<number>;
    deletePasswordResets(userId: string): Promise<number>;
    deleteUser(id: string): Promise<void>;
};

export type PermanentlyDeleteUserInput = {
    actorUserId: string;
    actor: AuditActor | null;
    targetUserId: string;
    confirmation: string;
};

export function isStripeSubscriptionActive(status: string, expiresAt: Date | null, now = new Date()): boolean {
    const activeStatuses = new Set(["active", "trialing"]);
    if (!activeStatuses.has(status)) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > now.getTime();
}

export function isStoreEntitlementActive(isActive: boolean, expiresAt: Date | null, now = new Date()): boolean {
    if (!isActive) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > now.getTime();
}

export function isRevenuecatSubscriptionActive(isActive: boolean, expiresAt: Date | null, now = new Date()): boolean {
    if (!isActive) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > now.getTime();
}

/**
 * Permanently deletes a dummy/test user who has no remaining business relationships.
 *
 * Does not deactivate first, does not revoke memberships, and does not cancel
 * billing. Soft deactivate remains PATCH status=disabled.
 */
export async function permanentlyDeleteUser(
    store: PermanentlyDeleteUserStore,
    input: PermanentlyDeleteUserInput
): Promise<PermanentlyDeleteUserResult> {
    const target = await store.lockUser(input.targetUserId);
    if (!target) {
        throw new NotFoundError("User not found");
    }

    const expected = normalizeEmail(target.email);
    if (!normalizeEmail(input.confirmation) || normalizeEmail(input.confirmation) !== expected) {
        throw new BadRequestError("Confirmation does not match the user email.");
    }

    if (target.id === input.actorUserId) {
        throw new ConflictError("You cannot permanently delete your own account.");
    }

    if (target.role === "admin") {
        throw new ConflictError("Platform administrator accounts cannot be permanently deleted.");
    }

    if (target.status !== "disabled") {
        throw new ConflictError("Deactivate the user before permanently deleting the account.");
    }

    const ownedWorkspaces = await store.listOwnedWorkspaces(target);
    const shopifyOwned = ownedWorkspaces.filter(isShopifyLinkedWorkspace);
    if (shopifyOwned.length > 0) {
        throw new ConflictError(
            "Permanent deletion is blocked because this account has a Shopify business relationship."
        );
    }
    if (ownedWorkspaces.length > 0) {
        const names = ownedWorkspaces.map((workspace) => workspace.name).join(", ");
        throw new ConflictError(`This user still owns a workspace (${names}).`);
    }

    const ownerMemberships = await store.listOwnerMemberships(target);
    if (ownerMemberships.length > 0) {
        const names = ownerMemberships.map((workspace) => workspace.name).join(", ");
        throw new ConflictError(`This user still owns a workspace (${names}).`);
    }

    const memberships = await store.listMemberships(target);
    if (memberships.length > 0) {
        throw new ConflictError(
            "This user still belongs to one or more workspaces. Remove the memberships before permanently deleting the user."
        );
    }

    const stripeSubscriptions = await store.listStripeSubscriptions(target.id);
    if (stripeSubscriptions.some((row) => isStripeSubscriptionActive(row.status, row.currentPeriodEnd))) {
        throw new ConflictError("This user has an active Stripe subscription.");
    }

    const stripeCustomers = await store.listStripeCustomers(target.id);
    if (stripeCustomers.length > 0 || stripeSubscriptions.length > 0) {
        throw new ConflictError(
            "Permanent deletion is blocked because this account has an unsafe billing relationship."
        );
    }

    const revenuecat = await store.listRevenuecatSubscriptions(target.id);
    if (revenuecat.some((row) => isRevenuecatSubscriptionActive(row.isActive, row.expiresAt))) {
        throw new ConflictError("This user has an active RevenueCat subscription.");
    }
    if (revenuecat.length > 0) {
        throw new ConflictError(
            "Permanent deletion is blocked because this account has an unsafe billing relationship."
        );
    }

    const entitlements = await store.listStoreEntitlements(target.id);
    if (entitlements.some((row) => isStoreEntitlementActive(row.isActive, row.expiresAt))) {
        throw new ConflictError("This user has an active IAP entitlement.");
    }

    await store.writeAudit({
        action: AUDIT_ACTIONS.USER_PERMANENTLY_DELETED,
        actor: input.actor,
        target: { type: AUDIT_TARGETS.USER, id: target.id, label: target.email },
        metadata: {
            deletionType: "permanent",
            actorId: input.actor?.id ?? input.actorUserId,
            actorEmail: input.actor?.email ?? null,
            actorRole: input.actor?.role ?? null,
            targetUserId: target.id,
            name: target.name,
            email: target.email,
            role: target.role,
            status: target.status,
            confirmation: expected,
            ownedWorkspaceCount: 0,
            membershipCount: 0,
            stripeCustomerCount: stripeCustomers.length,
            stripeSubscriptionCount: stripeSubscriptions.length,
            revenuecatCount: revenuecat.length,
            activeStoreEntitlementCount: entitlements.filter((row) =>
                isStoreEntitlementActive(row.isActive, row.expiresAt)
            ).length,
        },
        throwOnFailure: true,
    });

    await store.deleteEmailVerifications(target.id);
    await store.deletePasswordResets(target.id);
    await store.deleteUser(target.id);

    return {
        id: target.id,
        email: target.email,
        name: target.name,
    };
}

function userMembershipFilter(user: { id: string; email: string }) {
    const email = normalizeEmail(user.email);
    return or(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.email, email));
}

type PermanentDeleteUserDb = Pick<FastifyInstance["db"], "select" | "delete"> & AuditExecutor;

export function createDrizzlePermanentDeleteUserStore(
    tx: PermanentDeleteUserDb,
    log: FastifyBaseLogger
): PermanentlyDeleteUserStore {
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

        async listOwnedWorkspaces(user) {
            const email = normalizeEmail(user.email);
            return tx
                .select({
                    id: workspaces.id,
                    name: workspaces.name,
                    billingSource: workspaces.billingSource,
                    status: workspaces.status,
                    shopifyShopId: workspaces.shopifyShopId,
                })
                .from(workspaces)
                .where(or(eq(workspaces.ownerUserId, user.id), eq(workspaces.ownerEmail, email)));
        },

        async listOwnerMemberships(user) {
            const email = normalizeEmail(user.email);
            return tx
                .select({
                    id: workspaces.id,
                    name: workspaces.name,
                    billingSource: workspaces.billingSource,
                    status: workspaces.status,
                    shopifyShopId: workspaces.shopifyShopId,
                })
                .from(workspaceMembers)
                .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
                .where(and(eq(workspaceMembers.role, "owner"), userMembershipFilter({ id: user.id, email })));
        },

        async listMemberships(user) {
            const email = normalizeEmail(user.email);
            return tx
                .select({
                    id: workspaceMembers.id,
                    workspaceId: workspaceMembers.workspaceId,
                    role: workspaceMembers.role,
                })
                .from(workspaceMembers)
                .where(userMembershipFilter({ id: user.id, email }));
        },

        async listStripeCustomers(userId) {
            return tx.select({ id: stripeCustomers.id }).from(stripeCustomers).where(eq(stripeCustomers.userId, userId));
        },

        async listStripeSubscriptions(userId) {
            return tx
                .select({
                    status: stripeSubscriptions.status,
                    currentPeriodEnd: stripeSubscriptions.currentPeriodEnd,
                })
                .from(stripeSubscriptions)
                .where(eq(stripeSubscriptions.userId, userId));
        },

        async listRevenuecatSubscriptions(userId) {
            return tx
                .select({
                    isActive: revenuecatSubscriptions.isActive,
                    expiresAt: revenuecatSubscriptions.expiresAt,
                })
                .from(revenuecatSubscriptions)
                .where(eq(revenuecatSubscriptions.userId, userId));
        },

        async listStoreEntitlements(userId) {
            return tx
                .select({
                    isActive: storeEntitlements.isActive,
                    expiresAt: storeEntitlements.expiresAt,
                    status: storeEntitlements.status,
                })
                .from(storeEntitlements)
                .where(eq(storeEntitlements.ownerUserId, userId));
        },

        async writeAudit(input) {
            await recordAuditEvent(tx, log, input);
        },

        async deleteEmailVerifications(userId) {
            const deleted = await tx
                .delete(emailVerifications)
                .where(eq(emailVerifications.userId, userId))
                .returning({ id: emailVerifications.id });
            return deleted.length;
        },

        async deletePasswordResets(userId) {
            const deleted = await tx
                .delete(passwordResets)
                .where(eq(passwordResets.userId, userId))
                .returning({ id: passwordResets.id });
            return deleted.length;
        },

        async deleteUser(id) {
            await tx.delete(users).where(eq(users.id, id));
        },
    };
}
