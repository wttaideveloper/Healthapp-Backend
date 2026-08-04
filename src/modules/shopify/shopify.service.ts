import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { env } from "@config/env";
import { billingEvents, shopifyOrders, shopifyShops, shopifySubscriptions, users, workspaceMembers, workspaces } from "@db/schema";
import {
    createWorkspaceSmtpTransport,
    getWorkspaceInviteEmailContent,
    inferWorkspaceDisplayName,
} from "@modules/workspace/workspace.email";
import { normalizeEmail } from "@modules/workspace/workspace.util";
import { AUDIT_ACTIONS, AUDIT_TARGETS, recordAuditEvent } from "@modules/audit/audit.service";
import type { ShopifyOrderStatus } from "./shopify.constants";

export type ShopifyWorkspaceOwnerEmail = {
    ownerEmail: string;
    organizationName: string;
    userName: string;
    ownerMembershipStatus: "active" | "invited";
};

export type ShopifyWebhookRecordResult = {
    duplicate: boolean;
    ownerEmail: ShopifyWorkspaceOwnerEmail | null;
};

export const SHOPIFY_ORDER_PAID_TOPIC = "orders/paid";
export const SHOPIFY_ORDER_CANCELLED_TOPIC = "orders/cancelled";
export const SHOPIFY_REFUND_CREATED_TOPIC = "refunds/create";

/** Order topics that upsert order rows (excludes cancel — cancel only updates existing rows). */
export const SHOPIFY_ORDER_UPSERT_WEBHOOK_TOPICS = new Set([
    "orders/create",
    SHOPIFY_ORDER_PAID_TOPIC,
    "orders/updated",
    "orders/fulfilled",
    "orders/partially_fulfilled",
]);

export const SHOPIFY_ORDER_WEBHOOK_TOPICS = new Set([
    ...SHOPIFY_ORDER_UPSERT_WEBHOOK_TOPICS,
    SHOPIFY_ORDER_CANCELLED_TOPIC,
]);

export const SHOPIFY_REFUND_WEBHOOK_TOPICS = new Set([SHOPIFY_REFUND_CREATED_TOPIC]);

/** Subscription lifecycle topics. Accepts Shopify's real slugs and the shorthand aliases. */
export const SHOPIFY_SUBSCRIPTION_CREATED_TOPICS = new Set([
    "subscription-created",
    "subscription_contracts/create",
]);

export const SHOPIFY_SUBSCRIPTION_UPDATED_TOPICS = new Set([
    "subscription-updated",
    "subscription_contracts/update",
]);

export const SHOPIFY_SUBSCRIPTION_CANCELLED_TOPICS = new Set([
    "subscription-cancelled",
    "subscription_contracts/cancel",
]);

export type ShopifyOrderLineItem = {
    productId: string;
    variantId: string;
    variantTitle: string | null;
    productTitle: string;
    quantity: number;
    seatCount: number;
};

export type ParsedShopifyOrderWebhook = {
    shopifyOrderId: string;
    orderNumber: string | null;
    purchaserEmail: string;
    customerName: string | null;
    shopDomain: string;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    currency: string | null;
    totalPrice: string | null;
    seatQuantity: number;
    lineItems: ShopifyOrderLineItem[];
    status: ShopifyOrderStatus;
    payloadJson: Record<string, unknown>;
};

type DbExecutor = Pick<FastifyInstance["db"], "insert" | "select" | "update">;

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

export function isShopifyOrderWebhookTopic(topic: string): boolean {
    return SHOPIFY_ORDER_WEBHOOK_TOPICS.has(topic);
}

export function isShopifyRefundWebhookTopic(topic: string): boolean {
    return SHOPIFY_REFUND_WEBHOOK_TOPICS.has(topic);
}

export type ShopifySubscriptionLifecycle = "created" | "updated" | "cancelled";

export function resolveShopifySubscriptionLifecycle(topic: string): ShopifySubscriptionLifecycle | null {
    if (SHOPIFY_SUBSCRIPTION_CREATED_TOPICS.has(topic)) return "created";
    if (SHOPIFY_SUBSCRIPTION_UPDATED_TOPICS.has(topic)) return "updated";
    if (SHOPIFY_SUBSCRIPTION_CANCELLED_TOPICS.has(topic)) return "cancelled";
    return null;
}

export function isShopifySubscriptionWebhookTopic(topic: string): boolean {
    return resolveShopifySubscriptionLifecycle(topic) !== null;
}

/**
 * Seat count for a single line item.
 * Uses numeric variant title when present; otherwise falls back to quantity.
 * Isolated for future product-metafield mapping.
 */
export function resolveLineItemSeatCount(variantTitle: string | null | undefined, quantity: number): number {
    if (variantTitle) {
        const trimmed = variantTitle.trim();
        if (/^\d+$/.test(trimmed)) {
            return parseInt(trimmed, 10);
        }
    }

    return quantity;
}

export function resolveOrderSeatCount(lineItems: ShopifyOrderLineItem[]): number {
    return lineItems.reduce((total, item) => total + item.seatCount, 0);
}

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

function extractShopifyOrderIdFromPayload(payload: Record<string, unknown>): string | null {
    return asString(payload.id) ?? asString(payload.admin_graphql_api_id);
}

function extractShopifyOrderIdFromRefundPayload(payload: Record<string, unknown>): string | null {
    return asString(payload.order_id);
}

function normalizeShopDomain(shopDomain: string): string {
    return shopDomain.trim().toLowerCase();
}

function normalizePurchaserEmail(email: string): string {
    return email.trim().toLowerCase();
}

function resolveCustomerName(payload: Record<string, unknown>): string | null {
    const customer = asRecord(payload.customer);
    if (customer) {
        const firstName = asString(customer.first_name);
        const lastName = asString(customer.last_name);
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
        if (fullName.length > 0) {
            return fullName;
        }
    }

    const billingAddress = asRecord(payload.billing_address);
    if (billingAddress) {
        const name = asString(billingAddress.name);
        if (name) {
            return name;
        }
    }

    return null;
}

function resolvePurchaserEmail(payload: Record<string, unknown>): string | null {
    const directEmail = asString(payload.email) ?? asString(payload.contact_email);
    if (directEmail) {
        return normalizePurchaserEmail(directEmail);
    }

    const customer = asRecord(payload.customer);
    const customerEmail = customer ? asString(customer.email) : null;
    if (customerEmail) {
        return normalizePurchaserEmail(customerEmail);
    }

    return null;
}

function parseLineItems(payload: Record<string, unknown>): ShopifyOrderLineItem[] {
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

            const productId = asString(lineItem.product_id);
            const variantId = asString(lineItem.variant_id);
            const productTitle = asString(lineItem.title) ?? asString(lineItem.name);
            const quantity = asNumber(lineItem.quantity) ?? 0;

            if (!productId || !variantId || !productTitle) {
                return null;
            }

            const variantTitle = asString(lineItem.variant_title);
            const seatCount = resolveLineItemSeatCount(variantTitle, quantity);

            return {
                productId,
                variantId,
                variantTitle,
                productTitle,
                quantity,
                seatCount,
            };
        })
        .filter((item): item is ShopifyOrderLineItem => item !== null);
}

export function mapShopifyOrderStatus(input: {
    topic: string;
    financialStatus: string | null;
    cancelledAt: string | null;
}): ShopifyOrderStatus {
    if (input.cancelledAt || input.topic === "orders/cancelled") {
        return "cancelled";
    }

    if (input.financialStatus === "refunded" || input.financialStatus === "voided") {
        return "refunded";
    }

    return "pending";
}

export function parseShopifyOrderWebhook(input: {
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
}): ParsedShopifyOrderWebhook {
    const shopifyOrderId = asString(input.payload.id) ?? asString(input.payload.admin_graphql_api_id);
    if (!shopifyOrderId) {
        throw new Error("Shopify order webhook missing order id");
    }

    const purchaserEmail = resolvePurchaserEmail(input.payload);
    if (!purchaserEmail) {
        throw new Error("Shopify order webhook missing purchaser email");
    }

    const lineItems = parseLineItems(input.payload);
    const seatQuantity = resolveOrderSeatCount(lineItems);

    return {
        shopifyOrderId,
        orderNumber: asString(input.payload.order_number) ?? asString(input.payload.name),
        purchaserEmail,
        customerName: resolveCustomerName(input.payload),
        shopDomain: normalizeShopDomain(input.shopDomain),
        financialStatus: asString(input.payload.financial_status),
        fulfillmentStatus: asString(input.payload.fulfillment_status),
        currency: asString(input.payload.currency),
        totalPrice: asString(input.payload.total_price),
        seatQuantity,
        lineItems,
        status: mapShopifyOrderStatus({
            topic: input.topic,
            financialStatus: asString(input.payload.financial_status),
            cancelledAt: asString(input.payload.cancelled_at),
        }),
        payloadJson: input.payload,
    };
}

export async function upsertShopifyShop(
    db: DbExecutor,
    shopDomain: string
): Promise<{ id: string; shopDomain: string }> {
    const normalizedDomain = normalizeShopDomain(shopDomain);
    const now = new Date();

    const [existingShop] = await db
        .select({ id: shopifyShops.id, shopDomain: shopifyShops.shopDomain })
        .from(shopifyShops)
        .where(eq(shopifyShops.shopDomain, normalizedDomain))
        .limit(1);

    if (existingShop) {
        await db
            .update(shopifyShops)
            .set({ updatedAt: now })
            .where(eq(shopifyShops.id, existingShop.id));

        return existingShop;
    }

    const [insertedShop] = await db
        .insert(shopifyShops)
        .values({
            shopifyShopId: normalizedDomain,
            shopDomain: normalizedDomain,
            status: "active",
        })
        .returning({ id: shopifyShops.id, shopDomain: shopifyShops.shopDomain });

    if (!insertedShop) {
        throw new Error("Failed to create Shopify shop record");
    }

    return insertedShop;
}

export async function saveShopifyOrder(
    db: DbExecutor,
    input: {
        shopId: string;
        order: ParsedShopifyOrderWebhook;
    }
): Promise<{ id: string; shopifyOrderId: string }> {
    const now = new Date();

    const [savedOrder] = await db
        .insert(shopifyOrders)
        .values({
            shopId: input.shopId,
            workspaceId: null,
            shopifyOrderId: input.order.shopifyOrderId,
            orderNumber: input.order.orderNumber,
            purchaserEmail: input.order.purchaserEmail,
            financialStatus: input.order.financialStatus,
            fulfillmentStatus: input.order.fulfillmentStatus,
            seatQuantity: input.order.seatQuantity,
            currency: input.order.currency,
            totalPrice: input.order.totalPrice,
            status: input.order.status,
            payloadJson: input.order.payloadJson,
        })
        .onConflictDoUpdate({
            target: shopifyOrders.shopifyOrderId,
            set: {
                orderNumber: input.order.orderNumber,
                purchaserEmail: input.order.purchaserEmail,
                financialStatus: input.order.financialStatus,
                fulfillmentStatus: input.order.fulfillmentStatus,
                seatQuantity: input.order.seatQuantity,
                currency: input.order.currency,
                totalPrice: input.order.totalPrice,
                status: input.order.status,
                payloadJson: input.order.payloadJson,
                updatedAt: now,
            },
        })
        .returning({ id: shopifyOrders.id, shopifyOrderId: shopifyOrders.shopifyOrderId });

    if (!savedOrder) {
        throw new Error("Failed to save Shopify order");
    }

    return savedOrder;
}

function resolveShopifyWorkspaceName(order: ParsedShopifyOrderWebhook): string {
    if (order.customerName && order.customerName.trim().length >= 2) {
        return order.customerName.trim();
    }

    if (order.orderNumber) {
        return `Organization ${order.orderNumber}`;
    }

    const localPart = order.purchaserEmail.split("@")[0] ?? "Organization";
    return `${localPart}'s Organization`;
}

async function findUserByEmail(
    db: DbExecutor,
    email: string
): Promise<{ id: string; name: string; email: string } | null> {
    const [existingUser] = await db
        .select({
            id: users.id,
            name: users.name,
            email: users.email,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

    return existingUser ?? null;
}

async function loadShopifyOrderRecord(
    db: DbExecutor,
    shopifyOrderRecordId: string
): Promise<{
    id: string;
    shopifyOrderId: string;
    workspaceId: string | null;
    purchaserEmail: string;
    seatQuantity: number;
    orderNumber: string | null;
} | null> {
    const [savedOrder] = await db
        .select({
            id: shopifyOrders.id,
            shopifyOrderId: shopifyOrders.shopifyOrderId,
            workspaceId: shopifyOrders.workspaceId,
            purchaserEmail: shopifyOrders.purchaserEmail,
            seatQuantity: shopifyOrders.seatQuantity,
            orderNumber: shopifyOrders.orderNumber,
        })
        .from(shopifyOrders)
        .where(eq(shopifyOrders.id, shopifyOrderRecordId))
        .limit(1);

    return savedOrder ?? null;
}

async function findShopifyOrderByShopifyOrderId(
    db: DbExecutor,
    shopifyOrderId: string
): Promise<{
    id: string;
    shopifyOrderId: string;
    workspaceId: string | null;
    status: string;
} | null> {
    const [savedOrder] = await db
        .select({
            id: shopifyOrders.id,
            shopifyOrderId: shopifyOrders.shopifyOrderId,
            workspaceId: shopifyOrders.workspaceId,
            status: shopifyOrders.status,
        })
        .from(shopifyOrders)
        .where(eq(shopifyOrders.shopifyOrderId, shopifyOrderId))
        .limit(1);

    return savedOrder ?? null;
}

/**
 * Revokes future workspace access without deleting the workspace or members.
 * Uses "canceled" to match workspaceSubscriptionStatuses / entitlement checks.
 */
async function revokeWorkspaceAccessFromShopifyOrder(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: {
        workspaceId: string;
        shopifyOrderId: string;
        reason: "cancelled" | "refunded";
    }
): Promise<void> {
    const now = new Date();

    await db
        .update(workspaces)
        .set({
            subscriptionStatus: "canceled",
            updatedAt: now,
        })
        .where(eq(workspaces.id, input.workspaceId));

    await recordAuditEvent(db, log, {
        action: AUDIT_ACTIONS.WORKSPACE_CANCELLED_SHOPIFY,
        target: { type: AUDIT_TARGETS.WORKSPACE, id: input.workspaceId },
        workspace: { id: input.workspaceId },
        metadata: {
            shopifyOrderId: input.shopifyOrderId,
            reason: input.reason,
            subscriptionStatus: "canceled",
        },
    });

    log.info(
        {
            workspaceId: input.workspaceId,
            shopifyOrderId: input.shopifyOrderId,
            reason: input.reason,
            subscriptionStatus: "canceled",
        },
        "Revoked Shopify workspace access"
    );
}

export async function handleShopifyOrderCancelled(
    db: DbExecutor,
    log: FastifyBaseLogger,
    payload: Record<string, unknown>
): Promise<void> {
    const shopifyOrderId = extractShopifyOrderIdFromPayload(payload);
    if (!shopifyOrderId) {
        log.warn({ topic: SHOPIFY_ORDER_CANCELLED_TOPIC }, "orders/cancelled webhook missing order id");
        return;
    }

    const existingOrder = await findShopifyOrderByShopifyOrderId(db, shopifyOrderId);
    if (!existingOrder) {
        log.info(
            { shopifyOrderId, topic: SHOPIFY_ORDER_CANCELLED_TOPIC },
            "Ignoring orders/cancelled: Shopify order not found"
        );
        return;
    }

    const now = new Date();
    const financialStatus = asString(payload.financial_status);

    await db
        .update(shopifyOrders)
        .set({
            status: "cancelled",
            ...(financialStatus ? { financialStatus } : {}),
            updatedAt: now,
        })
        .where(eq(shopifyOrders.id, existingOrder.id));

    log.info(
        {
            shopifyOrderId,
            shopifyOrderRecordId: existingOrder.id,
            workspaceId: existingOrder.workspaceId,
            status: "cancelled",
        },
        "Updated Shopify order status to cancelled"
    );

    if (!existingOrder.workspaceId) {
        log.info(
            { shopifyOrderId, shopifyOrderRecordId: existingOrder.id },
            "orders/cancelled: no linked workspace to revoke"
        );
        return;
    }

    await revokeWorkspaceAccessFromShopifyOrder(db, log, {
        workspaceId: existingOrder.workspaceId,
        shopifyOrderId,
        reason: "cancelled",
    });
}

export async function handleShopifyRefundCreated(
    db: DbExecutor,
    log: FastifyBaseLogger,
    payload: Record<string, unknown>
): Promise<void> {
    const shopifyOrderId = extractShopifyOrderIdFromRefundPayload(payload);
    if (!shopifyOrderId) {
        log.warn(
            { topic: SHOPIFY_REFUND_CREATED_TOPIC },
            "refunds/create webhook missing order_id"
        );
        return;
    }

    const existingOrder = await findShopifyOrderByShopifyOrderId(db, shopifyOrderId);
    if (!existingOrder) {
        log.info(
            { shopifyOrderId, topic: SHOPIFY_REFUND_CREATED_TOPIC },
            "Ignoring refunds/create: Shopify order not found"
        );
        return;
    }

    const now = new Date();

    await db
        .update(shopifyOrders)
        .set({
            status: "refunded",
            financialStatus: "refunded",
            updatedAt: now,
        })
        .where(eq(shopifyOrders.id, existingOrder.id));

    log.info(
        {
            shopifyOrderId,
            shopifyOrderRecordId: existingOrder.id,
            workspaceId: existingOrder.workspaceId,
            refundId: asString(payload.id),
            status: "refunded",
        },
        "Updated Shopify order status to refunded"
    );

    if (!existingOrder.workspaceId) {
        log.info(
            { shopifyOrderId, shopifyOrderRecordId: existingOrder.id },
            "refunds/create: no linked workspace to revoke"
        );
        return;
    }

    await revokeWorkspaceAccessFromShopifyOrder(db, log, {
        workspaceId: existingOrder.workspaceId,
        shopifyOrderId,
        reason: "refunded",
    });
}

export async function provisionWorkspaceFromShopifyPaidOrder(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: {
        shopifyOrderRecordId: string;
        shopId: string;
        order: ParsedShopifyOrderWebhook;
    }
): Promise<ShopifyWorkspaceOwnerEmail | null> {
    const savedOrder = await loadShopifyOrderRecord(db, input.shopifyOrderRecordId);
    if (!savedOrder) {
        throw new Error(`Shopify order record not found: ${input.shopifyOrderRecordId}`);
    }

    if (savedOrder.workspaceId) {
        log.info(
            {
                shopifyOrderId: savedOrder.shopifyOrderId,
                workspaceId: savedOrder.workspaceId,
            },
            "Workspace already exists for Shopify order"
        );
        return null;
    }

    if (savedOrder.seatQuantity <= 0) {
        throw new Error(`Shopify order ${savedOrder.shopifyOrderId} has invalid seat quantity`);
    }

    const ownerEmail = normalizeEmail(savedOrder.purchaserEmail);
    const existingUser = await findUserByEmail(db, ownerEmail);

    if (existingUser) {
        log.info(
            { userId: existingUser.id, email: ownerEmail, shopifyOrderId: savedOrder.shopifyOrderId },
            "Owner found for Shopify workspace provisioning"
        );
    } else {
        log.info(
            { email: ownerEmail, shopifyOrderId: savedOrder.shopifyOrderId },
            "Owner invited for Shopify workspace provisioning"
        );
    }

    const now = new Date();
    const workspaceName = resolveShopifyWorkspaceName(input.order);

    const [workspace] = await db
        .insert(workspaces)
        .values({
            name: workspaceName,
            ownerEmail,
            ownerUserId: existingUser?.id ?? null,
            seatLimit: savedOrder.seatQuantity,
            plan: "organization",
            subscriptionStatus: "active",
            status: "active",
            billingSource: "shopify",
            shopifyShopId: input.shopId,
            isProvisionedExternally: true,
            createdByUserId: null,
            expiresAt: null,
            notes: savedOrder.orderNumber
                ? `Shopify order ${savedOrder.orderNumber}`
                : `Shopify order ${savedOrder.shopifyOrderId}`,
        })
        .returning({ id: workspaces.id });

    if (!workspace) {
        throw new Error(`Failed to create workspace for Shopify order ${savedOrder.shopifyOrderId}`);
    }

    await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: existingUser?.id ?? null,
        email: ownerEmail,
        role: "owner",
        status: existingUser ? "active" : "invited",
        invitedByUserId: null,
        joinedAt: existingUser ? now : null,
    });

    await db
        .update(shopifyOrders)
        .set({
            workspaceId: workspace.id,
            updatedAt: now,
        })
        .where(eq(shopifyOrders.id, savedOrder.id));

    const ownerMembershipStatus = existingUser ? ("active" as const) : ("invited" as const);

    // No actor: this is a provider webhook, not a person. Recording a null actor
    // is honest; attributing it to an admin would not be.
    await recordAuditEvent(db, log, {
        action: AUDIT_ACTIONS.WORKSPACE_PROVISIONED_SHOPIFY,
        target: { type: AUDIT_TARGETS.WORKSPACE, id: workspace.id, label: workspaceName },
        workspace: { id: workspace.id, name: workspaceName },
        metadata: {
            shopifyOrderId: savedOrder.shopifyOrderId,
            orderNumber: savedOrder.orderNumber,
            ownerEmail,
            seatLimit: savedOrder.seatQuantity,
            ownerMembershipStatus,
        },
    });

    log.info(
        {
            workspaceId: workspace.id,
            shopifyOrderId: savedOrder.shopifyOrderId,
            ownerEmail,
            seatLimit: savedOrder.seatQuantity,
            ownerMembershipStatus,
        },
        "Workspace created from Shopify order"
    );

    return {
        ownerEmail,
        organizationName: workspaceName,
        userName: inferWorkspaceDisplayName(ownerEmail, existingUser?.name ?? input.order.customerName),
        ownerMembershipStatus,
    };
}

export async function sendShopifyWorkspaceOwnerWelcomeEmail(
    log: FastifyBaseLogger,
    input: ShopifyWorkspaceOwnerEmail
): Promise<void> {
    const subject =
        input.ownerMembershipStatus === "active"
            ? "Your organization has been created."
            : "Complete registration to access your workspace.";

    try {
        const smtpTransport = createWorkspaceSmtpTransport();
        const ownerMail = getWorkspaceInviteEmailContent({
            organizationName: input.organizationName,
            userName: input.userName,
            userEmail: input.ownerEmail,
            isOwner: true,
            subject,
        });

        await smtpTransport.sendMail({
            from: env.EMAIL_FROM ?? env.SMTP_USER,
            to: input.ownerEmail,
            subject: ownerMail.subject,
            text: ownerMail.text,
            html: ownerMail.html,
        });

        log.info(
            {
                to: input.ownerEmail,
                subject,
                ownerMembershipStatus: input.ownerMembershipStatus,
            },
            "Sent Shopify workspace owner email"
        );
    } catch (error) {
        log.error(
            {
                err: error,
                to: input.ownerEmail,
                ownerMembershipStatus: input.ownerMembershipStatus,
            },
            "Failed to send Shopify workspace owner email"
        );
    }
}

export async function processShopifyOrderWebhook(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: {
        topic: string;
        shopDomain: string;
        payload: Record<string, unknown>;
    }
): Promise<ShopifyWorkspaceOwnerEmail | null> {
    const order = parseShopifyOrderWebhook({
        topic: input.topic,
        shopDomain: input.shopDomain,
        payload: input.payload,
    });

    log.info(
        {
            shopifyOrderId: order.shopifyOrderId,
            orderNumber: order.orderNumber,
            purchaserEmail: order.purchaserEmail,
            customerName: order.customerName,
            shopDomain: order.shopDomain,
            seatQuantity: order.seatQuantity,
            lineItemCount: order.lineItems.length,
            status: order.status,
        },
        "Parsed Shopify order webhook"
    );

    const shop = await upsertShopifyShop(db, order.shopDomain);
    const savedOrder = await saveShopifyOrder(db, { shopId: shop.id, order });

    log.info(
        {
            shopifyOrderId: savedOrder.shopifyOrderId,
            shopifyOrderRecordId: savedOrder.id,
            shopId: shop.id,
            seatQuantity: order.seatQuantity,
            status: order.status,
        },
        "Saved Shopify order"
    );

    if (input.topic === SHOPIFY_ORDER_PAID_TOPIC) {
        return provisionWorkspaceFromShopifyPaidOrder(db, log, {
            shopifyOrderRecordId: savedOrder.id,
            shopId: shop.id,
            order,
        });
    }

    return null;
}

export type ParsedShopifySubscriptionWebhook = {
    shopifySubscriptionId: string;
    purchaserEmail: string | null;
    status: string;
    currentPeriodEnd: Date | null;
    expiresAt: Date | null;
    seatQuantity: number;
    autoRenewing: boolean;
    cancelAtPeriodEnd: boolean;
    payloadJson: Record<string, unknown>;
};

function resolveSubscriptionSeatQuantity(payload: Record<string, unknown>): number {
    const lineItems = parseLineItems(payload);
    if (lineItems.length > 0) {
        return resolveOrderSeatCount(lineItems);
    }

    return asNumber(payload.quantity) ?? asNumber(payload.seats) ?? 0;
}

/** Maps a raw Shopify subscription status onto the workspace subscription vocabulary. */
function mapShopifySubscriptionToWorkspaceStatus(status: string): string {
    const normalized = status.trim().toLowerCase();
    if (["active", "live"].includes(normalized)) return "active";
    if (["trialing", "trial"].includes(normalized)) return "trialing";
    if (["past_due", "paused"].includes(normalized)) return "past_due";
    if (["expired"].includes(normalized)) return "expired";
    if (["cancelled", "canceled"].includes(normalized)) return "canceled";
    return "active";
}

export function parseShopifySubscriptionWebhook(input: {
    topic: string;
    payload: Record<string, unknown>;
}): ParsedShopifySubscriptionWebhook {
    const shopifySubscriptionId =
        asString(input.payload.id) ?? asString(input.payload.admin_graphql_api_id);
    if (!shopifySubscriptionId) {
        throw new Error("Shopify subscription webhook missing subscription id");
    }

    const currentPeriodEnd =
        asDate(input.payload.next_billing_date) ??
        asDate(input.payload.current_period_end) ??
        asDate(input.payload.billing_next_date);

    const expiresAt =
        asDate(input.payload.expires_at) ??
        asDate(input.payload.end_date) ??
        currentPeriodEnd;

    const status = asString(input.payload.status) ?? "active";
    const cancelAtPeriodEnd = input.payload.cancel_at_period_end === true;

    return {
        shopifySubscriptionId,
        purchaserEmail: resolvePurchaserEmail(input.payload),
        status,
        currentPeriodEnd,
        expiresAt,
        seatQuantity: resolveSubscriptionSeatQuantity(input.payload),
        autoRenewing: mapShopifySubscriptionToWorkspaceStatus(status) === "active" && !cancelAtPeriodEnd,
        cancelAtPeriodEnd,
        payloadJson: input.payload,
    };
}

async function findShopifySubscriptionBySubscriptionId(
    db: DbExecutor,
    shopifySubscriptionId: string
): Promise<{ id: string; workspaceId: string | null; seatQuantity: number; status: string } | null> {
    const [existing] = await db
        .select({
            id: shopifySubscriptions.id,
            workspaceId: shopifySubscriptions.workspaceId,
            seatQuantity: shopifySubscriptions.seatQuantity,
            status: shopifySubscriptions.status,
        })
        .from(shopifySubscriptions)
        .where(eq(shopifySubscriptions.shopifySubscriptionId, shopifySubscriptionId))
        .limit(1);

    return existing ?? null;
}

async function findShopifyWorkspaceIdByOwnerEmail(
    db: DbExecutor,
    email: string
): Promise<string | null> {
    const [workspace] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.ownerEmail, email), eq(workspaces.billingSource, "shopify")))
        .orderBy(desc(workspaces.updatedAt))
        .limit(1);

    return workspace?.id ?? null;
}

export async function handleShopifySubscriptionCreated(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: { shopId: string; subscription: ParsedShopifySubscriptionWebhook }
): Promise<void> {
    const { subscription } = input;

    const existing = await findShopifySubscriptionBySubscriptionId(db, subscription.shopifySubscriptionId);

    let linkedWorkspaceId = existing?.workspaceId ?? null;
    if (!linkedWorkspaceId && subscription.purchaserEmail) {
        linkedWorkspaceId = await findShopifyWorkspaceIdByOwnerEmail(db, subscription.purchaserEmail);
    }

    const now = new Date();
    const providerStatus = subscription.status;

    await db
        .insert(shopifySubscriptions)
        .values({
            shopId: input.shopId,
            workspaceId: linkedWorkspaceId,
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            status: subscription.status,
            seatQuantity: subscription.seatQuantity,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            providerStatus,
            autoRenewing: subscription.autoRenewing,
            payloadJson: subscription.payloadJson,
        })
        .onConflictDoUpdate({
            target: shopifySubscriptions.shopifySubscriptionId,
            set: {
                workspaceId: linkedWorkspaceId,
                status: subscription.status,
                seatQuantity: subscription.seatQuantity,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                providerStatus,
                autoRenewing: subscription.autoRenewing,
                payloadJson: subscription.payloadJson,
                updatedAt: now,
            },
        });

    log.info(
        {
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            workspaceId: linkedWorkspaceId,
            status: subscription.status,
            seatQuantity: subscription.seatQuantity,
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
            expiresAt: subscription.expiresAt?.toISOString() ?? null,
        },
        "Shopify subscription created"
    );

    if (!linkedWorkspaceId) {
        return;
    }

    await db
        .update(workspaces)
        .set({
            subscriptionStatus: "active",
            ...(subscription.expiresAt ? { expiresAt: subscription.expiresAt } : {}),
            updatedAt: now,
        })
        .where(eq(workspaces.id, linkedWorkspaceId));

    log.info(
        {
            workspaceId: linkedWorkspaceId,
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            subscriptionStatus: "active",
            expiresAt: subscription.expiresAt?.toISOString() ?? null,
        },
        "Workspace updated from Shopify subscription created"
    );
}

export async function handleShopifySubscriptionUpdated(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: { subscription: ParsedShopifySubscriptionWebhook }
): Promise<void> {
    const { subscription } = input;

    const existing = await findShopifySubscriptionBySubscriptionId(db, subscription.shopifySubscriptionId);
    if (!existing) {
        log.warn(
            { shopifySubscriptionId: subscription.shopifySubscriptionId },
            "Shopify subscription not found for update"
        );
        return;
    }

    const now = new Date();
    const seatChanged = subscription.seatQuantity > 0 && subscription.seatQuantity !== existing.seatQuantity;

    await db
        .update(shopifySubscriptions)
        .set({
            status: subscription.status,
            seatQuantity: seatChanged ? subscription.seatQuantity : existing.seatQuantity,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            providerStatus: subscription.status,
            autoRenewing: subscription.autoRenewing,
            payloadJson: subscription.payloadJson,
            updatedAt: now,
        })
        .where(eq(shopifySubscriptions.id, existing.id));

    log.info(
        {
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            workspaceId: existing.workspaceId,
            status: subscription.status,
            seatQuantity: seatChanged ? subscription.seatQuantity : existing.seatQuantity,
            seatChanged,
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
            expiresAt: subscription.expiresAt?.toISOString() ?? null,
        },
        "Shopify subscription updated"
    );

    if (!existing.workspaceId) {
        return;
    }

    await db
        .update(workspaces)
        .set({
            subscriptionStatus: mapShopifySubscriptionToWorkspaceStatus(subscription.status),
            ...(seatChanged ? { seatLimit: subscription.seatQuantity } : {}),
            ...(subscription.expiresAt ? { expiresAt: subscription.expiresAt } : {}),
            updatedAt: now,
        })
        .where(eq(workspaces.id, existing.workspaceId));

    log.info(
        {
            workspaceId: existing.workspaceId,
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            subscriptionStatus: mapShopifySubscriptionToWorkspaceStatus(subscription.status),
            seatLimit: seatChanged ? subscription.seatQuantity : undefined,
            expiresAt: subscription.expiresAt?.toISOString() ?? null,
        },
        "Workspace updated from Shopify subscription updated"
    );
}

export async function handleShopifySubscriptionCancelled(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: { subscription: ParsedShopifySubscriptionWebhook }
): Promise<void> {
    const { subscription } = input;

    const existing = await findShopifySubscriptionBySubscriptionId(db, subscription.shopifySubscriptionId);
    if (!existing) {
        log.warn(
            { shopifySubscriptionId: subscription.shopifySubscriptionId },
            "Shopify subscription not found for cancellation"
        );
        return;
    }

    const now = new Date();

    await db
        .update(shopifySubscriptions)
        .set({
            status: "cancelled",
            providerStatus: subscription.status,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            autoRenewing: false,
            payloadJson: subscription.payloadJson,
            updatedAt: now,
        })
        .where(eq(shopifySubscriptions.id, existing.id));

    log.info(
        {
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            workspaceId: existing.workspaceId,
            status: "cancelled",
        },
        "Shopify subscription cancelled"
    );

    if (!existing.workspaceId) {
        return;
    }

    await db
        .update(workspaces)
        .set({
            subscriptionStatus: "canceled",
            updatedAt: now,
        })
        .where(eq(workspaces.id, existing.workspaceId));

    await recordAuditEvent(db, log, {
        action: AUDIT_ACTIONS.WORKSPACE_CANCELLED_SHOPIFY,
        target: { type: AUDIT_TARGETS.WORKSPACE, id: existing.workspaceId },
        workspace: { id: existing.workspaceId },
        metadata: {
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            reason: "subscription_cancelled",
            subscriptionStatus: "canceled",
        },
    });

    log.info(
        {
            workspaceId: existing.workspaceId,
            shopifySubscriptionId: subscription.shopifySubscriptionId,
            subscriptionStatus: "canceled",
        },
        "Workspace updated from Shopify subscription cancelled"
    );
}

export async function processShopifySubscriptionWebhook(
    db: DbExecutor,
    log: FastifyBaseLogger,
    input: {
        lifecycle: ShopifySubscriptionLifecycle;
        shopDomain: string | null;
        payload: Record<string, unknown>;
    }
): Promise<void> {
    const subscription = parseShopifySubscriptionWebhook({
        topic: input.lifecycle,
        payload: input.payload,
    });

    if (input.lifecycle === "created") {
        if (!input.shopDomain) {
            throw new Error("Missing X-Shopify-Shop-Domain header for Shopify subscription webhook");
        }

        const shop = await upsertShopifyShop(db, input.shopDomain);
        await handleShopifySubscriptionCreated(db, log, { shopId: shop.id, subscription });
        return;
    }

    if (input.lifecycle === "updated") {
        await handleShopifySubscriptionUpdated(db, log, { subscription });
        return;
    }

    await handleShopifySubscriptionCancelled(db, log, { subscription });
}

export async function recordShopifyWebhookEvent(
    app: FastifyInstance,
    input: {
        webhookId: string;
        topic: string;
        payloadJson: Record<string, unknown>;
        shopDomain: string | null;
        log: FastifyBaseLogger;
    }
): Promise<ShopifyWebhookRecordResult> {
    let ownerEmail: ShopifyWorkspaceOwnerEmail | null = null;

    const duplicate = await app.db.transaction(async (tx) => {
        const [insertedEvent] = await tx
            .insert(billingEvents)
            .values({
                provider: "shopify",
                eventId: input.webhookId,
                eventType: input.topic,
                payloadJson: input.payloadJson,
            })
            .onConflictDoNothing()
            .returning({ id: billingEvents.id });

        if (!insertedEvent) {
            return true;
        }

        const subscriptionLifecycle = resolveShopifySubscriptionLifecycle(input.topic);

        if (input.topic === SHOPIFY_ORDER_CANCELLED_TOPIC) {
            await handleShopifyOrderCancelled(tx, input.log, input.payloadJson);
        } else if (isShopifyRefundWebhookTopic(input.topic)) {
            await handleShopifyRefundCreated(tx, input.log, input.payloadJson);
        } else if (subscriptionLifecycle) {
            await processShopifySubscriptionWebhook(tx, input.log, {
                lifecycle: subscriptionLifecycle,
                shopDomain: input.shopDomain,
                payload: input.payloadJson,
            });
        } else if (isShopifyOrderWebhookTopic(input.topic)) {
            if (!input.shopDomain) {
                throw new Error("Missing X-Shopify-Shop-Domain header for Shopify order webhook");
            }

            ownerEmail = await processShopifyOrderWebhook(tx, input.log, {
                topic: input.topic,
                shopDomain: input.shopDomain,
                payload: input.payloadJson,
            });
        } else {
            input.log.info(
                { webhookId: input.webhookId, topic: input.topic, shopDomain: input.shopDomain },
                "Recorded Shopify webhook without order processing"
            );
        }

        return false;
    });

    return { duplicate, ownerEmail };
}
