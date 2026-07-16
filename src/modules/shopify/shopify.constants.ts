/**
 * Shopify org-license status vocabulary (app-level; columns are text).
 *
 * Status mapping (commerce → HealthAge workspace):
 * - Shopify order paid                 → workspace.subscriptionStatus = active
 * - Shopify order cancelled / refunded → workspace.subscriptionStatus = canceled
 * - Seat quantity from order/sub       → workspace.seatLimit
 *
 * Note: workspace.subscription_status uses American "canceled" (workspace.util).
 * shopify_orders.status uses Shopify-style "cancelled" / "refunded".
 *
 * Access continues to resolve via workspaces + GET /api/v1/entitlements/me
 * (source: workspace). Cancelled/refunded subscriptions fail isWorkspaceAccessActive.
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
