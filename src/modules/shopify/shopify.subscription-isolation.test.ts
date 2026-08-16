import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    resolveShopifySubscriptionWorkspacePatch,
    workspaceHasOneTimeShopifyOrderLicensing,
} from "./shopify.license";

const KIT_EXPIRES_AT = new Date("2027-03-01T12:00:00.000Z");
const SUBSCRIPTION_EXPIRES_AT = new Date("2026-12-01T00:00:00.000Z");

describe("Shopify subscription isolation from one-time Venue Kit workspaces", () => {
    it("treats a workspace with linked Shopify orders as one-time order licensed", () => {
        assert.equal(workspaceHasOneTimeShopifyOrderLicensing(1), true);
        assert.equal(workspaceHasOneTimeShopifyOrderLicensing(4), true);
        assert.equal(workspaceHasOneTimeShopifyOrderLicensing(0), false);
    });

    it("1. Venue Kit workspace + subscription-created does not change licensing", () => {
        const patch = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 1,
            lifecycle: "created",
            subscriptionStatus: "active",
            expiresAt: SUBSCRIPTION_EXPIRES_AT,
            seatLimit: 12,
            seatChanged: true,
        });

        assert.equal(patch.apply, false);
        assert.equal(patch.seatLimit, undefined);
        assert.equal(patch.expiresAt, undefined);
        assert.equal(patch.subscriptionStatus, undefined);
        assert.notEqual(KIT_EXPIRES_AT.toISOString(), SUBSCRIPTION_EXPIRES_AT.toISOString());
    });

    it("2. Venue Kit workspace + subscription-updated does not mutate licensing", () => {
        const patch = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 2,
            lifecycle: "updated",
            subscriptionStatus: "past_due",
            expiresAt: SUBSCRIPTION_EXPIRES_AT,
            seatLimit: 99,
            seatChanged: true,
        });

        assert.equal(patch.apply, false);
        assert.equal(patch.seatLimit, undefined);
        assert.equal(patch.expiresAt, undefined);
        assert.equal(patch.subscriptionStatus, undefined);
    });

    it("3. Venue Kit workspace + subscription-cancelled does not cancel the workspace", () => {
        const patch = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 1,
            lifecycle: "cancelled",
            subscriptionStatus: "canceled",
        });

        assert.equal(patch.apply, false);
        assert.equal(patch.subscriptionStatus, undefined);
    });

    it("4. genuine subscription workspace keeps existing created behavior", () => {
        const patch = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 0,
            lifecycle: "created",
            subscriptionStatus: "active",
            expiresAt: SUBSCRIPTION_EXPIRES_AT,
        });

        assert.equal(patch.apply, true);
        assert.equal(patch.subscriptionStatus, "active");
        assert.equal(patch.expiresAt?.toISOString(), SUBSCRIPTION_EXPIRES_AT.toISOString());
        assert.equal(patch.seatLimit, undefined);
    });

    it("4. genuine subscription workspace keeps existing updated behavior", () => {
        const patch = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 0,
            lifecycle: "updated",
            subscriptionStatus: "past_due",
            expiresAt: SUBSCRIPTION_EXPIRES_AT,
            seatLimit: 8,
            seatChanged: true,
        });

        assert.equal(patch.apply, true);
        assert.equal(patch.subscriptionStatus, "past_due");
        assert.equal(patch.seatLimit, 8);
        assert.equal(patch.expiresAt?.toISOString(), SUBSCRIPTION_EXPIRES_AT.toISOString());
    });

    it("4. genuine subscription workspace keeps existing cancelled behavior", () => {
        const patch = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 0,
            lifecycle: "cancelled",
            subscriptionStatus: "canceled",
        });

        assert.equal(patch.apply, true);
        assert.equal(patch.subscriptionStatus, "canceled");
        assert.equal(patch.seatLimit, undefined);
        assert.equal(patch.expiresAt, undefined);
    });

    it("does not treat billing_source shopify alone as a reason to skip; only linked orders do", () => {
        const genuine = resolveShopifySubscriptionWorkspacePatch({
            linkedShopifyOrderCount: 0,
            lifecycle: "updated",
            subscriptionStatus: "active",
            seatChanged: false,
        });
        assert.equal(genuine.apply, true);
        assert.equal(genuine.subscriptionStatus, "active");
        assert.equal(genuine.seatLimit, undefined);
    });
});
