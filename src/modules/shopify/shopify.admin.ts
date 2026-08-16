import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { shopifyOrders, shopifyShops } from "@db/schema";
import type { SelectWorkspace } from "@db/schema/workspaces";
import { countNonRevokedWorkspaceSeats } from "@modules/workspace/workspace.seats";

import {
    extractShopifyCustomerIdFromOrderPayloads,
    resolvePurchasedLicenseTotal,
    serializeShopifyOrderForAdmin,
    summarizeWorkspaceLicenseAllocation,
    type ShopifyAdminOrderView,
    type WorkspaceLicenseAllocation,
} from "./shopify.license";

type AdminDb = Pick<FastifyInstance["db"], "select">;

export type WorkspaceLicensingView = WorkspaceLicenseAllocation & {
    workspaceId: string;
    billingSource: string;
    shopifyShopId: string | null;
    shopDomain: string | null;
    shopifyCustomerId: string | null;
    expiresAt: string | null;
    subscriptionStatus: string;
    shopifyOrderCount: number;
    latestShopifyOrder: ShopifyAdminOrderView | null;
};

async function loadShopifyShopIdentity(
    db: AdminDb,
    shopifyShopId: string | null
): Promise<{ shopifyShopId: string | null; shopDomain: string | null }> {
    if (!shopifyShopId) {
        return { shopifyShopId: null, shopDomain: null };
    }

    const [shop] = await db
        .select({
            shopifyShopId: shopifyShops.shopifyShopId,
            shopDomain: shopifyShops.shopDomain,
        })
        .from(shopifyShops)
        .where(eq(shopifyShops.id, shopifyShopId))
        .limit(1);

    return {
        shopifyShopId: shop?.shopifyShopId ?? null,
        shopDomain: shop?.shopDomain ?? null,
    };
}

export async function loadWorkspaceShopifyOrders(db: AdminDb, workspaceId: string) {
    return db
        .select({
            shopifyOrderId: shopifyOrders.shopifyOrderId,
            orderNumber: shopifyOrders.orderNumber,
            status: shopifyOrders.status,
            financialStatus: shopifyOrders.financialStatus,
            fulfillmentStatus: shopifyOrders.fulfillmentStatus,
            seatQuantity: shopifyOrders.seatQuantity,
            createdAt: shopifyOrders.createdAt,
            payloadJson: shopifyOrders.payloadJson,
        })
        .from(shopifyOrders)
        .where(eq(shopifyOrders.workspaceId, workspaceId))
        .orderBy(desc(shopifyOrders.createdAt));
}

export function serializeWorkspaceShopifyOrders(
    orders: Awaited<ReturnType<typeof loadWorkspaceShopifyOrders>>
): ShopifyAdminOrderView[] {
    return orders.map(serializeShopifyOrderForAdmin);
}

export async function loadWorkspaceLicensingView(
    db: AdminDb,
    workspace: SelectWorkspace
): Promise<WorkspaceLicensingView> {
    const [assignedLicenses, orders, shop] = await Promise.all([
        countNonRevokedWorkspaceSeats(db, workspace.id),
        loadWorkspaceShopifyOrders(db, workspace.id),
        loadShopifyShopIdentity(db, workspace.shopifyShopId),
    ]);

    const totalLicenses = resolvePurchasedLicenseTotal({
        seatLimit: workspace.seatLimit,
        orders,
    });
    const allocation = summarizeWorkspaceLicenseAllocation({
        totalLicenses,
        assignedLicenses,
    });
    const serializedOrders = serializeWorkspaceShopifyOrders(orders);

    return {
        workspaceId: workspace.id,
        billingSource: workspace.billingSource,
        shopifyShopId: shop.shopifyShopId,
        shopDomain: shop.shopDomain,
        shopifyCustomerId: extractShopifyCustomerIdFromOrderPayloads(orders.map((order) => order.payloadJson)),
        expiresAt: workspace.expiresAt?.toISOString() ?? null,
        subscriptionStatus: workspace.subscriptionStatus,
        shopifyOrderCount: orders.length,
        latestShopifyOrder: serializedOrders[0] ?? null,
        ...allocation,
    };
}
