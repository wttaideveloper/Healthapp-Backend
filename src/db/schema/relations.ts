
import { users } from "./users";
import { relations } from "drizzle-orm";

import { emailVerifications } from "./email-verifications";
import { passwordResets } from "./password-resets";
import { revenuecatSubscriptions } from "./revenuecat-subscriptions";
import { storeEntitlements } from "./store-entitlements";
import { stripeCustomers } from "./stripe-customers";
import { stripeSubscriptions } from "./stripe-subscriptions";
import { shopifyShops } from "./shopify-shops";
import { shopifyOrders } from "./shopify-orders";
import { shopifySubscriptions } from "./shopify-subscriptions";
import { workspaces } from "./workspaces";
import { workspaceMembers } from "./workspace-members";

export const userRelations = relations(users, ({ many, one }) => ({
    emailVerifications: many(emailVerifications),
    passwordResets: many(passwordResets),

    revenuecatSubscription: one(revenuecatSubscriptions, {
        fields: [users.id],
        references: [revenuecatSubscriptions.userId],
    }),

    storeEntitlements: many(storeEntitlements),

    stripeCustomer: one(stripeCustomers, {
        fields: [users.id],
        references: [stripeCustomers.userId],
    }),

    stripeSubscriptions: many(stripeSubscriptions),

    ownedWorkspaces: many(workspaces),
    workspaceMemberships: many(workspaceMembers),
}));

export const emailVerificationRelations = relations(
    emailVerifications,
    ({ one }) => ({
        user: one(users, {
            fields: [emailVerifications.userId],
            references: [users.id],
        }),
    })
);

export const passwordResetRelations = relations(
    passwordResets,
    ({ one }) => ({
        user: one(users, {
            fields: [passwordResets.userId],
            references: [users.id],
        }),
    })
);

export const revenuecatSubscriptionRelations = relations(
    revenuecatSubscriptions,
    ({ one }) => ({
        user: one(users, {
            fields: [revenuecatSubscriptions.userId],
            references: [users.id],
        }),
    })
);

export const storeEntitlementRelations = relations(
    storeEntitlements,
    ({ one }) => ({
        user: one(users, {
            fields: [storeEntitlements.ownerUserId],
            references: [users.id],
        }),
    })
);

export const stripeCustomerRelations = relations(
    stripeCustomers,
    ({ one }) => ({
        user: one(users, {
            fields: [stripeCustomers.userId],
            references: [users.id],
        }),
    })
);

export const stripeSubscriptionRelations = relations(
    stripeSubscriptions,
    ({ one }) => ({
        user: one(users, {
            fields: [stripeSubscriptions.userId],
            references: [users.id],
        }),
    })
);

export const workspaceRelations = relations(workspaces, ({ one, many }) => ({
    owner: one(users, {
        fields: [workspaces.ownerUserId],
        references: [users.id],
    }),
    createdBy: one(users, {
        fields: [workspaces.createdByUserId],
        references: [users.id],
    }),
    shopifyShop: one(shopifyShops, {
        fields: [workspaces.shopifyShopId],
        references: [shopifyShops.id],
    }),
    members: many(workspaceMembers),
    shopifyOrders: many(shopifyOrders),
    shopifySubscriptions: many(shopifySubscriptions),
}));

export const workspaceMemberRelations = relations(workspaceMembers, ({ one }) => ({
    workspace: one(workspaces, {
        fields: [workspaceMembers.workspaceId],
        references: [workspaces.id],
    }),
    user: one(users, {
        fields: [workspaceMembers.userId],
        references: [users.id],
    }),
    invitedBy: one(users, {
        fields: [workspaceMembers.invitedByUserId],
        references: [users.id],
    }),
}));

export const shopifyShopRelations = relations(shopifyShops, ({ many }) => ({
    workspaces: many(workspaces),
    orders: many(shopifyOrders),
    subscriptions: many(shopifySubscriptions),
}));

export const shopifyOrderRelations = relations(shopifyOrders, ({ one }) => ({
    shop: one(shopifyShops, {
        fields: [shopifyOrders.shopId],
        references: [shopifyShops.id],
    }),
    workspace: one(workspaces, {
        fields: [shopifyOrders.workspaceId],
        references: [workspaces.id],
    }),
}));

export const shopifySubscriptionRelations = relations(shopifySubscriptions, ({ one }) => ({
    shop: one(shopifyShops, {
        fields: [shopifySubscriptions.shopId],
        references: [shopifyShops.id],
    }),
    workspace: one(workspaces, {
        fields: [shopifySubscriptions.workspaceId],
        references: [workspaces.id],
    }),
}));
