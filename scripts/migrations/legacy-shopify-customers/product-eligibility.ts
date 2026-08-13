/**
 * Product eligibility configuration for the one-time legacy Shopify customer migration.
 *
 * THIS FILE IS THE REVIEWABLE SOURCE OF TRUTH.
 *
 * Everything about "which historical purchase earns HealthAge access, and how
 * many licenses it is worth" lives here as data. The parser and the dry-run
 * report contain no product string checks of their own — if a product should be
 * added, removed, or re-priced in seats, this is the only file to edit.
 *
 * DEFAULT DENY. A line item that matches no rule below is skipped and reported
 * under "skipped products". Unrelated catalogue items (Hydrotherapy, Charcoal,
 * Diabetes, Adult Health Banners, Mini-Wright Peak Flow Meter, booklets, tips,
 * …) are therefore excluded by construction, not by a blocklist that has to be
 * kept in sync with the store.
 */

/** How many HealthAge licenses one line item is worth. */
export type LicenseQuantityRule =
    /**
     * The trailing number in the product title is the license count, and it
     * multiplies by the purchased quantity.
     *   "Discover Your Health Age - 4", quantity 1 => 4 licenses
     *   "Discover Your Health Age - 4", quantity 2 => 8 licenses
     */
    | { readonly type: "variant_number"; readonly multipliedByQuantity: true }
    /** A fixed number of seats per unit purchased. Not used yet — kept for venue kits once confirmed. */
    | { readonly type: "fixed_per_unit"; readonly seatsPerUnit: number }
    /**
     * The CSV carries no seat count for this product. The migration must not
     * guess: these purchases are reported separately for a human decision.
     */
    | { readonly type: "manual_confirmation_required"; readonly reason: string };

export type ProductFamily = "healthage_software" | "venue_kit";

export type EligibleProductRule = {
    /** Stable key used in reports and in the JSON detail file. */
    readonly id: string;
    readonly label: string;
    readonly family: ProductFamily;
    /** Matched against the trimmed `Lineitem name` column. */
    readonly lineItemPattern: RegExp;
    /**
     * SKUs this product is expected to carry in the export. A name match with an
     * unexpected SKU is reported as ambiguous rather than silently accepted,
     * because it usually means the catalogue changed under us.
     * Empty array = the export carries no SKU for this product (do not check).
     */
    readonly expectedSkus: readonly string[];
    readonly licenseQuantity: LicenseQuantityRule;
};

/**
 * Eligible products.
 *
 * "Discover Your Health Age - N" is the old Health Age software. N is the
 * license count; the pattern captures it. The variant list is open-ended on
 * purpose (`\d+`), so "- 5", "- 10" and future tiers work without a code change
 * even though this particular export only contains N = 1..4.
 */
export const ELIGIBLE_PRODUCTS: readonly EligibleProductRule[] = [
    {
        id: "discover_your_health_age",
        label: "Discover Your Health Age - N",
        family: "healthage_software",
        lineItemPattern: /^discover your health age\s*[-–]\s*(\d+)$/i,
        expectedSkus: ["008"],
        licenseQuantity: { type: "variant_number", multipliedByQuantity: true },
    },
    {
        id: "health_expo_screening_kit_small",
        label: "Health Expo Screening Kits - English / Small",
        family: "venue_kit",
        lineItemPattern: /^health expo screening kits\s*[-–]\s*english\s*\/\s*small$/i,
        expectedSkus: ["004-1"],
        licenseQuantity: {
            type: "manual_confirmation_required",
            reason: "The export carries no seat count for venue kits: the variant is a size (Small), not a number, and Lineitem quantity is the number of kits shipped, not licenses.",
        },
    },
    {
        id: "health_expo_screening_kit_large",
        label: "Health Expo Screening Kits - English / Large",
        family: "venue_kit",
        lineItemPattern: /^health expo screening kits\s*[-–]\s*english\s*\/\s*large$/i,
        expectedSkus: ["004-2"],
        licenseQuantity: {
            type: "manual_confirmation_required",
            reason: "The export carries no seat count for venue kits: the variant is a size (Large), not a number, and Lineitem quantity is the number of kits shipped, not licenses.",
        },
    },
] as const;

/**
 * Order-level eligibility.
 *
 * Shopify writes order-level columns only on the first row of a multi-line
 * order, so these are evaluated against the order after line items are grouped.
 */
export const ORDER_ELIGIBILITY = {
    /** Financial statuses that still represent money kept by the merchant. */
    eligibleFinancialStatuses: ["paid", "partially_refunded"] as const,
    /**
     * `partially_refunded` orders are eligible but flagged: the export shows one
     * refund total for the whole order and never says which line was refunded,
     * so we cannot tell whether the refund covered the HealthAge line item.
     */
    flagPartiallyRefundedForReview: true,
    /** Cancelled orders never grant access, regardless of financial status. */
    excludeCancelled: true,
} as const;

/**
 * How the one-year grant is represented. Read by the dry run so the report shows
 * exactly what the real migration would write. Changing a value here changes the
 * plan, not just the wording of the report.
 */
export const GRANT_CONFIG = {
    accessDurationDays: 365,
    /**
     * "migration_run_date": every migrated customer gets a full year starting the
     * day the real migration runs.
     * "last_purchase_date": the year is backdated to their most recent qualifying
     * order, which expires some customers immediately.
     * See the business decisions section of the deliverable notes.
     */
    grantStartsFrom: "migration_run_date" as "migration_run_date" | "last_purchase_date",
    workspacePlan: "organization",
    workspaceStatus: "active",
    workspaceSubscriptionStatus: "active",
    /**
     * Deliberately NOT "shopify". `findShopifyWorkspaceIdByOwnerEmail` in
     * shopify.service.ts attaches incoming subscription webhooks to workspaces
     * whose billing_source is exactly "shopify" and overwrites their expiresAt
     * and seatLimit. A distinct value keeps migrated rows out of that path and
     * makes the whole migration selectable for rollback in one predicate.
     */
    workspaceBillingSource: "legacy_shopify_migration",
    ownerRole: "owner",
} as const;

export type ProductMatch =
    | { readonly outcome: "eligible"; readonly rule: EligibleProductRule; readonly licenses: number | null; readonly variantNumber: number | null }
    | { readonly outcome: "ambiguous"; readonly rule: EligibleProductRule; readonly reason: string }
    | { readonly outcome: "skipped" };

/**
 * Resolves one CSV line item against the eligibility table.
 *
 * Returns `licenses: null` for products whose seat count the CSV does not carry
 * (venue kits) — null means "unknown", which is different from zero and is what
 * keeps those purchases out of the license total instead of quietly adding 0.
 */
export function matchLineItem(input: {
    lineItemName: string;
    sku: string;
    quantity: number;
}): ProductMatch {
    const name = input.lineItemName.trim();

    for (const rule of ELIGIBLE_PRODUCTS) {
        const match = rule.lineItemPattern.exec(name);
        if (!match) continue;

        const sku = input.sku.trim();
        if (rule.expectedSkus.length > 0 && sku.length > 0 && !rule.expectedSkus.includes(sku)) {
            return {
                outcome: "ambiguous",
                rule,
                reason: `SKU "${sku}" does not match the expected SKU(s) ${rule.expectedSkus.join(", ")} for "${rule.label}"`,
            };
        }

        if (rule.licenseQuantity.type === "variant_number") {
            const variantNumber = Number(match[1]);
            if (!Number.isInteger(variantNumber) || variantNumber <= 0) {
                return {
                    outcome: "ambiguous",
                    rule,
                    reason: `Could not read a license count from the product title "${name}"`,
                };
            }
            if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
                return {
                    outcome: "ambiguous",
                    rule,
                    reason: `Line item "${name}" has an unusable quantity (${input.quantity})`,
                };
            }
            return {
                outcome: "eligible",
                rule,
                licenses: variantNumber * input.quantity,
                variantNumber,
            };
        }

        if (rule.licenseQuantity.type === "fixed_per_unit") {
            return {
                outcome: "eligible",
                rule,
                licenses: rule.licenseQuantity.seatsPerUnit * Math.max(input.quantity, 1),
                variantNumber: null,
            };
        }

        return { outcome: "eligible", rule, licenses: null, variantNumber: null };
    }

    return { outcome: "skipped" };
}