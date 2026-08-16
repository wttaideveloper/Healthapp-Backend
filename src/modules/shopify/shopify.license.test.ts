import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
    SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID,
    SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
    SHOPIFY_LICENSE_DURATION_DAYS,
    SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
} from "./shopify.constants";
import {
    isExpectedShopifyShopDomain,
    isLicensedHealthAgeProduct,
    normalizeShopifyProductId,
    parseShopifyOrderLineItems,
    resolveLineItemLicenseCount,
    resolveOrderLicenseCount,
    resolveShopifyLicenseExpiresAt,
    resolveShopifyOrderPaidAt,
    shouldProvisionWorkspaceFromShopifyOrder,
    verifyShopifyWebhookHmac,
    applyShopifyRefundToOrderSeats,
    extractShopifyCustomerId,
    parseShopifyRefundLicenseReduction,
    pickExistingShopifyWorkspaceId,
    remainingShopifyLicenseCapacity,
    resolveRepeatPurchaseExpiresAt,
} from "./shopify.license";

const SMALL = SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID;
const LARGE = SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID;
const DISCOVER = SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID;
const UNRELATED = "99999999999999";
const CONFIGURED_SHOP = "qfiprz-kw.myshopify.com";

function lineItemsPayload(
    items: Array<{ product_id: string | number; quantity: number; title?: string; variant_id?: string; variant_title?: string }>
): Record<string, unknown> {
    return {
        line_items: items.map((item) => ({
            product_id: item.product_id,
            quantity: item.quantity,
            title: item.title ?? "Product",
            variant_id: item.variant_id,
            variant_title: item.variant_title,
        })),
    };
}

describe("Shopify product allowlist and license calculation", () => {
    it("Small Venue Kit quantity 1 → 1 license", () => {
        assert.equal(resolveLineItemLicenseCount(SMALL, 1), 1);
    });

    it("Small Venue Kit quantity 2 → 2 licenses", () => {
        assert.equal(resolveLineItemLicenseCount(SMALL, 2), 2);
    });

    it("Large Venue Kit quantity 1 → 4 licenses", () => {
        assert.equal(resolveLineItemLicenseCount(LARGE, 1), 4);
    });

    it("Large Venue Kit quantity 2 → 8 licenses", () => {
        assert.equal(resolveLineItemLicenseCount(LARGE, 2), 8);
    });

    it("Discover Your Health Age quantity 1 → 1 license", () => {
        assert.equal(resolveLineItemLicenseCount(DISCOVER, 1), 1);
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([{ product_id: DISCOVER, quantity: 1, title: "Discover Your Health Age" }])
        );
        assert.equal(items[0]?.licensed, true);
        assert.equal(resolveOrderLicenseCount(items), 1);
        assert.equal(shouldProvisionWorkspaceFromShopifyOrder({ workspaceId: null, seatQuantity: 1 }), true);
    });

    it("Discover Your Health Age quantity 4 → 4 licenses", () => {
        assert.equal(resolveLineItemLicenseCount(DISCOVER, 4), 4);
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([{ product_id: DISCOVER, quantity: 4, title: "Discover Your Health Age" }])
        );
        assert.equal(items[0]?.licensed, true);
        assert.equal(resolveOrderLicenseCount(items), 4);
    });

    it("mixed Discover × 4 + Small × 1 + Large × 1 → 9 licenses", () => {
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([
                { product_id: DISCOVER, quantity: 4, title: "Discover Your Health Age" },
                { product_id: SMALL, quantity: 1, title: "Small Venue Kit" },
                { product_id: LARGE, quantity: 1, title: "Large Venue Kit" },
            ])
        );
        assert.equal(resolveOrderLicenseCount(items), 9);
        assert.equal(items.filter((item) => item.licensed).length, 3);
        assert.equal(resolveLineItemLicenseCount(SMALL, 1), 1);
        assert.equal(resolveLineItemLicenseCount(LARGE, 1), 4);
    });

    it("mixed Small × 2 + Large × 1 → 6 licenses", () => {
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([
                { product_id: SMALL, quantity: 2, title: "Small Venue Kit" },
                { product_id: LARGE, quantity: 1, title: "Large Venue Kit" },
            ])
        );
        assert.equal(resolveOrderLicenseCount(items), 6);
        assert.equal(items.filter((item) => item.licensed).length, 2);
    });

    it("unrelated product → 0 licenses and not licensed", () => {
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([{ product_id: UNRELATED, quantity: 5, title: "Hydrotherapy" }])
        );
        assert.equal(items.length, 1);
        assert.equal(items[0]?.licensed, false);
        assert.equal(items[0]?.seatCount, 0);
        assert.equal(resolveOrderLicenseCount(items), 0);
        assert.equal(isLicensedHealthAgeProduct(UNRELATED), false);
        assert.equal(shouldProvisionWorkspaceFromShopifyOrder({ workspaceId: null, seatQuantity: 0 }), false);
    });

    it("mixed order ignores unrelated products", () => {
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([
                { product_id: SMALL, quantity: 1, title: "Small Venue Kit" },
                { product_id: LARGE, quantity: 1, title: "Large Venue Kit" },
                { product_id: UNRELATED, quantity: 5, title: "Unrelated product" },
            ])
        );
        assert.equal(resolveOrderLicenseCount(items), 5);
        assert.equal(items.filter((item) => !item.licensed).length, 1);
    });

    it("does not use variant title for venue kits", () => {
        assert.equal(resolveLineItemLicenseCount(SMALL, 1), 1);
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([
                {
                    product_id: SMALL,
                    quantity: 2,
                    title: "Small Venue Kit",
                    variant_title: "99",
                },
            ])
        );
        assert.equal(resolveOrderLicenseCount(items), 2);
    });

    it("does not require variant IDs", () => {
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([{ product_id: LARGE, quantity: 1, title: "Large Venue Kit" }])
        );
        assert.equal(items.length, 1);
        assert.equal(items[0]?.variantId, null);
        assert.equal(items[0]?.seatCount, 4);
    });

    it("accepts numeric product IDs and GraphQL GIDs", () => {
        assert.equal(normalizeShopifyProductId(`gid://shopify/Product/${SMALL}`), SMALL);
        assert.equal(resolveLineItemLicenseCount(`gid://shopify/Product/${LARGE}`, 1), 4);

        const items = parseShopifyOrderLineItems(
            lineItemsPayload([{ product_id: Number(SMALL), quantity: 1, title: "Small Venue Kit" }])
        );
        assert.equal(items[0]?.productId, SMALL);
        assert.equal(items[0]?.seatCount, 1);
    });

    it("does not license Discover Your Health Age by title without an allowlisted product ID", () => {
        const items = parseShopifyOrderLineItems(
            lineItemsPayload([
                {
                    product_id: "11111111111111",
                    quantity: 1,
                    title: "Discover Your Health Age - 4",
                    variant_title: "4",
                },
            ])
        );
        assert.equal(resolveOrderLicenseCount(items), 0);
        assert.equal(items[0]?.licensed, false);
    });
});

describe("Shopify license expiry", () => {
    it("stores paid date + 365 days", () => {
        const paidAt = new Date("2026-03-01T12:00:00.000Z");
        const expiresAt = resolveShopifyLicenseExpiresAt(paidAt);
        assert.equal(expiresAt.toISOString(), "2027-03-01T12:00:00.000Z");
        assert.equal(SHOPIFY_LICENSE_DURATION_DAYS, 365);
        assert.equal(expiresAt.getTime() - paidAt.getTime(), 365 * 24 * 60 * 60 * 1000);
    });

    it("prefers processed_at, then paid_at, then created_at", () => {
        const processed = resolveShopifyOrderPaidAt({
            processed_at: "2026-01-10T08:00:00.000Z",
            paid_at: "2026-01-09T08:00:00.000Z",
            created_at: "2026-01-08T08:00:00.000Z",
        });
        assert.equal(processed?.toISOString(), "2026-01-10T08:00:00.000Z");

        const paid = resolveShopifyOrderPaidAt({
            paid_at: "2026-01-09T08:00:00.000Z",
            created_at: "2026-01-08T08:00:00.000Z",
        });
        assert.equal(paid?.toISOString(), "2026-01-09T08:00:00.000Z");

        const created = resolveShopifyOrderPaidAt({
            created_at: "2026-01-08T08:00:00.000Z",
        });
        assert.equal(created?.toISOString(), "2026-01-08T08:00:00.000Z");
    });
});

describe("Shopify webhook HMAC", () => {
    const secret = "shopify-webhook-secret";
    const body = Buffer.from('{"id":1}', "utf8");
    const validHmac = createHmac("sha256", secret).update(body).digest("base64");

    it("accepts a valid signature", () => {
        assert.equal(verifyShopifyWebhookHmac(body, validHmac, secret), true);
    });

    it("rejects an invalid signature", () => {
        assert.equal(verifyShopifyWebhookHmac(body, "invalid-hmac-signature-value", secret), false);
    });
});

describe("Shopify shop domain validation", () => {
    it("accepts the configured production shop domain", () => {
        assert.equal(isExpectedShopifyShopDomain(CONFIGURED_SHOP, CONFIGURED_SHOP), true);
        assert.equal(isExpectedShopifyShopDomain("QFIPRZ-KW.myshopify.com", CONFIGURED_SHOP), true);
    });

    it("rejects a different shop when a domain is configured", () => {
        assert.equal(isExpectedShopifyShopDomain("other-shop.myshopify.com", CONFIGURED_SHOP), false);
        assert.equal(isExpectedShopifyShopDomain(null, CONFIGURED_SHOP), false);
    });

    it("skips shop checks when no domain is configured", () => {
        assert.equal(isExpectedShopifyShopDomain("other-shop.myshopify.com", undefined), true);
    });
});

describe("Shopify provisioning idempotency guards", () => {
    it("does not provision when a workspace already exists", () => {
        assert.equal(
            shouldProvisionWorkspaceFromShopifyOrder({ workspaceId: "ws_existing", seatQuantity: 4 }),
            false
        );
    });

    it("does not provision unrelated (0-license) orders", () => {
        assert.equal(
            shouldProvisionWorkspaceFromShopifyOrder({ workspaceId: null, seatQuantity: 0 }),
            false
        );
    });

    it("provisions new qualifying orders", () => {
        assert.equal(
            shouldProvisionWorkspaceFromShopifyOrder({ workspaceId: null, seatQuantity: 4 }),
            true
        );
    });
});

describe("Shopify workspace reuse", () => {
    it("prefers customer ID, then shop+email, then Shopify billing email", () => {
        assert.equal(
            pickExistingShopifyWorkspaceId({
                byCustomerId: "ws_customer",
                byShopAndEmail: "ws_shop",
                byEmailAndShopifyBilling: "ws_email",
            }),
            "ws_customer"
        );
        assert.equal(
            pickExistingShopifyWorkspaceId({
                byCustomerId: null,
                byShopAndEmail: "ws_shop",
                byEmailAndShopifyBilling: "ws_email",
            }),
            "ws_shop"
        );
        assert.equal(
            pickExistingShopifyWorkspaceId({
                byCustomerId: null,
                byShopAndEmail: null,
                byEmailAndShopifyBilling: "ws_email",
            }),
            "ws_email"
        );
        assert.equal(
            pickExistingShopifyWorkspaceId({
                byCustomerId: null,
                byShopAndEmail: null,
                byEmailAndShopifyBilling: null,
            }),
            null
        );
    });

    it("extracts Shopify customer ID from payload", () => {
        assert.equal(extractShopifyCustomerId({ customer: { id: 778899 } }), "778899");
        assert.equal(extractShopifyCustomerId({ customer_id: "gid://shopify/Customer/778899" }), "778899");
        assert.equal(extractShopifyCustomerId({ email: "a@b.com" }), null);
    });
});

describe("Shopify remaining license capacity", () => {
    it("A. first Large × 1 → 4 licenses", () => {
        assert.equal(remainingShopifyLicenseCapacity([{ status: "pending", seatQuantity: 4 }]), 4);
    });

    it("B. Large + Small → 5 licenses", () => {
        assert.equal(
            remainingShopifyLicenseCapacity([
                { status: "pending", seatQuantity: 4 },
                { status: "pending", seatQuantity: 1 },
            ]),
            5
        );
    });

    it("D. refund Small while Large remains → 4 licenses, workspace stays active", () => {
        const remaining = remainingShopifyLicenseCapacity([
            { status: "pending", seatQuantity: 4 },
            { status: "refunded", seatQuantity: 0 },
        ]);
        assert.equal(remaining, 4);
        assert.equal(remaining > 0 ? "active" : "canceled", "active");
    });

    it("E. refund final active order → 0 licenses, workspace canceled", () => {
        const remaining = remainingShopifyLicenseCapacity([{ status: "refunded", seatQuantity: 0 }]);
        assert.equal(remaining, 0);
        assert.equal(remaining > 0 ? "active" : "canceled", "canceled");
    });

    it("F. cancel one order while another remains active", () => {
        assert.equal(
            remainingShopifyLicenseCapacity([
                { status: "pending", seatQuantity: 4 },
                { status: "cancelled", seatQuantity: 1 },
            ]),
            4
        );
    });
});

describe("Shopify repeat-purchase expiry", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const future = new Date("2027-01-01T00:00:00.000Z");
    const past = new Date("2026-01-01T00:00:00.000Z");
    const paidAt = new Date("2026-06-01T00:00:00.000Z");

    it("preserves a future expiry on an active workspace", () => {
        const expiresAt = resolveRepeatPurchaseExpiresAt({
            workspaceStatus: "active",
            subscriptionStatus: "active",
            existingExpiresAt: future,
            newPaidAt: paidAt,
            now,
        });
        assert.equal(expiresAt?.toISOString(), future.toISOString());
    });

    it("restores paid date + 365 days when expired or canceled", () => {
        const expired = resolveRepeatPurchaseExpiresAt({
            workspaceStatus: "active",
            subscriptionStatus: "active",
            existingExpiresAt: past,
            newPaidAt: paidAt,
            now,
        });
        assert.equal(expired?.toISOString(), "2027-06-01T00:00:00.000Z");

        const canceled = resolveRepeatPurchaseExpiresAt({
            workspaceStatus: "active",
            subscriptionStatus: "canceled",
            existingExpiresAt: future,
            newPaidAt: paidAt,
            now,
        });
        assert.equal(canceled?.toISOString(), "2027-06-01T00:00:00.000Z");
    });
});

describe("Shopify refund license reduction", () => {
    const orderPayload = {
        line_items: [
            { id: 11, product_id: LARGE, quantity: 2, title: "Large Venue Kit" },
            { id: 22, product_id: SMALL, quantity: 1, title: "Small Venue Kit" },
        ],
    };

    it("L. partial refund of Large × 2 by quantity 1 → 4 licenses refunded", () => {
        const reduction = parseShopifyRefundLicenseReduction(
            {
                order_id: 1001,
                refund_line_items: [{ line_item_id: 11, quantity: 1, line_item: { id: 11, product_id: LARGE } }],
            },
            orderPayload
        );
        assert.equal(reduction.hasRefundLineItems, true);
        assert.equal(reduction.refundedLicenses, 4);
        const applied = applyShopifyRefundToOrderSeats({ currentSeatQuantity: 8, refundedLicenses: 4 });
        assert.equal(applied.seatQuantity, 4);
        assert.equal(applied.fullyRefunded, false);
    });

    it("does not guess when refund_line_items is missing", () => {
        const reduction = parseShopifyRefundLicenseReduction({ order_id: 1001 }, orderPayload);
        assert.equal(reduction.hasRefundLineItems, false);
        assert.equal(reduction.refundedLicenses, 0);
    });

    it("K. a fully refunded order is not reduced again", () => {
        const applied = applyShopifyRefundToOrderSeats({ currentSeatQuantity: 0, refundedLicenses: 4 });
        assert.equal(applied.seatQuantity, 0);
        assert.equal(applied.fullyRefunded, true);
    });
});
