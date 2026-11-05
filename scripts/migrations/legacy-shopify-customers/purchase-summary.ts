/**
 * What a migrated customer bought, in the terms the onboarding email needs: which
 * products, how many units, and how many licenses each contributes.
 *
 * Pure and derived from the migration plan, so it can never disagree with what Stage 1
 * writes: the license numbers come from the plan's own calculation
 * (`summarizeLicensesByProduct`, the same one the dry run and the apply summary print).
 * Nothing here recomputes a SKU or a quantity.
 */

import { summarizeLicensesByProduct, type PlannedCustomer } from "./build-plan";
import type { PurchaseKind, PurchaseLine, PurchaseSummary } from "./migration-email";
// Note: this module must not import send-emails-core or apply-core (they import it).

/** Customer-facing wording for each eligible product rule (`ELIGIBLE_PRODUCTS[].id`). */
const WORDING_BY_RULE_ID: Readonly<Record<string, { readonly kind: PurchaseKind; readonly label: string }>> = {
    discover_your_health_age: { kind: "dyha", label: "Discover Your Health Age" },
    health_expo_screening_kit_small: { kind: "small_venue_kit", label: "Small Venue Kit" },
    health_expo_screening_kit_large: { kind: "large_venue_kit", label: "Large Venue Kit" },
};

/** One purchase line with its customer-facing wording. Throws for a product rule that has none. */
export function purchaseLine(ruleId: string, units: number, licenses: number): PurchaseLine {
    const wording = WORDING_BY_RULE_ID[ruleId];
    if (!wording) {
        throw new Error(
            `No customer-email wording for product rule "${ruleId}". Add it to WORDING_BY_RULE_ID in purchase-summary.ts before emailing customers.`
        );
    }
    return { kind: wording.kind, label: wording.label, units, licenses };
}

/**
 * Null when the customer has no qualifying purchase (nothing to say, so nothing to email).
 * Throws if a product has no wording or the lines do not add up to the plan's license total:
 * an email that states a wrong number is worse than no email.
 */
export function buildPurchaseSummary(customer: PlannedCustomer): PurchaseSummary | null {
    const totals = summarizeLicensesByProduct([customer]).filter((total) => total.licenses > 0);
    if (totals.length === 0) return null;

    const lines: PurchaseLine[] = totals.map((total) => purchaseLine(total.ruleId, total.units, total.licenses));

    const licenses = lines.reduce((sum, line) => sum + line.licenses, 0);
    if (licenses !== customer.licenseQuantity) {
        throw new Error(
            `The purchase lines for ${customer.email || "a customer"} add up to ${licenses} license(s) but the plan allocates ${customer.licenseQuantity}.`
        );
    }
    return { licenses, lines };
}

/** Purchase summary per customer email, for every plan customer that has a usable address and a qualifying purchase. */
export function buildPurchaseIndex(customers: readonly PlannedCustomer[]): Map<string, PurchaseSummary> {
    const index = new Map<string, PurchaseSummary>();
    for (const customer of customers) {
        if (!customer.email) continue;
        const summary = buildPurchaseSummary(customer);
        if (summary) index.set(customer.email, summary);
    }
    return index;
}
