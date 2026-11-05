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

/** One venue kit line item in an order that qualified on its own merits. */
export type VenueKitPurchase = {
    readonly orderNumber: string;
    readonly shopifyOrderId: string;
    readonly email: string;
    readonly customerName: string;
    readonly product: string;
    readonly quantity: number;
    readonly licenses: number;
    readonly unitPrice: string;
    readonly createdAt: string;
    /** What happens to the purchaser: `ready_create_workspace`, or why not. */
    readonly customerStatus: CustomerStatus;
};

export type MatchedProduct = {
    readonly rule: EligibleProductRule;
    readonly quantity: number;
    /** `null` only for an ambiguous line, whose license count is unknown. */
    readonly licenses: number | null;
    readonly unitPrice: string;
};

export type OrderEvaluation = {
    readonly order: ParsedOrder;
    readonly qualifies: boolean;
    /** Why the order was excluded, when it contained an eligible product but did not qualify. */
    readonly exclusionReason: string | null;
    readonly licenses: number;
    /** Eligible products found, whether or not the order qualified. */
    readonly matchedProducts: readonly MatchedProduct[];
    readonly hasVenueKit: boolean;
    readonly hasSoftware: boolean;
};

/** Licenses a set of customers would receive from one product. */
export type ProductLicenseTotals = {
    readonly ruleId: string;
    readonly label: string;
    readonly family: ProductFamily;
    readonly customers: number;
    readonly orders: number;
    /** Sum of line-item quantities (units purchased). */
    readonly units: number;
    readonly licenses: number;
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

/**
 * True when the order has been partly refunded and the export cannot say which
 * line was refunded. Besides Shopify's own `partially_refunded` status this
 * catches a `paid` order carrying a Refunded Amount, where status and amount
 * disagree. Either way the refund allocation is not guessed.
 */
export function isPartiallyRefunded(order: Pick<ParsedOrder, "financialStatus" | "refundedAmount">): boolean {
    const status = order.financialStatus.trim().toLowerCase();
    return status === "partially_refunded" || (status === "paid" && order.refundedAmount > 0);
}

/** Evaluates one order: which eligible products it holds and whether it qualifies. */
function evaluateOrder(order: ParsedOrder, ambiguousRows: AmbiguousRow[]): OrderEvaluation | null {
    const matchedProducts: MatchedProduct[] = [];
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
            matchedProducts.push({ rule: match.rule, quantity: lineItem.quantity, licenses: null, unitPrice: lineItem.price });
            continue;
        }

        matchedProducts.push({ rule: match.rule, quantity: lineItem.quantity, licenses: match.licenses, unitPrice: lineItem.price });
        licenses += match.licenses;
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
    // Kit lines are collected while orders are evaluated; their customer status is only
    // known once orders have been grouped by purchaser, so it is attached at the end.
    const pendingVenueKitPurchases: Omit<VenueKitPurchase, "customerStatus">[] = [];
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
            if (product.rule.family !== "venue_kit" || !evaluation.qualifies || product.licenses === null) continue;
            pendingVenueKitPurchases.push({
                orderNumber: order.orderNumber,
                shopifyOrderId: order.shopifyOrderId,
                email: normalizeEmail(order.email),
                customerName: order.customerName,
                product: product.rule.label,
                quantity: product.quantity,
                licenses: product.licenses,
                unitPrice: product.unitPrice,
                createdAt: order.createdAt,
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

        const partiallyRefunded = qualifying.filter((evaluation) => isPartiallyRefunded(evaluation.order));
        if (partiallyRefunded.length > 0) {
            statuses.push("manual_review_partial_refund");
            reviewNotes.push(
                `Order ${partiallyRefunded.map((evaluation) => evaluation.order.orderNumber).join(", ")} is partially refunded; the export reports one refund total for the whole order and does not say which line item was refunded. The whole customer is held for manual review rather than guessing the refund allocation.`
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

    const statusByOrderNumber = new Map<string, CustomerStatus>();
    for (const customer of customers) {
        for (const evaluation of customer.evaluations) {
            statusByOrderNumber.set(evaluation.order.orderNumber, customer.status);
        }
    }
    const venueKitPurchases: VenueKitPurchase[] = pendingVenueKitPurchases.map((purchase) => ({
        ...purchase,
        customerStatus: statusByOrderNumber.get(purchase.orderNumber) ?? "blocked_ambiguous_data",
    }));

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

/** Calendar date stored/displayed for the grant window (UTC date of the Date value). */
export function formatGrantDisplayDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Product rules, exported so the dry run can print the configuration it ran with. */
export function describeEligibilityConfig(): string[] {
    return ELIGIBLE_PRODUCTS.map((rule) => {
        const quantity =
            rule.licenseQuantity.type === "variant_number"
                ? "licenses = N from the title x quantity"
                : `licenses = ${rule.licenseQuantity.seatsPerUnit} x quantity`;
        return `${rule.label}  [sku ${rule.expectedSkus.join("/") || "n/a"}]  ->  ${quantity}`;
    });
}

/**
 * Licenses per product across the given customers.
 *
 * Counts qualifying orders only, so passing the `ready_create_workspace`
 * customers yields exactly the product mix behind the seat total that would be
 * written. Every configured product is listed, including those at zero.
 */
export function summarizeLicensesByProduct(customers: readonly PlannedCustomer[]): ProductLicenseTotals[] {
    return ELIGIBLE_PRODUCTS.map((rule) => {
        let customerCount = 0;
        let orders = 0;
        let units = 0;
        let licenses = 0;

        for (const customer of customers) {
            let customerHasProduct = false;
            for (const evaluation of customer.evaluations) {
                if (!evaluation.qualifies) continue;
                const lines = evaluation.matchedProducts.filter((product) => product.rule.id === rule.id);
                if (lines.length === 0) continue;
                customerHasProduct = true;
                orders++;
                for (const line of lines) {
                    units += line.quantity;
                    licenses += line.licenses ?? 0;
                }
            }
            if (customerHasProduct) customerCount++;
        }

        return { ruleId: rule.id, label: rule.label, family: rule.family, customers: customerCount, orders, units, licenses };
    });
}