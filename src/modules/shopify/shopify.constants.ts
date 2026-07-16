/**
 * Shopify org-license status vocabulary (app-level; columns are text).
 *
 * Status mapping (commerce → HealthAge workspace):
 * - Shopify order paid / fulfilled     → workspace.subscriptionStatus = active
 * - Shopify subscription active        → workspace.subscriptionStatus = active
 * - Shopify subscription past_due      → workspace.subscriptionStatus = past_due
 * - Refund / cancel / expire           → workspace.subscriptionStatus = canceled | expired
 * - Seat quantity from order/sub       → workspace.seatLimit
 *
 * Access continues to resolve via workspaces + GET /api/v1/entitlements/me
 * (source: workspace). Webhook handlers land in a later phase.
 */

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
