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
    /**
     * A fixed number of licenses per unit purchased, multiplied by the line-item
     * quantity. The count is business-confirmed, not derivable from the export.
     *   Small Venue Kit x3 => 1 x 3 = 3 licenses
     *   Large Venue Kit x2 => 4 x 2 = 8 licenses
     */
    | { readonly type: "fixed_per_unit"; readonly seatsPerUnit: number };

export type ProductFamily = "healthage_software" | "venue_kit";

export type EligibleProductRule = {
    /** Stable key used in reports and in the JSON detail file. */
    readonly id: string;
    readonly label: string;
    readonly family: ProductFamily;
    /** Matched against the trimmed `Lineitem name` column. */
    readonly lineItemPattern: RegExp;
    /**
     * SKUs that identify this product in the export. When a line item carries a
     * SKU, the SKU is authoritative (see `matchLineItem`): the title is only
     * cross-checked against it, never trusted on its own. A SKU/title
     * disagreement is reported as ambiguous instead of being accepted or dropped.
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
 *
 * Venue kits (client-confirmed): the Shopify title is "Health Expo Screening
 * Kits - English / <size>". A kit is worth a fixed number of licenses per unit.
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
        label: "Small Venue Kit (Health Expo Screening Kits - English / Small)",
        family: "venue_kit",
        lineItemPattern: /^health expo screening kits\s*[-–]\s*english\s*\/\s*small$/i,
        expectedSkus: ["004-1"],
        licenseQuantity: { type: "fixed_per_unit", seatsPerUnit: 1 },
    },
    {
        id: "health_expo_screening_kit_large",
        label: "Large Venue Kit (Health Expo Screening Kits - English / Large)",
        family: "venue_kit",
        lineItemPattern: /^health expo screening kits\s*[-–]\s*english\s*\/\s*large$/i,
        expectedSkus: ["004-2"],
        licenseQuantity: { type: "fixed_per_unit", seatsPerUnit: 4 },
    },
] as const;

/**
 * Order-level eligibility.
 *
 * Shopify writes order-level columns only on the first row of a multi-line
 * order, so these are evaluated against the order after line items are grouped.
 */
export const ORDER_ELIGIBILITY = {
    /**
     * Financial statuses that still represent money kept by the merchant.
     * Everything else (`refunded`, `voided`, `pending`, …) is excluded, so fully
     * refunded orders never grant access.
     */
    eligibleFinancialStatuses: ["paid", "partially_refunded"] as const,
    /**
     * `partially_refunded` orders are held for manual review, never migrated: the
     * export shows one refund total for the whole order and never says which line
     * was refunded, so we cannot tell whether the refund covered a HealthAge
     * software or venue kit line. Refund allocation is not guessed.
     *
     * The same applies to a `paid` order that nevertheless carries a non-zero
     * Refunded Amount: the status and the amount disagree, which is ambiguous.
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

/**
 * What the apply phase is allowed to create.
 *
 * Both product families are in scope: Discover Your Health Age software and the
 * Small / Large Venue Kits. Orders held for manual review (partial refunds,
 * ambiguous lines) and customers with no usable email are never created
 * regardless of family — that is decided by `createStatuses`.
 */
export const APPLY_SCOPE = {
    families: ["healthage_software", "venue_kit"] as const,
    createStatuses: ["ready_create_workspace"] as const,
    emailSentMarker: "free_year_email_sent_at:",
} as const;

export type ProductMatch =
    | { readonly outcome: "eligible"; readonly rule: EligibleProductRule; readonly licenses: number; readonly variantNumber: number | null }
    | { readonly outcome: "ambiguous"; readonly rule: EligibleProductRule; readonly reason: string }
    | { readonly outcome: "skipped" };

function ambiguous(rule: EligibleProductRule, reason: string): ProductMatch {
    return { outcome: "ambiguous", rule, reason };
}

/** Licenses for a line item once the product itself has been identified. */
function resolveLicenses(rule: EligibleProductRule, titleMatch: RegExpExecArray, name: string, quantity: number): ProductMatch {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        return ambiguous(rule, `Line item "${name}" has an unusable quantity (${quantity})`);
    }

    if (rule.licenseQuantity.type === "variant_number") {
        const variantNumber = Number(titleMatch[1]);
        if (!Number.isInteger(variantNumber) || variantNumber <= 0) {
            return ambiguous(rule, `Could not read a license count from the product title "${name}"`);
        }
        return { outcome: "eligible", rule, licenses: variantNumber * quantity, variantNumber };
    }

    return { outcome: "eligible", rule, licenses: rule.licenseQuantity.seatsPerUnit * quantity, variantNumber: null };
}

/**
 * Resolves one CSV line item against the eligibility table.
 *
 * Identification is SKU-first. When the line item carries a SKU, the SKU decides
 * which product it is and the title is only a cross-check:
 *   - SKU is a known eligible SKU and the title agrees  -> eligible
 *   - SKU is a known eligible SKU but the title does not -> ambiguous (a human looks)
 *   - SKU is unknown but the title looks eligible        -> ambiguous (catalogue drift)
 *   - SKU is unknown and the title is unrelated          -> skipped
 * Only when the SKU is blank does the title alone decide.
 *
 * "Ambiguous" fails closed: the order is excluded and listed in the report. It
 * is never silently accepted and never silently dropped.
 *
 * An unusable quantity (zero, negative, fractional) is ambiguous for every
 * product. The license count is never guessed.
 */
export function matchLineItem(input: {
    lineItemName: string;
    sku: string;
    quantity: number;
}): ProductMatch {
    const name = input.lineItemName.trim();
    const sku = input.sku.trim();

    const titleRule = ELIGIBLE_PRODUCTS.find((rule) => rule.lineItemPattern.test(name));

    if (sku.length > 0) {
        const skuRule = ELIGIBLE_PRODUCTS.find((rule) => rule.expectedSkus.includes(sku));

        if (skuRule) {
            const titleMatch = skuRule.lineItemPattern.exec(name);
            if (!titleMatch) {
                return ambiguous(
                    skuRule,
                    `SKU "${sku}" identifies "${skuRule.label}" but the line item title "${name}" does not match the expected title`
                );
            }
            return resolveLicenses(skuRule, titleMatch, name, input.quantity);
        }

        if (titleRule && titleRule.expectedSkus.length > 0) {
            return ambiguous(
                titleRule,
                `SKU "${sku}" does not match the expected SKU(s) ${titleRule.expectedSkus.join(", ")} for "${titleRule.label}"`
            );
        }
    }

    if (!titleRule) return { outcome: "skipped" };

    const titleMatch = titleRule.lineItemPattern.exec(name);
    if (!titleMatch) return { outcome: "skipped" };
    return resolveLicenses(titleRule, titleMatch, name, input.quantity);
}