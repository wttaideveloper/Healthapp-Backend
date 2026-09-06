import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { BadRequestError, ConflictError, NotFoundError } from "@core/errors/http-errors";
import { shopifyOrders, shopifySubscriptions, workspaceMembers, workspaces } from "@db/schema";
import {
    AUDIT_ACTIONS,
    AUDIT_TARGETS,
    recordAuditEvent,
    type AuditActor,
    type AuditExecutor,
} from "@modules/audit/audit.service";

export type LockedWorkspaceForPermanentDelete = {
    id: string;
    name: string;
    ownerUserId: string | null;
    ownerEmail: string;
    status: string;
    subscriptionStatus: string;
    billingSource: string;
    seatLimit: number;
    shopifyShopId: string | null;
};

export type PermanentlyDeleteWorkspaceResult = {
    id: string;
    name: string;
    billingSource: string;
    deletedMemberCount: number;
};

export type PermanentlyDeleteWorkspaceStore = {
    lockWorkspace(id: string): Promise<LockedWorkspaceForPermanentDelete | null>;
    countMembers(workspaceId: string): Promise<number>;
    countShopifyOrders(workspaceId: string): Promise<number>;
    countShopifySubscriptions(workspaceId: string): Promise<number>;
    writeAudit(input: Parameters<typeof recordAuditEvent>[2]): Promise<void>;
    deleteMembers(workspaceId: string): Promise<number>;
    deleteWorkspace(id: string): Promise<void>;
};

export type PermanentlyDeleteWorkspaceInput = {
    actor: AuditActor | null;
    workspaceId: string;
    confirmation: string;
};

/** Workspace names are stored trimmed. Compare exactly after trim — do not fold case. */
export function workspaceConfirmationMatches(provided: string, expected: string): boolean {
    return provided.trim() === expected.trim();
}

export function isShopifyManagedBillingSource(billingSource: string): boolean {
    return billingSource.trim().toLowerCase() === "shopify";
}

/**
 * Permanently deletes a manual workspace and its member seats.
 *
 * Does not touch users, other workspaces, Shopify commerce rows, billing events,
 * Stripe/IAP/RevenueCat, or audit history. Soft revoke remains a separate PATCH.
 */
export async function permanentlyDeleteWorkspace(
    store: PermanentlyDeleteWorkspaceStore,
    input: PermanentlyDeleteWorkspaceInput
): Promise<PermanentlyDeleteWorkspaceResult> {
    const workspace = await store.lockWorkspace(input.workspaceId);
    if (!workspace) {
        throw new NotFoundError("Workspace not found");
    }

    if (!workspaceConfirmationMatches(input.confirmation, workspace.name)) {
        throw new BadRequestError("Confirmation does not match the workspace name.");
    }

    if (isShopifyManagedBillingSource(workspace.billingSource)) {
        throw new ConflictError(
            "Shopify-managed workspaces cannot be permanently deleted. Revoke the workspace instead."
        );
    }

    if (workspace.shopifyShopId) {
        throw new ConflictError(
            "This workspace is linked to a Shopify shop and cannot be permanently deleted. Revoke the workspace instead."
        );
    }

    const shopifyOrderCount = await store.countShopifyOrders(workspace.id);
    if (shopifyOrderCount > 0) {
        throw new ConflictError(
            "This workspace has Shopify orders and cannot be permanently deleted. Revoke the workspace instead."
        );
    }

    const shopifySubscriptionCount = await store.countShopifySubscriptions(workspace.id);
    if (shopifySubscriptionCount > 0) {
        throw new ConflictError(
            "This workspace has Shopify subscriptions and cannot be permanently deleted. Revoke the workspace instead."
        );
    }

    if (workspace.billingSource.trim().toLowerCase() !== "manual") {
        throw new ConflictError("Only manually provisioned workspaces can be permanently deleted.");
    }

    const memberCount = await store.countMembers(workspace.id);

    await store.writeAudit({
        action: AUDIT_ACTIONS.WORKSPACE_PERMANENTLY_DELETED,
        actor: input.actor,
        target: { type: AUDIT_TARGETS.WORKSPACE, id: workspace.id, label: workspace.name },
        workspace: { id: workspace.id, name: workspace.name },
        metadata: {
            deletionType: "permanent",
            name: workspace.name,
            ownerEmail: workspace.ownerEmail,
            ownerUserId: workspace.ownerUserId,
            billingSource: workspace.billingSource,
            subscriptionStatus: workspace.subscriptionStatus,
            status: workspace.status,
            seatLimit: workspace.seatLimit,
            memberCount,
            confirmation: workspace.name.trim(),
        },
        throwOnFailure: true,
    });

    const deletedMemberCount = await store.deleteMembers(workspace.id);
    await store.deleteWorkspace(workspace.id);

    return {
        id: workspace.id,
        name: workspace.name,
        billingSource: workspace.billingSource,
        deletedMemberCount,
    };
}

type PermanentDeleteWorkspaceDb = Pick<FastifyInstance["db"], "select" | "delete"> & AuditExecutor;

export function createDrizzlePermanentDeleteWorkspaceStore(
    tx: PermanentDeleteWorkspaceDb,
    log: FastifyBaseLogger
): PermanentlyDeleteWorkspaceStore {
    return {
        async lockWorkspace(id) {
            const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update").limit(1);
            if (!row) return null;
            return {
                id: row.id,
                name: row.name,
                ownerUserId: row.ownerUserId,
                ownerEmail: row.ownerEmail,
                status: row.status,
                subscriptionStatus: row.subscriptionStatus,
                billingSource: row.billingSource,
                seatLimit: row.seatLimit,
                shopifyShopId: row.shopifyShopId,
            };
        },

        async countMembers(workspaceId) {
            const rows = await tx
                .select({ id: workspaceMembers.id })
                .from(workspaceMembers)
                .where(eq(workspaceMembers.workspaceId, workspaceId));
            return rows.length;
        },

        async countShopifyOrders(workspaceId) {
            const rows = await tx
                .select({ id: shopifyOrders.id })
                .from(shopifyOrders)
                .where(eq(shopifyOrders.workspaceId, workspaceId));
            return rows.length;
        },

        async countShopifySubscriptions(workspaceId) {
            const rows = await tx
                .select({ id: shopifySubscriptions.id })
                .from(shopifySubscriptions)
                .where(eq(shopifySubscriptions.workspaceId, workspaceId));
            return rows.length;
        },

        async writeAudit(input) {
            await recordAuditEvent(tx, log, input);
        },

        async deleteMembers(workspaceId) {
            const deleted = await tx
                .delete(workspaceMembers)
                .where(eq(workspaceMembers.workspaceId, workspaceId))
                .returning({ id: workspaceMembers.id });
            return deleted.length;
        },

        async deleteWorkspace(id) {
            await tx.delete(workspaces).where(eq(workspaces.id, id));
        },
    };
}
