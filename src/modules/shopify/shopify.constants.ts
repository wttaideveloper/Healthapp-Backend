/**
 * Shopify org-license status vocabulary (app-level; columns are text).
 *
 * Status mapping (commerce → HealthAge workspace):
 * - Shopify order paid                 → workspace.subscriptionStatus = active
 * - Shopify order cancelled / refunded → workspace.subscriptionStatus = canceled
 * - Seat quantity from surviving Shopify orders → workspace.seatLimit
 * - License expiry                     → workspace.expiresAt = paidAt + 365 days
 *   Repeat purchase on an active workspace preserves the existing future expiry.
 *   Repeat purchase on an expired/canceled workspace restores paidAt + 365 days.
 *
 * Note: workspace.subscription_status uses American "canceled" (workspace.util).
 * shopify_orders.status uses Shopify-style "cancelled" / "refunded".
 *
 * Access continues to resolve via workspaces + GET /api/v1/entitlements/me
 * (source: workspace). Cancelled/refunded/expired subscriptions fail isWorkspaceAccessActive.
 * A cancelled/expired workspace must not shadow another active workspace.
 *
 * Note: workspace.subscription_status uses American "canceled" (workspace.util).
 * shopify_orders.status uses Shopify-style "cancelled" / "refunded".
 *
 * Access continues to resolve via workspaces + GET /api/v1/entitlements/me
 * (source: workspace). Cancelled/refunded/expired subscriptions fail isWorkspaceAccessActive.
 *
 * Product allowlist is default-deny: only the product IDs below create licenses.
 */

/** One-time Shopify kit licenses last 365 days from the paid timestamp. */
export const SHOPIFY_LICENSE_DURATION_DAYS = 365;

export const SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID = "15285348794413";
export const SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID = "15285371502637";
export const SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID = "15285198618669";

export type ShopifyLicensedProduct = {
    readonly id: "small_venue_kit" | "large_venue_kit" | "discover_your_health_age";
    readonly label: string;
    readonly productId: string;
    readonly licensesPerUnit: number;
};

export const SHOPIFY_LICENSED_PRODUCTS = {
    [SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID]: {
        id: "small_venue_kit",
        label: "Small Venue Kit",
        productId: SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
        licensesPerUnit: 1,
    },
    [SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID]: {
        id: "large_venue_kit",
        label: "Large Venue Kit",
        productId: SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
        licensesPerUnit: 4,
    },
    [SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID]: {
        id: "discover_your_health_age",
        label: "Discover Your Health Age",
        productId: SHOPIFY_DISCOVER_YOUR_HEALTH_AGE_PRODUCT_ID,
        licensesPerUnit: 1,
    },
} as const satisfies Record<string, ShopifyLicensedProduct>;

export const workspaceBillingSources = ["manual", "shopify"] as const;
export type WorkspaceBillingSource = (typeof workspaceBillingSources)[number];

export const shopifyShopStatuses = ["active", "disconnected"] as const;
export type ShopifyShopStatus = (typeof shopifyShopStatuses)[number];

export const shopifyOrderStatuses = ["pending", "fulfilled", "refunded", "cancelled"] as const;
export type ShopifyOrderStatus = (typeof shopifyOrderStatuses)[number];

export const shopifySubscriptionStatuses = [
    "active",
    "trialing",
    "past_due",
    "paused",
    "cancelled",
    "expired",
] as const;
export type ShopifySubscriptionStatus = (typeof shopifySubscriptionStatuses)[number];
