import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { FastifyInstance } from "fastify";

import { revenuecatSubscriptions, storeEntitlements, stripeSubscriptions, workspaceMembers, workspaces } from "@db/schema";
import { isWorkspaceAccessActive } from "@modules/workspace/workspace.util";
import { AUDIT_ACTIONS, AUDIT_TARGETS, recordAuditEvent } from "@modules/audit/audit.service";

export type EntitlementSource = "workspace" | "individual_iap" | "individual_stripe" | null;

export type EntitlementState = {
    hasAccess: boolean;
    source: EntitlementSource;
    expiresAt: string | null;
    providerStatus: string | null;
    autoRenewing: boolean | null;
    workspace: {
        id: string;
        name: string;
        role: string;
        memberStatus: string;
        plan: string;
        seatLimit: number;
        subscriptionStatus: string;
    } | null;
    individual: {
        provider: "revenuecat" | "stripe";
        productId: string | null;
        status: string | null;
    } | null;
};

function isStripeSubscriptionActive(status: string, expiresAt: Date | null): boolean {
    const activeStatuses = new Set(["active", "trialing"]);
    if (!activeStatuses.has(status)) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
}

function isStoreEntitlementActive(isActive: boolean, expiresAt: Date | null): boolean {
    if (!isActive) return false;
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
}

export async function linkWorkspaceMembershipsForUser(
    app: FastifyInstance,
    user: { id: string; email: string }
): Promise<void> {
    const now = new Date();

    // Workspace invites are email-first, so account creation/login claims pending seats.
    // `.returning()` captures exactly which seats were claimed by THIS call, which
    // is the real "member joined" moment — a no-op run returns nothing and audits
    // nothing. Runs on every login, so it must stay a single statement.
    const claimedSeats = await app.db
        .update(workspaceMembers)
        .set({
            userId: user.id,
            status: "active",
            joinedAt: now,
            updatedAt: now,
        })
        .where(and(eq(workspaceMembers.email, user.email), isNull(workspaceMembers.userId), eq(workspaceMembers.status, "invited")))
        .returning({
            id: workspaceMembers.id,
            workspaceId: workspaceMembers.workspaceId,
            role: workspaceMembers.role,
        });

    for (const seat of claimedSeats) {
        // The member is their own actor here: accepting an invitation is an action
        // they took, not something an administrator did to them.
        await recordAuditEvent(app.db, app.log, {
            action: AUDIT_ACTIONS.MEMBER_JOINED,
            actor: { id: user.id, email: user.email },
            target: { type: AUDIT_TARGETS.MEMBER, id: seat.id, label: user.email },
            workspace: { id: seat.workspaceId },
            metadata: { role: seat.role },
        });
    }

    await app.db
        .update(workspaces)
        .set({
            ownerUserId: user.id,
            updatedAt: now,
        })
        .where(and(eq(workspaces.ownerEmail, user.email), isNull(workspaces.ownerUserId)));
}

export async function getEntitlementState(app: FastifyInstance, userId: string): Promise<EntitlementState> {
    const now = new Date();

    // Workspace access wins over individual purchases so organization users never see paywalls.
    const [workspaceAccess] = await app.db
        .select({
            workspaceId: workspaces.id,
            workspaceName: workspaces.name,
            role: workspaceMembers.role,
            memberStatus: workspaceMembers.status,
            plan: workspaces.plan,
            seatLimit: workspaces.seatLimit,
            workspaceStatus: workspaces.status,
            subscriptionStatus: workspaces.subscriptionStatus,
            expiresAt: workspaces.expiresAt,
            updatedAt: workspaces.updatedAt,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
        .orderBy(desc(workspaces.updatedAt))
        .limit(1);

    if (
        workspaceAccess &&
        isWorkspaceAccessActive({
            workspaceStatus: workspaceAccess.workspaceStatus,
            subscriptionStatus: workspaceAccess.subscriptionStatus,
            expiresAt: workspaceAccess.expiresAt,
        })
    ) {
        return {
            hasAccess: true,
            source: "workspace",
            expiresAt: workspaceAccess.expiresAt?.toISOString() ?? null,
            providerStatus: workspaceAccess.subscriptionStatus,
            autoRenewing: null,
            workspace: {
                id: workspaceAccess.workspaceId,
                name: workspaceAccess.workspaceName,
                role: workspaceAccess.role,
                memberStatus: workspaceAccess.memberStatus,
                plan: workspaceAccess.plan,
                seatLimit: workspaceAccess.seatLimit,
                subscriptionStatus: workspaceAccess.subscriptionStatus,
            },
            individual: null,
        };
    }

    // Individual access can come from App Store/Play Store via RevenueCat or standalone/web via Stripe.
    const [storeEntitlement, stripeSubscription, revenuecatSubscription] = await Promise.all([
        app.db
            .select()
            .from(storeEntitlements)
            .where(
                and(
                    eq(storeEntitlements.ownerUserId, userId),
                    eq(storeEntitlements.isActive, true),
                    or(isNull(storeEntitlements.expiresAt), gt(storeEntitlements.expiresAt, now))
                )
            )
            .orderBy(desc(storeEntitlements.expiresAt), desc(storeEntitlements.updatedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        app.db
            .select()
            .from(stripeSubscriptions)
            .where(eq(stripeSubscriptions.userId, userId))
            .orderBy(desc(stripeSubscriptions.updatedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        app.db
            .select()
            .from(revenuecatSubscriptions)
            .where(eq(revenuecatSubscriptions.userId, userId))
            .orderBy(desc(revenuecatSubscriptions.updatedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null),
    ]);

    if (storeEntitlement && isStoreEntitlementActive(storeEntitlement.isActive, storeEntitlement.expiresAt)) {
        return {
            hasAccess: true,
            source: "individual_iap",
            expiresAt: storeEntitlement.expiresAt?.toISOString() ?? null,
            providerStatus: storeEntitlement.status,
            autoRenewing: revenuecatSubscription?.autoRenewing ?? null,
            workspace: null,
            individual: {
                provider: "revenuecat",
                productId: storeEntitlement.productId,
                status: storeEntitlement.status,
            },
        };
    }

    if (stripeSubscription && isStripeSubscriptionActive(stripeSubscription.status, stripeSubscription.currentPeriodEnd)) {
        return {
            hasAccess: true,
            source: "individual_stripe",
            expiresAt: stripeSubscription.currentPeriodEnd?.toISOString() ?? null,
            providerStatus: stripeSubscription.providerStatus ?? stripeSubscription.status,
            autoRenewing: stripeSubscription.autoRenewing,
            workspace: null,
            individual: {
                provider: "stripe",
                productId: stripeSubscription.priceId,
                status: stripeSubscription.status,
            },
        };
    }

    return {
        hasAccess: false,
        source: null,
        expiresAt: null,
        providerStatus: null,
        autoRenewing: null,
        workspace: null,
        individual: null,
    };
}
