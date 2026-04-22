
import { users } from "./users";
import { relations } from "drizzle-orm";

import { emailVerifications } from "./email-verifications";
import { passwordResets } from "./password-resets";
import { licenses } from "./licenses";
import { licenseActivations } from "./license-activations";
import { revenuecatSubscriptions } from "./revenuecat-subscriptions";
import { storeEntitlements } from "./store-entitlements";
import { stripeCustomers } from "./stripe-customers";
import { stripeSubscriptions } from "./stripe-subscriptions";

export const userRelations = relations(users, ({ many, one }) => ({
    emailVerifications: many(emailVerifications),
    passwordResets: many(passwordResets),

    license: one(licenses, {
        fields: [users.licenseId],
        references: [licenses.id],
    }),

    licenseActivations: many(licenseActivations),

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


export const licenseRelations = relations(licenses, ({ many }) => ({
    users: many(users),
    activations: many(licenseActivations),
}));

export const licenseActivationRelations = relations(
    licenseActivations,
    ({ one }) => ({
        user: one(users, {
            fields: [licenseActivations.userId],
            references: [users.id],
        }),

        license: one(licenses, {
            fields: [licenseActivations.licenseId],
            references: [licenses.id],
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
