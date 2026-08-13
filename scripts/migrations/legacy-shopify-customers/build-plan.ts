/**
 * Turns a parsed Shopify orders export into a per-customer migration plan.
 *
 * Pure and side-effect free: no database, no filesystem, no clock beyond the
 * grant date passed in. The dry run and (later) the real migration consume the
 * same plan, so what a reviewer approves is exactly what would be written.
 */

import {
    ELIGIBLE_PRODUCTS,
    GRANT_CONFIG,
    ORDER_ELIGIBILITY,
    matchLineItem,
    type EligibleProductRule,
    type ProductFamily,
} from "./product-eligibility";
import type { ParsedCsv, ParsedOrder } from "./orders-csv";

/**
 * Terminal state for a customer row.
 *
 * Ordered by precedence: a customer is reported under the most blocking status
 * that applies to them, with every reason listed in `reviewNotes`.
 */
export const CUSTOMER_STATUSES = [
    "blocked_missing_email",
    "blocked_ambiguous_data",
    "skip_no_qualifying_order",
    "skip_existing_active_workspace",
    "manual_review_venue_kit",
    "manual_review_partial_refund",
    "ready_create_workspace",
] as const;

export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

const STATUS_PRECEDENCE: readonly CustomerStatus[] = CUSTOMER_STATUSES;

export type SkippedProduct = {
    readonly lineItemName: string;
    readonly sku: string;
    readonly rowCount: number;
    readonly totalQuantity: number;
};

export type AmbiguousRow = {
    readonly orderNumber: string;
    readonly shopifyOrderId: string;
    readonly email: string;
    readonly sourceRow: number;
    readonly lineItemName: string;
    readonly reason: string;
};

export type VenueKitPurchase = {
    readonly orderNumber: string;
    readonly shopifyOrderId: string;
    readonly email: string;
    readonly customerName: string;
    readonly product: string;
    readonly quantity: number;
    readonly unitPrice: string;
    readonly createdAt: string;
    readonly reason: string;
};

export type OrderEvaluation = {
    readonly order: ParsedOrder;
    readonly qualifies: boolean;
    /** Why the order was excluded, when it contained an eligible product but did not qualify. */
    readonly exclusionReason: string | null;
    readonly licenses: number;
    /** Eligible products found, whether or not the order qualified. */
    readonly matchedProducts: readonly { rule: EligibleProductRule; quantity: number; licenses: number | null }[];
    readonly hasVenueKit: boolean;
    readonly hasSoftware: boolean;
};

export type PlannedCustomer = {
    /** Normalized (trimmed, lowercased) email, or "" when the export had none. */
    readonly email: string;
    readonly customerName: string;
    readonly company: string;
    readonly qualifyingOrderCount: number;
    readonly licenseQuantity: number;
    readonly firstPurchaseDate: string;
    readonly lastPurchaseDate: string;
    readonly orderNumbers: readonly string[];
    readonly shopifyOrderIds: readonly string[];
    readonly products: readonly string[];
    readonly families: readonly ProductFamily[];
    readonly status: CustomerStatus;
    readonly reviewNotes: readonly string[];
    /** Every order for this customer that contained an eligible product. */
    readonly evaluations: readonly OrderEvaluation[];
};

export type MigrationPlan = {
    readonly totalCsvRows: number;
    readonly totalOrders: number;
    readonly ordersContainingEligibleProducts: number;
    readonly eligibleOrders: number;
    readonly customers: readonly PlannedCustomer[];
    readonly skippedProducts: readonly SkippedProduct[];
    readonly ambiguousRows: readonly AmbiguousRow[];
    readonly venueKitPurchases: readonly VenueKitPurchase[];
    readonly excludedOrders: readonly { orderNumber: string; email: string; reason: string }[];
};

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function isUsableEmail(email: string): boolean {
    return EMAIL_PATTERN.test(email);
}

/** "2026-07-30 16:42:22 -0700" -> Date. Returns null rather than an Invalid Date. */
export function parseShopifyDate(value: string): Date | null {
    if (!value.trim()) return null;
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Calendar date as the merchant sees it in Shopify.
 *
 * The export writes store-local time with an offset ("2026-03-08 19:55:51
 * -0700"). Converting to UTC first would report that order as 2026-03-09 and
 * make the report disagree with the Shopify admin a reviewer is checking it
 * against, so the local date part is taken verbatim.
 */
function toReportDate(value: string): string {
    const trimmed = value.trim();
    return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : "";
}

function pickWorstStatus(statuses: readonly CustomerStatus[]): CustomerStatus {
    for (const candidate of STATUS_PRECEDENCE) {
        if (statuses.includes(candidate)) return candidate;
    }
    return "ready_create_workspace";
}

/** Evaluates one order: which eligible products it holds and whether it qualifies. */
function evaluateOrder(order: ParsedOrder, ambiguousRows: AmbiguousRow[]): OrderEvaluation | null {
    const matchedProducts: { rule: EligibleProductRule; quantity: number; licenses: number | null }[] = [];
    let licenses = 0;
    let sawAmbiguity = false;

    for (const lineItem of order.lineItems) {
        const match = matchLineItem({
            lineItemName: lineItem.name,
            sku: lineItem.sku,
            quantity: lineItem.quantity,
        });

        if (match.outcome === "skipped") continue;

        if (match.outcome === "ambiguous") {
            sawAmbiguity = true;
            ambiguousRows.push({
                orderNumber: order.orderNumber,
                shopifyOrderId: order.shopifyOrderId,
                email: normalizeEmail(order.email),
                sourceRow: lineItem.sourceRow,
                lineItemName: lineItem.name,
                reason: match.reason,
            });
            matchedProducts.push({ rule: match.rule, quantity: lineItem.quantity, licenses: null });
            continue;
        }

        matchedProducts.push({ rule: match.rule, quantity: lineItem.quantity, licenses: match.licenses });
        if (match.licenses !== null) {
            licenses += match.licenses;
        }
    }

    if (matchedProducts.length === 0) return null;

    const financialStatus = order.financialStatus.toLowerCase();
    const isCancelled = ORDER_ELIGIBILITY.excludeCancelled && order.cancelledAt.trim().length > 0;
    const isEligibleStatus = (ORDER_ELIGIBILITY.eligibleFinancialStatuses as readonly string[]).includes(financialStatus);

    let exclusionReason: string | null = null;
    if (isCancelled) {
        exclusionReason = `Order was cancelled on ${order.cancelledAt}`;
    } else if (!isEligibleStatus) {
        exclusionReason = `Financial status "${order.financialStatus || "(blank)"}" is not an eligible status (${ORDER_ELIGIBILITY.eligibleFinancialStatuses.join(", ")})`;
    } else if (sawAmbiguity) {
        exclusionReason = "Order contains a line item flagged as ambiguous";
    }

    return {
        order,
        qualifies: exclusionReason === null,
        exclusionReason,
        licenses,
        matchedProducts,
        hasVenueKit: matchedProducts.some((product) => product.rule.family === "venue_kit"),
        hasSoftware: matchedProducts.some((product) => product.rule.family === "healthage_software"),
    };
}

/**
 * Groups eligible orders into customers.
 *
 * Orders with no usable email are NEVER merged: each gets its own synthetic key,
 * because two different customers with a blank Email column are two customers,
 * not one. They are reported as blocked so a human can supply the address.
 */
export function buildMigrationPlan(csv: ParsedCsv): MigrationPlan {
    const ambiguousRows: AmbiguousRow[] = [];
    const venueKitPurchases: VenueKitPurchase[] = [];
    const excludedOrders: { orderNumber: string; email: string; reason: string }[] = [];
    const skippedProducts = new Map<string, { lineItemName: string; sku: string; rowCount: number; totalQuantity: number }>();

    const grouped = new Map<string, OrderEvaluation[]>();
    let ordersContainingEligibleProducts = 0;
    let eligibleOrders = 0;

    for (const order of csv.orders) {
        const evaluation = evaluateOrder(order, ambiguousRows);

        // Products this order contributed that no rule accepted.
        for (const lineItem of order.lineItems) {
            if (matchLineItem({ lineItemName: lineItem.name, sku: lineItem.sku, quantity: lineItem.quantity }).outcome !== "skipped") {
                continue;
            }
            const key = `${lineItem.name}::${lineItem.sku}`;
            const existing = skippedProducts.get(key);
            if (existing) {
                existing.rowCount++;
                existing.totalQuantity += lineItem.quantity;
            } else {
                skippedProducts.set(key, {
                    lineItemName: lineItem.name,
                    sku: lineItem.sku,
                    rowCount: 1,
                    totalQuantity: lineItem.quantity,
                });
            }
        }

        if (!evaluation) continue;

        ordersContainingEligibleProducts++;
        if (evaluation.qualifies) eligibleOrders++;
        if (evaluation.exclusionReason) {
            excludedOrders.push({
                orderNumber: order.orderNumber,
                email: normalizeEmail(order.email),
                reason: evaluation.exclusionReason,
            });
        }

        for (const product of evaluation.matchedProducts) {
            if (product.rule.family !== "venue_kit" || !evaluation.qualifies) continue;
            const kitLineItem = order.lineItems.find((lineItem) => product.rule.lineItemPattern.test(lineItem.name.trim()));
            venueKitPurchases.push({
                orderNumber: order.orderNumber,
                shopifyOrderId: order.shopifyOrderId,
                email: normalizeEmail(order.email),
                customerName: order.customerName,
                product: product.rule.label,
                quantity: product.quantity,
                unitPrice: kitLineItem?.price ?? "",
                createdAt: order.createdAt,
                reason:
                    product.rule.licenseQuantity.type === "manual_confirmation_required"
                        ? product.rule.licenseQuantity.reason
                        : "Venue kit seat count requires confirmation",
            });
        }

        const email = normalizeEmail(order.email);
        const key = isUsableEmail(email) ? email : `__no_email__:${order.orderNumber}`;
        grouped.set(key, [...(grouped.get(key) ?? []), evaluation]);
    }

    const customers: PlannedCustomer[] = [];

    for (const [key, evaluations] of grouped) {
        const isEmailUsable = !key.startsWith("__no_email__:");
        const qualifying = evaluations.filter((evaluation) => evaluation.qualifies);
        const reviewNotes: string[] = [];
        const statuses: CustomerStatus[] = [];

        if (!isEmailUsable) {
            statuses.push("blocked_missing_email");
            reviewNotes.push(
                `Order ${evaluations[0].order.orderNumber} has no usable Email value in the export (billing name "${evaluations[0].order.customerName || "unknown"}"). An address must be supplied by hand before this customer can be migrated.`
            );
        }

        if (evaluations.some((evaluation) => evaluation.exclusionReason?.startsWith("Order contains a line item flagged as ambiguous"))) {
            statuses.push("blocked_ambiguous_data");
            reviewNotes.push("One or more line items could not be interpreted; see the ambiguous rows section.");
        }

        for (const evaluation of evaluations) {
            if (evaluation.exclusionReason && !evaluation.exclusionReason.startsWith("Order contains a line item")) {
                reviewNotes.push(`Order ${evaluation.order.orderNumber} excluded: ${evaluation.exclusionReason}`);
            }
        }

        if (qualifying.length === 0) {
            statuses.push("skip_no_qualifying_order");
        }

        if (qualifying.some((evaluation) => evaluation.hasVenueKit)) {
            statuses.push("manual_review_venue_kit");
            reviewNotes.push("Includes a Health Expo Screening Kit; its license count is not present in the export and must be confirmed.");
        }

        if (qualifying.some((evaluation) => evaluation.order.financialStatus.toLowerCase() === "partially_refunded")) {
            statuses.push("manual_review_partial_refund");
            reviewNotes.push(
                "Order is partially refunded; the export reports one refund total for the whole order and does not say which line item was refunded."
            );
        }

        const orderNumbers = qualifying.length > 0
            ? qualifying.map((evaluation) => evaluation.order.orderNumber)
            : evaluations.map((evaluation) => evaluation.order.orderNumber);
        const source = qualifying.length > 0 ? qualifying : evaluations;

        // Sorted on the real instant, reported on the store-local calendar date.
        const chronological = [...source]
            .filter((evaluation) => parseShopifyDate(evaluation.order.createdAt) !== null)
            .sort(
                (left, right) =>
                    parseShopifyDate(left.order.createdAt)!.getTime() - parseShopifyDate(right.order.createdAt)!.getTime()
            );

        const products = [
            ...new Set(
                source.flatMap((evaluation) =>
                    evaluation.matchedProducts.map((product) =>
                        product.rule.licenseQuantity.type === "variant_number"
                            ? `${product.rule.label.replace(" - N", "")} - ${product.licenses !== null && product.quantity > 0 ? product.licenses / product.quantity : "?"} x${product.quantity}`
                            : `${product.rule.label} x${product.quantity}`
                    )
                )
            ),
        ];

        const named = source.find((evaluation) => evaluation.order.customerName.trim().length > 0);
        const withCompany = source.find((evaluation) => evaluation.order.company.trim().length > 0);

        customers.push({
            email: isEmailUsable ? key : "",
            customerName: named?.order.customerName ?? "",
            company: withCompany?.order.company ?? "",
            qualifyingOrderCount: qualifying.length,
            licenseQuantity: qualifying.reduce((total, evaluation) => total + evaluation.licenses, 0),
            firstPurchaseDate: chronological.length > 0 ? toReportDate(chronological[0].order.createdAt) : "",
            lastPurchaseDate: chronological.length > 0 ? toReportDate(chronological[chronological.length - 1].order.createdAt) : "",
            orderNumbers,
            shopifyOrderIds: source.map((evaluation) => evaluation.order.shopifyOrderId),
            products,
            families: [...new Set(source.flatMap((evaluation) => evaluation.matchedProducts.map((product) => product.rule.family)))],
            status: pickWorstStatus(statuses),
            reviewNotes,
            evaluations,
        });
    }

    customers.sort((left, right) => left.email.localeCompare(right.email) || left.orderNumbers[0].localeCompare(right.orderNumbers[0]));

    return {
        totalCsvRows: csv.totalDataRows,
        totalOrders: csv.orders.length,
        ordersContainingEligibleProducts,
        eligibleOrders,
        customers,
        skippedProducts: [...skippedProducts.values()].sort((left, right) => left.lineItemName.localeCompare(right.lineItemName)),
        ambiguousRows,
        venueKitPurchases,
        excludedOrders,
    };
}

/** The expiry the real migration would write for a customer, given when it runs. */
export function resolveGrantExpiry(customer: PlannedCustomer, runDate: Date): Date {
    const base =
        GRANT_CONFIG.grantStartsFrom === "last_purchase_date" && customer.lastPurchaseDate
            ? new Date(`${customer.lastPurchaseDate}T00:00:00.000Z`)
            : runDate;

    const expiry = new Date(base);
    expiry.setUTCDate(expiry.getUTCDate() + GRANT_CONFIG.accessDurationDays);
    return expiry;
}

/** Product rules, exported so the dry run can print the configuration it ran with. */
export function describeEligibilityConfig(): string[] {
    return ELIGIBLE_PRODUCTS.map((rule) => {
        const quantity =
            rule.licenseQuantity.type === "variant_number"
                ? "licenses = N from the title x quantity"
                : rule.licenseQuantity.type === "fixed_per_unit"
                  ? `licenses = ${rule.licenseQuantity.seatsPerUnit} x quantity`
                  : "licenses = UNKNOWN (manual confirmation required)";
        return `${rule.label}  [sku ${rule.expectedSkus.join("/") || "n/a"}]  ->  ${quantity}`;
    });
}