/**
 * DRY RUN ONLY — one-time legacy Shopify customer migration.
 *
 * This script NEVER writes to the database. Two independent guarantees:
 *
 *   1. It issues SELECT statements only.
 *   2. Every one of them runs inside `BEGIN TRANSACTION READ ONLY`, which is
 *      then ROLLBACKed. Postgres itself rejects any write attempted from this
 *      connection, so a future edit that accidentally adds an INSERT fails loudly
 *      instead of silently mutating production.
 *
 * It does not create users, workspaces, members, or Shopify order rows, does not
 * send email, and does not touch the webhook path.
 *
 * Usage:
 *   pnpm migrate:legacy-shopify:dry-run
 *   pnpm migrate:legacy-shopify:dry-run -- --csv=orders_export_1.csv --out=./migration-reports
 *   pnpm migrate:legacy-shopify:dry-run -- --skip-db      (CSV analysis only, no DATABASE_URL needed)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

import { readOrdersCsv, toCsvLine } from "./orders-csv";
import { buildMigrationPlan, describeEligibilityConfig, resolveGrantExpiry, type MigrationPlan, type PlannedCustomer } from "./build-plan";
import { GRANT_CONFIG } from "./product-eligibility";

type Args = {
    csvPath: string;
    outDir: string;
    skipDb: boolean;
};

function parseArgs(argv: readonly string[]): Args {
    const args: Args = {
        csvPath: "orders_export_1.csv",
        outDir: "migration-reports",
        skipDb: false,
    };

    for (const argument of argv) {
        if (argument === "--skip-db") args.skipDb = true;
        else if (argument.startsWith("--csv=")) args.csvPath = argument.slice("--csv=".length);
        else if (argument.startsWith("--out=")) args.outDir = argument.slice("--out=".length);
    }

    return args;
}

type ExistingUser = { id: string; email: string; name: string; status: string };
type ExistingWorkspace = {
    id: string;
    name: string;
    owner_email: string;
    status: string;
    subscription_status: string;
    plan: string;
    seat_limit: number;
    expires_at: Date | null;
    billing_source: string;
};
type ExistingMember = { workspace_id: string; email: string; role: string; status: string };
type ExistingShopifyOrder = { shopify_order_id: string; order_number: string | null; workspace_id: string | null; status: string };

type DbSnapshot = {
    readonly usersByEmail: Map<string, ExistingUser>;
    readonly workspacesByOwnerEmail: Map<string, ExistingWorkspace[]>;
    readonly membershipsByEmail: Map<string, ExistingMember[]>;
    readonly shopifyOrdersById: Map<string, ExistingShopifyOrder>;
};

const EMPTY_SNAPSHOT: DbSnapshot = {
    usersByEmail: new Map(),
    workspacesByOwnerEmail: new Map(),
    membershipsByEmail: new Map(),
    shopifyOrdersById: new Map(),
};

/** Mirrors isWorkspaceAccessActive() in src/modules/workspace/workspace.util.ts. */
function isWorkspaceAccessActive(workspace: ExistingWorkspace): boolean {
    if (workspace.status !== "active") return false;
    if (!["active", "trialing"].includes(workspace.subscription_status)) return false;
    if (!workspace.expires_at) return true;
    return workspace.expires_at.getTime() > Date.now();
}

/** Reads current users/workspaces/members/orders for the planned emails. Read-only. */
async function loadDbSnapshot(emails: readonly string[], shopifyOrderIds: readonly string[]): Promise<DbSnapshot> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is not set. Run with --skip-db for CSV-only analysis.");
    }

    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();

    try {
        await client.query("BEGIN TRANSACTION READ ONLY");

        const userRows = await client.query<ExistingUser>(
            `SELECT id, email, name, status FROM users WHERE lower(email) = ANY($1::text[])`,
            [emails]
        );

        const workspaceRows = await client.query<ExistingWorkspace>(
            `SELECT id, name, owner_email, status, subscription_status, plan, seat_limit, expires_at, billing_source
             FROM workspaces
             WHERE lower(owner_email) = ANY($1::text[])`,
            [emails]
        );

        const memberRows = await client.query<ExistingMember>(
            `SELECT workspace_id, email, role, status FROM workspace_members WHERE lower(email) = ANY($1::text[])`,
            [emails]
        );

        const orderRows = await client.query<ExistingShopifyOrder>(
            `SELECT shopify_order_id, order_number, workspace_id, status
             FROM shopify_orders
             WHERE shopify_order_id = ANY($1::text[])`,
            [shopifyOrderIds]
        );

        // Never COMMIT: nothing was written, and rolling back makes that explicit.
        await client.query("ROLLBACK");

        const workspacesByOwnerEmail = new Map<string, ExistingWorkspace[]>();
        for (const workspace of workspaceRows.rows) {
            const key = workspace.owner_email.trim().toLowerCase();
            workspacesByOwnerEmail.set(key, [...(workspacesByOwnerEmail.get(key) ?? []), workspace]);
        }

        const membershipsByEmail = new Map<string, ExistingMember[]>();
        for (const member of memberRows.rows) {
            const key = member.email.trim().toLowerCase();
            membershipsByEmail.set(key, [...(membershipsByEmail.get(key) ?? []), member]);
        }

        return {
            usersByEmail: new Map(userRows.rows.map((user) => [user.email.trim().toLowerCase(), user])),
            workspacesByOwnerEmail,
            membershipsByEmail,
            shopifyOrdersById: new Map(orderRows.rows.map((order) => [order.shopify_order_id, order])),
        };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

type CustomerDecision = {
    readonly customer: PlannedCustomer;
    readonly status: string;
    readonly hasUser: boolean;
    readonly hasActiveWorkspace: boolean;
    readonly existingWorkspaceIds: readonly string[];
    readonly alreadyIngestedOrderNumbers: readonly string[];
    readonly reviewNotes: readonly string[];
};

/** Layers what the database already contains on top of the CSV-only plan. */
function decide(customer: PlannedCustomer, snapshot: DbSnapshot, dbChecked: boolean): CustomerDecision {
    const notes = [...customer.reviewNotes];
    const user = customer.email ? snapshot.usersByEmail.get(customer.email) : undefined;
    const workspaces = customer.email ? (snapshot.workspacesByOwnerEmail.get(customer.email) ?? []) : [];
    const memberships = customer.email ? (snapshot.membershipsByEmail.get(customer.email) ?? []) : [];
    const activeWorkspaces = workspaces.filter(isWorkspaceAccessActive);

    const alreadyIngested = customer.shopifyOrderIds
        .map((id, index) => (snapshot.shopifyOrdersById.has(id) ? customer.orderNumbers[index] ?? id : null))
        .filter((value): value is string => value !== null);

    let status: string = customer.status;

    if (dbChecked) {
        if (activeWorkspaces.length > 0 && customer.status === "ready_create_workspace") {
            status = "skip_existing_active_workspace";
        }
        if (activeWorkspaces.length > 0) {
            notes.push(
                `Already has ${activeWorkspaces.length} active workspace(s): ${activeWorkspaces
                    .map((workspace) => `${workspace.name} (${workspace.billing_source}, seats ${workspace.seat_limit}, expires ${workspace.expires_at?.toISOString().slice(0, 10) ?? "never"})`)
                    .join("; ")}. Adding a second workspace would change which one the entitlement check returns.`
            );
        }
        if (memberships.length > 0 && activeWorkspaces.length === 0) {
            notes.push(`Is already a member of ${memberships.length} workspace(s), none currently granting access.`);
        }
        if (alreadyIngested.length > 0) {
            notes.push(`Order(s) ${alreadyIngested.join(", ")} already exist in shopify_orders (ingested by the live webhook).`);
        }
    }

    return {
        customer,
        status,
        hasUser: user !== undefined,
        hasActiveWorkspace: activeWorkspaces.length > 0,
        existingWorkspaceIds: workspaces.map((workspace) => workspace.id),
        alreadyIngestedOrderNumbers: alreadyIngested,
        reviewNotes: notes,
    };
}

function writeCustomerReport(decisions: readonly CustomerDecision[], outPath: string): void {
    const header = [
        "email",
        "customer_name",
        "qualifying_orders",
        "license_quantity",
        "first_purchase_date",
        "last_purchase_date",
        "order_numbers",
        "products",
        "status",
        "review_notes",
    ];

    const lines = [toCsvLine(header)];

    for (const decision of decisions) {
        lines.push(
            toCsvLine([
                decision.customer.email,
                decision.customer.customerName,
                decision.customer.qualifyingOrderCount,
                decision.customer.licenseQuantity,
                decision.customer.firstPurchaseDate,
                decision.customer.lastPurchaseDate,
                decision.customer.orderNumbers.join(" | "),
                decision.customer.products.join(" | "),
                decision.status,
                decision.reviewNotes.join(" || "),
            ])
        );
    }

    writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function printSummary(input: {
    plan: MigrationPlan;
    decisions: readonly CustomerDecision[];
    dbChecked: boolean;
    runDate: Date;
    csvPath: string;
    reportPath: string;
    detailPath: string;
}): void {
    const { plan, decisions, dbChecked, runDate } = input;

    const ready = decisions.filter((decision) => decision.status === "ready_create_workspace");
    const manualReview = decisions.filter((decision) => decision.status.startsWith("manual_review"));
    const blocked = decisions.filter((decision) => decision.status.startsWith("blocked"));
    const skipped = decisions.filter((decision) => decision.status.startsWith("skip"));
    const multiPurchase = decisions.filter((decision) => decision.customer.qualifyingOrderCount > 1);
    const identifiable = decisions.filter((decision) => decision.customer.email.length > 0);
    const withUser = identifiable.filter((decision) => decision.hasUser);
    const withAnyWorkspace = identifiable.filter((decision) => decision.existingWorkspaceIds.length > 0);
    const withActiveWorkspace = identifiable.filter((decision) => decision.hasActiveWorkspace);
    const migratable = decisions.filter((decision) => decision.customer.qualifyingOrderCount > 0 && !decision.status.startsWith("blocked"));

    const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(46, ".")} ${value}`);

    console.log("");
    console.log("=".repeat(78));
    console.log("  LEGACY SHOPIFY CUSTOMER MIGRATION — DRY RUN (no database writes)");
    console.log("=".repeat(78));
    console.log(`  CSV           : ${input.csvPath}`);
    console.log(`  Run date      : ${runDate.toISOString()}`);
    console.log(`  DB inspected  : ${dbChecked ? "yes (read-only transaction)" : "no (--skip-db)"}`);
    console.log("");

    console.log("PRODUCT ELIGIBILITY CONFIGURATION (scripts/migrations/legacy-shopify-customers/product-eligibility.ts)");
    for (const description of describeEligibilityConfig()) console.log(`  - ${description}`);
    console.log("  - everything else -> skipped (default deny)");
    console.log("");

    console.log("CSV TOTALS");
    line("Total CSV rows (line items)", plan.totalCsvRows);
    line("Total unique orders", plan.totalOrders);
    line("Orders containing an eligible product", plan.ordersContainingEligibleProducts);
    line("Total eligible orders", plan.eligibleOrders);
    console.log("");

    console.log("CUSTOMERS");
    line("Total customers with eligible purchases", decisions.length);
    line("Total eligible customers (migratable)", migratable.length);
    line("Total licenses across all eligible orders", decisions.reduce((total, decision) => total + decision.customer.licenseQuantity, 0));
    line("Total licenses for migratable customers", migratable.reduce((total, decision) => total + decision.customer.licenseQuantity, 0));
    line("Customers with multiple qualifying purchases", multiPurchase.length);
    line("Invalid / missing emails", decisions.length - identifiable.length);
    console.log("");

    if (dbChecked) {
        console.log("EXISTING BACKEND STATE");
        line("Existing users (users.email matches)", withUser.length);
        line("Missing users (invited by email, never created)", identifiable.length - withUser.length);
        line("Customers already owning a workspace", withAnyWorkspace.length);
        line("...of those, currently granting access", withActiveWorkspace.length);
        line("Customers requiring new workspaces", ready.length + manualReview.length);
        line("Orders already present in shopify_orders", decisions.reduce((total, decision) => total + decision.alreadyIngestedOrderNumbers.length, 0));
        console.log("");
    }

    console.log("OUTCOME BY STATUS");
    const statusCounts = new Map<string, number>();
    for (const decision of decisions) statusCounts.set(decision.status, (statusCounts.get(decision.status) ?? 0) + 1);
    for (const [status, count] of [...statusCounts.entries()].sort()) line(status, count);
    console.log("");

    console.log(`SKIPPED PRODUCTS (${plan.skippedProducts.length} distinct, not eligible)`);
    for (const product of plan.skippedProducts) {
        console.log(`  ${String(product.rowCount).padStart(3)} rows  qty ${String(product.totalQuantity).padStart(3)}  ${product.lineItemName}${product.sku ? `  [sku ${product.sku}]` : ""}`);
    }
    console.log("");

    console.log(`VENUE KIT PURCHASES REQUIRING MANUAL CONFIRMATION (${plan.venueKitPurchases.length})`);
    for (const kit of plan.venueKitPurchases) {
        console.log(`  ${kit.orderNumber}  ${kit.email.padEnd(34)} ${kit.product}  qty ${kit.quantity} @ ${kit.unitPrice}  (${kit.createdAt.slice(0, 10)})`);
    }
    if (plan.venueKitPurchases.length > 0) {
        console.log("  -> The export carries no seat count for these. Confirm licenses-per-kit before the real run.");
    }
    console.log("");

    console.log(`AMBIGUOUS ROWS (${plan.ambiguousRows.length})`);
    for (const row of plan.ambiguousRows) {
        console.log(`  row ${row.sourceRow}  ${row.orderNumber}  ${row.lineItemName}: ${row.reason}`);
    }
    if (plan.ambiguousRows.length === 0) console.log("  none");
    console.log("");

    console.log(`EXCLUDED ORDERS THAT CONTAINED AN ELIGIBLE PRODUCT (${plan.excludedOrders.length})`);
    for (const order of plan.excludedOrders) {
        console.log(`  ${order.orderNumber}  ${order.email.padEnd(34)} ${order.reason}`);
    }
    if (plan.excludedOrders.length === 0) console.log("  none");
    console.log("");

    console.log(`BLOCKED (${blocked.length}) — cannot be migrated without a human decision`);
    for (const decision of blocked) {
        console.log(`  ${decision.customer.orderNumbers.join(", ")}  ${decision.customer.customerName || "(no name)"} — ${decision.reviewNotes[0] ?? decision.status}`);
    }
    if (blocked.length === 0) console.log("  none");
    console.log("");

    console.log("WHAT THE REAL MIGRATION WOULD WRITE (not written now)");
    const wouldWrite = [...ready, ...manualReview];
    line("workspaces rows to INSERT", wouldWrite.length);
    line("workspace_members rows to INSERT (owner)", wouldWrite.length);
    line("Total seats granted", wouldWrite.reduce((total, decision) => total + decision.customer.licenseQuantity, 0));
    line("Grant window", `${GRANT_CONFIG.accessDurationDays} days from ${GRANT_CONFIG.grantStartsFrom}`);
    line("expires_at that would be written", wouldWrite[0] ? resolveGrantExpiry(wouldWrite[0].customer, runDate).toISOString() : "n/a");
    line("billing_source", GRANT_CONFIG.workspaceBillingSource);
    line("Users created", "0 (members are invited by email; the existing login hook claims the seat)");
    line("Rows skipped", `${skipped.length} customers`);
    console.log("");

    console.log("REPORTS");
    console.log(`  Customer CSV : ${input.reportPath}`);
    console.log(`  Detail JSON  : ${input.detailPath}`);
    console.log("");
    console.log("No database rows were inserted, updated, or deleted.");
    console.log("");
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const runDate = new Date();
    const csvPath = resolve(process.cwd(), args.csvPath);

    const csv = readOrdersCsv(csvPath);
    const plan = buildMigrationPlan(csv);

    const emails = [...new Set(plan.customers.map((customer) => customer.email).filter((email) => email.length > 0))];
    const shopifyOrderIds = [...new Set(plan.customers.flatMap((customer) => customer.shopifyOrderIds).filter((id) => id.length > 0))];

    const snapshot = args.skipDb ? EMPTY_SNAPSHOT : await loadDbSnapshot(emails, shopifyOrderIds);
    const decisions = plan.customers.map((customer) => decide(customer, snapshot, !args.skipDb));

    const outDir = resolve(process.cwd(), args.outDir);
    mkdirSync(outDir, { recursive: true });

    const stamp = runDate.toISOString().replace(/[:.]/g, "-");
    const reportPath = resolve(outDir, `legacy-shopify-customers-${stamp}.csv`);
    const detailPath = resolve(outDir, `legacy-shopify-customers-${stamp}.json`);

    writeCustomerReport(decisions, reportPath);

    writeFileSync(
        detailPath,
        JSON.stringify(
            {
                generatedAt: runDate.toISOString(),
                csvPath,
                databaseInspected: !args.skipDb,
                grantConfig: GRANT_CONFIG,
                totals: {
                    totalCsvRows: plan.totalCsvRows,
                    totalOrders: plan.totalOrders,
                    ordersContainingEligibleProducts: plan.ordersContainingEligibleProducts,
                    eligibleOrders: plan.eligibleOrders,
                    customers: plan.customers.length,
                },
                skippedProducts: plan.skippedProducts,
                ambiguousRows: plan.ambiguousRows,
                venueKitPurchases: plan.venueKitPurchases,
                excludedOrders: plan.excludedOrders,
                customers: decisions.map((decision) => ({
                    email: decision.customer.email,
                    customerName: decision.customer.customerName,
                    company: decision.customer.company,
                    status: decision.status,
                    qualifyingOrders: decision.customer.qualifyingOrderCount,
                    licenseQuantity: decision.customer.licenseQuantity,
                    firstPurchaseDate: decision.customer.firstPurchaseDate,
                    lastPurchaseDate: decision.customer.lastPurchaseDate,
                    orderNumbers: decision.customer.orderNumbers,
                    shopifyOrderIds: decision.customer.shopifyOrderIds,
                    products: decision.customer.products,
                    hasExistingUser: decision.hasUser,
                    hasActiveWorkspace: decision.hasActiveWorkspace,
                    existingWorkspaceIds: decision.existingWorkspaceIds,
                    alreadyIngestedOrders: decision.alreadyIngestedOrderNumbers,
                    plannedExpiresAt: resolveGrantExpiry(decision.customer, runDate).toISOString(),
                    reviewNotes: decision.reviewNotes,
                })),
            },
            null,
            2
        ),
        "utf8"
    );

    printSummary({ plan, decisions, dbChecked: !args.skipDb, runDate, csvPath, reportPath, detailPath });
}

main().catch((error) => {
    console.error("Legacy Shopify customer migration dry run failed.");
    console.error(error);
    process.exit(1);
});