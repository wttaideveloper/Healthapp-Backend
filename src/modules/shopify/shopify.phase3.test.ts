import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
    SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
} from "./shopify.constants";
import {
    extractShopifyCustomerIdFromOrderPayloads,
    parseShopifyOrderLineItems,
    resolveOrderLicenseCount,
    resolvePurchasedLicenseTotal,
    resolveShopifyManagedAdminWorkspaceUpdate,
    serializeShopifyOrderForAdmin,
    shouldProvisionWorkspaceFromShopifyOrder,
    summarizeWorkspaceLicenseAllocation,
} from "./shopify.license";

const SMALL = SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID;
const LARGE = SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID;
const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

function adminLicensingSummary(input: {
    workspaceId: string;
    billingSource: string;
    seatLimit: number;
    assignedLicenses: number;
    expiresAt: string | null;
    subscriptionStatus: string;
    orders: Array<{ status: string; seatQuantity: number }>;
}) {
    const totalLicenses = resolvePurchasedLicenseTotal({
        seatLimit: input.seatLimit,
        orders: input.orders,
    });
    const allocation = summarizeWorkspaceLicenseAllocation({
        totalLicenses,
        assignedLicenses: input.assignedLicenses,
    });

    return {
        workspaceId: input.workspaceId,
        billingSource: input.billingSource,
        ...allocation,
        expiresAt: input.expiresAt,
        subscriptionStatus: input.subscriptionStatus,
        shopifyOrderCount: input.orders.length,
    };
}

describe("Phase 3 admin Shopify licensing summary", () => {
    it("A. Shopify workspace admin licensing summary", () => {
        const summary = adminLicensingSummary({
            workspaceId: WORKSPACE_ID,
            billingSource: "shopify",
            seatLimit: 5,
            assignedLicenses: 2,
            expiresAt: "2027-03-01T12:00:00.000Z",
            subscriptionStatus: "active",
            orders: [
                { status: "pending", seatQuantity: 4 },
                { status: "pending", seatQuantity: 1 },
            ],
        });

        assert.deepEqual(summary, {
            workspaceId: WORKSPACE_ID,
            billingSource: "shopify",
            totalLicenses: 5,
            assignedLicenses: 2,
            remainingLicenses: 3,
            overAllocated: false,
            overAllocatedBy: 0,
            expiresAt: "2027-03-01T12:00:00.000Z",
            subscriptionStatus: "active",
            shopifyOrderCount: 2,
        });
    });

    it("B. Total license calculation: Large 4 + Small 1 = 5", () => {
        assert.equal(
            resolvePurchasedLicenseTotal({
                seatLimit: 5,
                orders: [
                    { status: "pending", seatQuantity: 4 },
                    { status: "pending", seatQuantity: 1 },
                ],
            }),
            5
        );
        assert.equal(resolveOrderLicenseCount([{ seatCount: 4 }, { seatCount: 1 }]), 5);
    });

    it("C. Assigned licenses are the non-revoked seat count (owner counted once)", () => {
        const summary = summarizeWorkspaceLicenseAllocation({
            totalLicenses: 5,
            assignedLicenses: 2,
        });
        assert.equal(summary.assignedLicenses, 2);
        assert.equal(summary.totalLicenses, 5);
    });

    it("D. Remaining licenses: total 5, assigned 2 → remaining 3", () => {
        const summary = summarizeWorkspaceLicenseAllocation({
            totalLicenses: 5,
            assignedLicenses: 2,
        });
        assert.equal(summary.remainingLicenses, 3);
        assert.equal(summary.overAllocated, false);
        assert.equal(summary.overAllocatedBy, 0);
    });

    it("E. Over-allocation after refund: total 0, assigned 4", () => {
        const totalLicenses = resolvePurchasedLicenseTotal({
            seatLimit: 0,
            orders: [{ status: "refunded", seatQuantity: 0 }],
        });
        const summary = summarizeWorkspaceLicenseAllocation({
            totalLicenses,
            assignedLicenses: 4,
        });

        assert.equal(summary.totalLicenses, 0);
        assert.equal(summary.assignedLicenses, 4);
        assert.equal(summary.remainingLicenses, 0);
        assert.equal(summary.overAllocated, true);
        assert.equal(summary.overAllocatedBy, 4);
    });

    it("does not auto-revoke members when over-allocated; remaining is clamped at 0", () => {
        const summary = summarizeWorkspaceLicenseAllocation({
            totalLicenses: 0,
            assignedLicenses: 4,
        });
        assert.equal(summary.remainingLicenses, 0);
        assert.equal(summary.overAllocated, true);
        assert.equal(summary.assignedLicenses, 4);
    });
});

describe("Phase 3 Shopify-managed admin PATCH protection", () => {
    it("G. Shopify-managed workspace cannot have seatLimit overwritten", () => {
        const result = resolveShopifyManagedAdminWorkspaceUpdate({
            billingSource: "shopify",
            requested: { seatLimit: 99 },
        });
        assert.equal(result.allowed, false);
        if (!result.allowed) {
            assert.deepEqual(result.protectedFields, ["seatLimit"]);
        }
    });

    it("H. Shopify-managed workspace cannot have expiresAt overwritten", () => {
        const result = resolveShopifyManagedAdminWorkspaceUpdate({
            billingSource: "shopify",
            requested: { expiresAt: "2028-01-01T00:00:00.000Z" },
        });
        assert.equal(result.allowed, false);
        if (!result.allowed) {
            assert.deepEqual(result.protectedFields, ["expiresAt"]);
        }
    });

    it("I. Shopify-managed workspace cannot have subscriptionStatus overwritten", () => {
        const result = resolveShopifyManagedAdminWorkspaceUpdate({
            billingSource: "shopify",
            requested: { subscriptionStatus: "canceled" },
        });
        assert.equal(result.allowed, false);
        if (!result.allowed) {
            assert.deepEqual(result.protectedFields, ["subscriptionStatus"]);
        }
    });

    it("J. Manually managed workspace can still be edited normally", () => {
        const result = resolveShopifyManagedAdminWorkspaceUpdate({
            billingSource: "manual",
            requested: {
                seatLimit: 8,
                expiresAt: "2028-01-01T00:00:00.000Z",
                subscriptionStatus: "active",
            },
        });
        assert.equal(result.allowed, true);
    });

    it("allows non-licensing fields on Shopify-managed workspaces", () => {
        const result = resolveShopifyManagedAdminWorkspaceUpdate({
            billingSource: "shopify",
            requested: {},
        });
        assert.equal(result.allowed, true);
    });
});

describe("Phase 3 admin Shopify order serialization", () => {
    it("returns safe order fields and omits payload, email, and payment data", () => {
        const view = serializeShopifyOrderForAdmin({
            shopifyOrderId: "gid://shopify/Order/123",
            orderNumber: "1001",
            status: "pending",
            financialStatus: "paid",
            fulfillmentStatus: "fulfilled",
            seatQuantity: 4,
            createdAt: new Date("2026-03-01T12:00:00.000Z"),
            payloadJson: {
                processed_at: "2026-03-01T12:00:00.000Z",
                email: "owner@example.com",
                customer: { id: 778899 },
                line_items: [
                    {
                        product_id: LARGE,
                        quantity: 1,
                        title: "Large Venue Kit",
                    },
                    {
                        product_id: SMALL,
                        quantity: 1,
                        title: "Small Venue Kit",
                    },
                ],
            },
        });

        assert.equal(view.shopifyOrderId, "gid://shopify/Order/123");
        assert.equal(view.orderNumber, "1001");
        assert.equal(view.status, "pending");
        assert.equal(view.financialStatus, "paid");
        assert.equal(view.seatQuantity, 4);
        assert.equal(view.paidAt, "2026-03-01T12:00:00.000Z");
        assert.equal(view.cancelled, false);
        assert.equal(view.refunded, false);
        assert.equal(view.products.length, 2);
        assert.equal(
            view.products.reduce((total, product) => total + product.seatCount, 0),
            5
        );

        const serialized = JSON.stringify(view);
        assert.equal(serialized.includes("payloadJson"), false);
        assert.equal(serialized.includes("owner@example.com"), false);
        assert.equal(serialized.includes("card"), false);
        assert.equal("purchaserEmail" in view, false);
        assert.equal("payloadJson" in view, false);
        assert.equal("totalPrice" in view, false);
    });

    it("extracts Shopify customer ID from stored order payloads when present", () => {
        assert.equal(
            extractShopifyCustomerIdFromOrderPayloads([
                { email: "owner@example.com" },
                { customer: { id: "gid://shopify/Customer/778899" } },
            ]),
            "778899"
        );
    });
});

describe("Phase 3 unknown product default deny", () => {
    it("L. Discover Your Health Age unknown product: no workspace/license created", () => {
        const items = parseShopifyOrderLineItems({
            line_items: [
                {
                    product_id: "11111111111111",
                    quantity: 1,
                    title: "Discover Your Health Age",
                },
            ],
        });
        const seatQuantity = resolveOrderLicenseCount(items);

        assert.equal(items[0]?.licensed, false);
        assert.equal(seatQuantity, 0);
        assert.equal(
            shouldProvisionWorkspaceFromShopifyOrder({ workspaceId: null, seatQuantity }),
            false
        );
    });
});
