
import { users } from "./users";
import { relations } from "drizzle-orm";

import { emailVerifications } from "./email-verifications";
import { passwordResets } from "./password-resets";
import { revenuecatSubscriptions } from "./revenuecat-subscriptions";
import { storeEntitlements } from "./store-entitlements";
import { stripeCustomers } from "./stripe-customers";
import { stripeSubscriptions } from "./stripe-subscriptions";
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
    members: many(workspaceMembers),
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
