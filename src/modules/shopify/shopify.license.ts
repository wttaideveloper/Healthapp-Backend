import { createHmac, timingSafeEqual } from "node:crypto";

import {
    SHOPIFY_LICENSE_DURATION_DAYS,
    SHOPIFY_LICENSED_PRODUCTS,
    type ShopifyLicensedProduct,
} from "./shopify.constants";

const LICENSED_PRODUCTS_BY_ID: Record<string, ShopifyLicensedProduct> = SHOPIFY_LICENSED_PRODUCTS;

export type ShopifyOrderLineItem = {
    productId: string;
    variantId: string | null;
    variantTitle: string | null;
    productTitle: string;
    quantity: number;
    seatCount: number;
    licensed: boolean;
};

const LICENSE_DURATION_MS = SHOPIFY_LICENSE_DURATION_DAYS * 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asString(value: unknown): string | null {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}

function asNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asDate(value: unknown): Date | null {
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
}

/**
 * Normalize Shopify product IDs from REST numbers or GraphQL GIDs
 * (`gid://shopify/Product/15285348794413`) to a numeric string.
 */
export function normalizeShopifyProductId(productId: string): string {
    const trimmed = productId.trim();
    const gidMatch = /^gid:\/\/shopify\/Product\/(\d+)$/i.exec(trimmed);
    if (gidMatch?.[1]) {
        return gidMatch[1];
    }
    return trimmed;
}

export function getShopifyLicensedProduct(productId: string): ShopifyLicensedProduct | null {
    const normalized = normalizeShopifyProductId(productId);
    return LICENSED_PRODUCTS_BY_ID[normalized] ?? null;
}

export function isLicensedHealthAgeProduct(productId: string): boolean {
    return getShopifyLicensedProduct(productId) !== null;
}

/**
 * License count for a single line item. Default deny: unknown product IDs
 * contribute 0. Qualifying kits use licensesPerUnit × quantity.
 * Variant titles are not used.
 */
export function resolveLineItemLicenseCount(productId: string, quantity: number): number {
    const licensedProduct = getShopifyLicensedProduct(productId);
    if (!licensedProduct) {
        return 0;
    }

    const units = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
    return licensedProduct.licensesPerUnit * units;
}

export function resolveOrderLicenseCount(lineItems: ReadonlyArray<Pick<ShopifyOrderLineItem, "seatCount">>): number {
    return lineItems.reduce((total, item) => total + item.seatCount, 0);
}

export function parseShopifyOrderLineItems(payload: Record<string, unknown>): ShopifyOrderLineItem[] {
    const rawLineItems = payload.line_items;
    if (!Array.isArray(rawLineItems)) {
        return [];
    }

    return rawLineItems
        .map((item) => {
            const lineItem = asRecord(item);
            if (!lineItem) {
                return null;
            }

            const productIdRaw = asString(lineItem.product_id);
            if (!productIdRaw) {
                return null;
            }

            const productId = normalizeShopifyProductId(productIdRaw);
            const quantity = asNumber(lineItem.quantity) ?? 0;
            const licensedProduct = getShopifyLicensedProduct(productId);
            const seatCount = resolveLineItemLicenseCount(productId, quantity);

            return {
                productId,
                variantId: asString(lineItem.variant_id),
                variantTitle: asString(lineItem.variant_title),
                productTitle: asString(lineItem.title) ?? asString(lineItem.name) ?? "Unknown product",
                quantity,
                seatCount,
                licensed: licensedProduct !== null,
            };
        })
        .filter((item): item is ShopifyOrderLineItem => item !== null);
}

/**
 * Paid timestamp for license expiry.
 * Prefer Shopify's processed/paid time; fall back to order created_at.
 */
export function resolveShopifyOrderPaidAt(payload: Record<string, unknown>): Date | null {
    return asDate(payload.processed_at) ?? asDate(payload.paid_at) ?? asDate(payload.created_at);
}

export function resolveShopifyLicenseExpiresAt(paidAt: Date): Date {
    return new Date(paidAt.getTime() + LICENSE_DURATION_MS);
}

export function shouldProvisionWorkspaceFromShopifyOrder(input: {
    workspaceId: string | null;
    seatQuantity: number;
}): boolean {
    return input.workspaceId === null && input.seatQuantity > 0;
}

export function normalizeShopifyCustomerId(customerId: string): string {
    const trimmed = customerId.trim();
    const gidMatch = /^gid:\/\/shopify\/Customer\/(\d+)$/i.exec(trimmed);
    if (gidMatch?.[1]) {
        return gidMatch[1];
    }
    return trimmed;
}

export function extractShopifyCustomerId(payload: Record<string, unknown>): string | null {
    const customer = asRecord(payload.customer);
    const raw = (customer ? asString(customer.id) : null) ?? asString(payload.customer_id);
    return raw ? normalizeShopifyCustomerId(raw) : null;
}

export function isShopifyOrderContributingLicenses(status: string): boolean {
    return status !== "cancelled" && status !== "refunded";
}

export function remainingShopifyLicenseCapacity(
    orders: ReadonlyArray<{ status: string; seatQuantity: number }>
): number {
    return orders
        .filter((order) => isShopifyOrderContributingLicenses(order.status))
        .reduce((total, order) => total + Math.max(order.seatQuantity, 0), 0);
}

export const SHOPIFY_MANAGED_LICENSING_FIELDS = ["seatLimit", "expiresAt", "subscriptionStatus"] as const;

export type ShopifyManagedLicensingField = (typeof SHOPIFY_MANAGED_LICENSING_FIELDS)[number];

export function isShopifyManagedLicensingWorkspace(billingSource: string): boolean {
    return billingSource === "shopify";
}

/**
 * Purchased license total for admin visibility.
 * Linked Shopify orders are the source of truth when present; otherwise the
 * stored workspace seat_limit (manual / subscription workspaces).
 */
export function resolvePurchasedLicenseTotal(input: {
    seatLimit: number;
    orders: ReadonlyArray<{ status: string; seatQuantity: number }>;
}): number {
    if (input.orders.length > 0) {
        return remainingShopifyLicenseCapacity(input.orders);
    }
    return Math.max(input.seatLimit, 0);
}

export type WorkspaceLicenseAllocation = {
    totalLicenses: number;
    assignedLicenses: number;
    remainingLicenses: number;
    overAllocated: boolean;
    overAllocatedBy: number;
};

/**
 * Assigned seats must come from countNonRevokedWorkspaceSeats (owner included once).
 * Remaining never goes negative; overflow is reported separately.
 */
export function summarizeWorkspaceLicenseAllocation(input: {
    totalLicenses: number;
    assignedLicenses: number;
}): WorkspaceLicenseAllocation {
    const totalLicenses = Math.max(input.totalLicenses, 0);
    const assignedLicenses = Math.max(input.assignedLicenses, 0);
    const remainingLicenses = Math.max(totalLicenses - assignedLicenses, 0);
    const overAllocatedBy = Math.max(assignedLicenses - totalLicenses, 0);

    return {
        totalLicenses,
        assignedLicenses,
        remainingLicenses,
        overAllocated: overAllocatedBy > 0,
        overAllocatedBy,
    };
}

export function shopifyManagedLicensingFieldsInUpdate(requested: {
    seatLimit?: unknown;
    expiresAt?: unknown;
    subscriptionStatus?: unknown;
}): ShopifyManagedLicensingField[] {
    const fields: ShopifyManagedLicensingField[] = [];
    if (requested.seatLimit !== undefined) fields.push("seatLimit");
    if (requested.expiresAt !== undefined) fields.push("expiresAt");
    if (requested.subscriptionStatus !== undefined) fields.push("subscriptionStatus");
    return fields;
}

/**
 * Generic admin PATCH must not overwrite Shopify-managed licensing fields.
 * Manual workspaces remain fully editable.
 */
export function resolveShopifyManagedAdminWorkspaceUpdate(input: {
    billingSource: string;
    requested: {
        seatLimit?: unknown;
        expiresAt?: unknown;
        subscriptionStatus?: unknown;
    };
}): { allowed: true } | { allowed: false; protectedFields: ShopifyManagedLicensingField[] } {
    if (!isShopifyManagedLicensingWorkspace(input.billingSource)) {
        return { allowed: true };
    }

    const protectedFields = shopifyManagedLicensingFieldsInUpdate(input.requested);
    if (protectedFields.length === 0) {
        return { allowed: true };
    }

    return { allowed: false, protectedFields };
}

export function asShopifyPayload(value: unknown): Record<string, unknown> | null {
    return asRecord(value);
}

export function extractShopifyCustomerIdFromOrderPayloads(payloads: readonly unknown[]): string | null {
    for (const payload of payloads) {
        const record = asShopifyPayload(payload);
        if (!record) {
            continue;
        }
        const customerId = extractShopifyCustomerId(record);
        if (customerId) {
            return customerId;
        }
    }
    return null;
}

export type ShopifyAdminOrderProductView = {
    productId: string;
    productTitle: string;
    quantity: number;
    seatCount: number;
    licensed: boolean;
};

export type ShopifyAdminOrderView = {
    shopifyOrderId: string;
    orderNumber: string | null;
    status: string;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    seatQuantity: number;
    createdAt: string;
    paidAt: string | null;
    cancelled: boolean;
    refunded: boolean;
    products: ShopifyAdminOrderProductView[];
};

export function serializeShopifyOrderForAdmin(order: {
    shopifyOrderId: string;
    orderNumber: string | null;
    status: string;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    seatQuantity: number;
    createdAt: Date;
    payloadJson: unknown;
}): ShopifyAdminOrderView {
    const payload = asShopifyPayload(order.payloadJson);
    const paidAt = payload ? resolveShopifyOrderPaidAt(payload) : null;
    const products = payload
        ? parseShopifyOrderLineItems(payload).map((item) => ({
              productId: item.productId,
              productTitle: item.productTitle,
              quantity: item.quantity,
              seatCount: item.seatCount,
              licensed: item.licensed,
          }))
        : [];

    return {
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        status: order.status,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        seatQuantity: order.seatQuantity,
        createdAt: order.createdAt.toISOString(),
        paidAt: paidAt?.toISOString() ?? null,
        cancelled: order.status === "cancelled",
        refunded: order.status === "refunded",
        products,
    };
}

/**
 * One-time Venue Kit licensing is represented by shopify_orders linked to the
 * workspace. billing_source="shopify" alone is not enough: that value is also
 * used for genuine subscription workspaces if that workflow exists.
 */
export function workspaceHasOneTimeShopifyOrderLicensing(linkedShopifyOrderCount: number): boolean {
    return linkedShopifyOrderCount > 0;
}

export type ShopifySubscriptionWorkspacePatch = {
    apply: boolean;
    subscriptionStatus?: string;
    seatLimit?: number;
    expiresAt?: Date | null;
};

/**
 * Subscription webhooks must not change seat_limit, expires_at, or
 * subscription_status on workspaces licensed by one-time Shopify orders.
 * Genuine subscription workspaces (no linked orders) keep existing behavior.
 */
export function resolveShopifySubscriptionWorkspacePatch(input: {
    linkedShopifyOrderCount: number;
    lifecycle: "created" | "updated" | "cancelled";
    subscriptionStatus: string;
    expiresAt?: Date | null;
    seatLimit?: number;
    seatChanged?: boolean;
}): ShopifySubscriptionWorkspacePatch {
    if (workspaceHasOneTimeShopifyOrderLicensing(input.linkedShopifyOrderCount)) {
        return { apply: false };
    }

    if (input.lifecycle === "created") {
        return {
            apply: true,
            subscriptionStatus: "active",
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        };
    }

    if (input.lifecycle === "updated") {
        return {
            apply: true,
            subscriptionStatus: input.subscriptionStatus,
            ...(input.seatChanged && input.seatLimit !== undefined ? { seatLimit: input.seatLimit } : {}),
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        };
    }

    return {
        apply: true,
        subscriptionStatus: "canceled",
    };
}

export function pickExistingShopifyWorkspaceId(input: {
    byCustomerId: string | null;
    byShopAndEmail: string | null;
    byEmailAndShopifyBilling: string | null;
}): string | null {
    return input.byCustomerId ?? input.byShopAndEmail ?? input.byEmailAndShopifyBilling;
}

/**
 * Repeat-purchase expiry: preserve a still-valid future expiry.
 * Restore paid date + 365 days only when the workspace is expired/inactive.
 */
export function resolveRepeatPurchaseExpiresAt(input: {
    workspaceStatus: string;
    subscriptionStatus: string;
    existingExpiresAt: Date | null;
    newPaidAt: Date;
    now?: Date;
}): Date | null {
    const now = input.now ?? new Date();
    const currentlyActive =
        input.workspaceStatus === "active" &&
        (input.subscriptionStatus === "active" || input.subscriptionStatus === "trialing") &&
        (input.existingExpiresAt === null || input.existingExpiresAt.getTime() > now.getTime());

    if (currentlyActive) {
        return input.existingExpiresAt;
    }

    return resolveShopifyLicenseExpiresAt(input.newPaidAt);
}

export function applyShopifyRefundToOrderSeats(input: {
    currentSeatQuantity: number;
    refundedLicenses: number;
}): { seatQuantity: number; fullyRefunded: boolean } {
    const refunded = Math.max(input.refundedLicenses, 0);
    const seatQuantity = Math.max(input.currentSeatQuantity - refunded, 0);
    return {
        seatQuantity,
        fullyRefunded: seatQuantity <= 0,
    };
}

function lineItemIdToProductId(payload: Record<string, unknown> | null): Map<string, string> {
    const map = new Map<string, string>();
    if (!payload) {
        return map;
    }

    const rawLineItems = payload.line_items;
    if (!Array.isArray(rawLineItems)) {
        return map;
    }

    for (const item of rawLineItems) {
        const lineItem = asRecord(item);
        if (!lineItem) {
            continue;
        }
        const lineItemId = asString(lineItem.id);
        const productId = asString(lineItem.product_id);
        if (lineItemId && productId) {
            map.set(lineItemId, normalizeShopifyProductId(productId));
        }
    }

    return map;
}

export type ShopifyRefundLicenseReduction = {
    hasRefundLineItems: boolean;
    refundedLicenses: number;
    unmappedLineItemCount: number;
};

/**
 * Partial refunds are calculated only when Shopify sends `refund_line_items`.
 * Missing that array is treated as insufficient data (do not guess).
 */
export function parseShopifyRefundLicenseReduction(
    refundPayload: Record<string, unknown>,
    orderPayload: Record<string, unknown> | null
): ShopifyRefundLicenseReduction {
    if (!Array.isArray(refundPayload.refund_line_items)) {
        return {
            hasRefundLineItems: false,
            refundedLicenses: 0,
            unmappedLineItemCount: 0,
        };
    }

    const productIdByLineItemId = lineItemIdToProductId(orderPayload);
    let refundedLicenses = 0;
    let unmappedLineItemCount = 0;

    for (const item of refundPayload.refund_line_items) {
        const refundLine = asRecord(item);
        if (!refundLine) {
            continue;
        }

        const nestedLineItem = asRecord(refundLine.line_item);
        const productIdRaw =
            (nestedLineItem ? asString(nestedLineItem.product_id) : null) ??
            (asString(refundLine.line_item_id)
                ? productIdByLineItemId.get(asString(refundLine.line_item_id) as string) ?? null
                : null);

        if (!productIdRaw) {
            unmappedLineItemCount += 1;
            continue;
        }

        const quantity = asNumber(refundLine.quantity) ?? 0;
        refundedLicenses += resolveLineItemLicenseCount(productIdRaw, quantity);
    }

    return {
        hasRefundLineItems: true,
        refundedLicenses,
        unmappedLineItemCount,
    };
}

export function normalizeShopifyShopDomain(shopDomain: string): string {
    return shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * When a shop domain is configured, incoming webhooks must match it.
 * If no domain is configured, all shops are accepted (local/dev).
 */
export function isExpectedShopifyShopDomain(
    incomingShopDomain: string | null,
    configuredShopDomain: string | undefined
): boolean {
    if (!configuredShopDomain) {
        return true;
    }
    if (!incomingShopDomain) {
        return false;
    }
    return normalizeShopifyShopDomain(incomingShopDomain) === normalizeShopifyShopDomain(configuredShopDomain);
}

/**
 * Verify Shopify webhook HMAC-SHA256 (base64) against the raw request body.
 * @see https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 */
export function verifyShopifyWebhookHmac(
    rawBody: Buffer,
    hmacHeader: string,
    secret: string
): boolean {
    const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
    const digestBuffer = Buffer.from(digest);
    const hmacBuffer = Buffer.from(hmacHeader);

    if (digestBuffer.length !== hmacBuffer.length) {
        return false;
    }

    return timingSafeEqual(digestBuffer, hmacBuffer);
}
