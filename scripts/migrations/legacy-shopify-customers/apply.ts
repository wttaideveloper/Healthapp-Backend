/**
 * Legacy Shopify customer migration apply CLI.
 *
 * Writes are OFF unless --apply is passed AND --dry-run is not passed.
 * Emails are never sent during dry-run, and --no-email suppresses them on a real
 * apply. When enabled, they are sent only after a customer's workspace/membership
 * transaction commits.
 *
 * Does not insert users, shopify_orders, or Shopify-managed workspaces.
 *
 * Usage:
 *   pnpm migrate:legacy-shopify:apply --dry-run
 *   pnpm migrate:legacy-shopify:apply --dry-run --limit=5
 *   pnpm migrate:legacy-shopify:apply --apply --no-email --limit=5
 *   pnpm migrate:legacy-shopify:apply --dry-run --only-emails=a@x.com,b@y.com
 *   pnpm migrate:legacy-shopify:apply --apply --no-email --only-emails=a@x.com,b@y.com
 *
 * --only-emails targets EXACTLY the listed addresses (normalized, exact match). It never falls
 * back to processing everyone: an address that cannot be migrated refuses the whole write run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import { Pool, type PoolClient } from "pg";

import { readOrdersCsv, toCsvLine } from "./orders-csv";
import { buildMigrationPlan, describeEligibilityConfig, summarizeLicensesByProduct } from "./build-plan";
import { GRANT_CONFIG } from "./product-eligibility";
import {
    applyOneCustomer,
    decideCustomer,
    emailConfigIssues,
    parseApplyArgs,
    readEmailConfig,
    resolveWriteMode,
    selectDecisions,
    summarizeDecisions,
    type ApplyDecision,
    type ApplyExecutor,
    type CustomerApplyResult,
    type ExistingUser,
    type ExistingWorkspace,
    type TargetReport,
} from "./apply-core";
import { sendFreeYearEmail as sendViaSmtp } from "./email-transport";
import { inferMigrationCustomerDisplayName, type PurchaseSummary } from "./migration-email";

type DbSnapshot = {
    readonly usersByEmail: Map<string, ExistingUser>;
    readonly workspacesByOwnerEmail: Map<string, ExistingWorkspace[]>;
};

const EMPTY_SNAPSHOT: DbSnapshot = {
    usersByEmail: new Map(),
    workspacesByOwnerEmail: new Map(),
};

async function loadDbSnapshot(emails: readonly string[]): Promise<DbSnapshot> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is not set. Run with --skip-db for CSV-only analysis.");
    }

    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();

    try {
        await client.query("BEGIN TRANSACTION READ ONLY");

        const userRows = await client.query<ExistingUser>(
            `SELECT id, email, name FROM users WHERE lower(email) = ANY($1::text[])`,
            [emails]
        );

        const workspaceRows = await client.query<ExistingWorkspace>(
            `SELECT id, name, owner_email, status, subscription_status, plan, seat_limit, expires_at, billing_source, notes
             FROM workspaces
             WHERE lower(owner_email) = ANY($1::text[])`,
            [emails]
        );

        await client.query("ROLLBACK");

        const workspacesByOwnerEmail = new Map<string, ExistingWorkspace[]>();
        for (const workspace of workspaceRows.rows) {
            const key = workspace.owner_email.trim().toLowerCase();
            workspacesByOwnerEmail.set(key, [...(workspacesByOwnerEmail.get(key) ?? []), workspace]);
        }

        return {
            usersByEmail: new Map(userRows.rows.map((user) => [user.email.trim().toLowerCase(), user])),
            workspacesByOwnerEmail,
        };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

function executorForClient(client: PoolClient): ApplyExecutor {
    return {
        async findWorkspacesByOwnerEmail(email) {
            const result = await client.query<ExistingWorkspace>(
                `SELECT id, name, owner_email, status, subscription_status, plan, seat_limit, expires_at, billing_source, notes
                 FROM workspaces
                 WHERE lower(owner_email) = $1
                 FOR UPDATE`,
                [email]
            );
            return result.rows;
        },
        async findUserByEmail(email) {
            const result = await client.query<ExistingUser>(
                `SELECT id, email, name FROM users WHERE lower(email) = $1 LIMIT 1`,
                [email]
            );
            return result.rows[0] ?? null;
        },
        async findOwnerMembership(workspaceId, email) {
            const result = await client.query<{ id: string }>(
                `SELECT id FROM workspace_members WHERE workspace_id = $1 AND lower(email) = $2 LIMIT 1`,
                [workspaceId, email]
            );
            return result.rows[0] ?? null;
        },
        async insertWorkspace(values) {
            const result = await client.query<{ id: string }>(
                `INSERT INTO workspaces (
                    name, owner_email, owner_user_id, seat_limit, plan, subscription_status, status,
                    billing_source, is_provisioned_externally, created_by_user_id, expires_at, notes, shopify_shop_id
                 ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, true, null, $9, $10, null
                 ) RETURNING id`,
                [
                    values.name,
                    values.ownerEmail,
                    values.ownerUserId,
                    values.seatLimit,
                    GRANT_CONFIG.workspacePlan,
                    GRANT_CONFIG.workspaceSubscriptionStatus,
                    GRANT_CONFIG.workspaceStatus,
                    GRANT_CONFIG.workspaceBillingSource,
                    values.expiresAt,
                    values.notes,
                ]
            );
            const row = result.rows[0];
            if (!row) throw new Error("Workspace insert returned no id");
            return row;
        },
        async insertOwnerMembership(values) {
            await client.query(
                `INSERT INTO workspace_members (
                    workspace_id, user_id, email, role, status, invited_by_user_id, joined_at
                 ) VALUES ($1, $2, $3, $4, $5, null, $6)`,
                [
                    values.workspaceId,
                    values.userId,
                    values.email,
                    values.role,
                    values.status,
                    values.joinedAt,
                ]
            );
        },
        async updateWorkspaceNotes(workspaceId, notes) {
            await client.query(`UPDATE workspaces SET notes = $2, updated_at = now() WHERE id = $1`, [workspaceId, notes]);
        },
    };
}

function createPgRunner(pool: Pool) {
    return {
        async runInTransaction<T>(fn: (tx: ApplyExecutor) => Promise<T>): Promise<T> {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const result = await fn(executorForClient(client));
                await client.query("COMMIT");
                return result;
            } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
            } finally {
                client.release();
            }
        },
    };
}

/**
 * Stage 1 sender. The message itself is built by the shared `email-transport`
 * module, the same one stage 2 uses. Stage 1's recipient is always the customer,
 * so the greeting name is inferred from `to` here.
 */
async function sendFreeYearEmail(input: {
    to: string;
    customerName: string;
    accountEmail: string;
    workspaceName: string;
    purchase: PurchaseSummary;
    startDate: string;
    expiryDate: string;
    androidUrl: string | null;
    windowsUrl: string | null;
    iosUrl: string | null;
    macosUrl: string | null;
    supportEmail: string;
}): Promise<void> {
    await sendViaSmtp(
        { ...input, customerName: inferMigrationCustomerDisplayName(input.to, input.customerName) },
        { env: process.env, createTransport: (config) => nodemailer.createTransport(config) }
    );
}

function writeReport(decisions: readonly ApplyDecision[], results: readonly CustomerApplyResult[], outPath: string): void {
    const resultByEmail = new Map(results.map((result) => [result.email, result]));
    const header = [
        "email",
        "customer_name",
        "order_numbers",
        "products",
        "license_quantity",
        "action",
        "in_this_run",
        "wrote",
        "emailed",
        "email_error",
        "error",
        "review_notes",
    ];
    const lines = [toCsvLine(header)];
    for (const decision of decisions) {
        const result = resultByEmail.get(decision.customer.email);
        lines.push(
            toCsvLine([
                decision.customer.email,
                decision.customer.customerName,
                decision.customer.orderNumbers.join(" | "),
                decision.customer.products.join(" | "),
                decision.customer.licenseQuantity,
                decision.action,
                decision.inThisRun ? "yes" : "no",
                result?.wrote ? "yes" : "no",
                result?.emailed ? "yes" : "no",
                result?.emailError ?? "",
                result?.error ?? "",
                decision.reviewNotes.join(" || "),
            ])
        );
    }
    writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function printSummary(input: {
    csvPath: string;
    runDate: Date;
    writeMode: { writesEnabled: boolean; emailsEnabled: boolean };
    skipDb: boolean;
    limit: number | null;
    decisions: readonly ApplyDecision[];
    results: readonly CustomerApplyResult[];
    reportPath: string;
    emailIssues: readonly string[];
    /** Present only when --only-emails was given. */
    targeting: TargetReport | null;
}): void {
    const totals = summarizeDecisions(input.decisions);
    const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(46, ".")} ${value}`);
    const failures = input.results.filter((result) => result.error);
    const emailFailures = input.results.filter((result) => result.emailError);
    const wrote = input.results.filter((result) => result.wrote).length;
    const emailed = input.results.filter((result) => result.emailed).length;

    console.log("");
    console.log("=".repeat(78));
    console.log("  LEGACY SHOPIFY CUSTOMER MIGRATION — APPLY");
    console.log("=".repeat(78));
    console.log(`  CSV           : ${input.csvPath}`);
    console.log(`  Run date      : ${input.runDate.toISOString()}`);
    const emailState = !input.writeMode.writesEnabled
        ? "NO (dry-run never sends email)"
        : input.writeMode.emailsEnabled
          ? "YES, after each successful commit (pass --no-email to suppress)"
          : "NO (--no-email)";
    console.log(`  Writes        : ${input.writeMode.writesEnabled ? "YES (--apply)" : "NO (pass --apply to write)"}`);
    console.log(`  Emails        : ${emailState}`);
    console.log(`  DB inspected  : ${input.skipDb ? "no (--skip-db)" : "yes (read-only snapshot)"}`);
    console.log(
        `  Limit         : ${input.targeting ? `none: only the ${input.targeting.requested.length} address(es) listed in --only-emails` : (input.limit ?? "none")}`
    );
    console.log("");

    if (input.targeting) {
        const targeting = input.targeting;
        console.log("ONLY-EMAILS TARGETING (exact match on the normalized address; nobody else is migrated)");
        line("Requested addresses", targeting.requested.length);
        line("Eligible: will be created", targeting.eligible.length);
        line("Already has a workspace: nothing to create", targeting.hasWorkspace.length);
        line("CANNOT BE MIGRATED (blocked or missing)", targeting.unresolved.length);
        for (const entry of targeting.entries) console.log(`    ${entry.state.padEnd(16)} ${entry.email}  ${entry.detail}`);
        if (targeting.unresolved.length > 0) {
            console.log("  !! A write run (--apply) is REFUSED while any address is blocked or missing; nothing would be written.");
        }
        console.log("");
    }

    console.log("SCOPE: Discover Your Health Age software, Small Venue Kit, Large Venue Kit.");
    console.log("Products and license counts (product-eligibility.ts):");
    for (const description of describeEligibilityConfig()) console.log(`  - ${description}`);
    console.log("");

    console.log("ACTIONS");
    line("CREATE (eligible)", totals.create);
    line("CREATE in this run", totals.createThisRun);
    line("...of which include a venue kit", totals.createWithVenueKit);
    line("Total licenses (eligible)", totals.licensesEligible);
    line("Total licenses (this run)", totals.licensesThisRun);
    line("SKIP_EXISTING", totals.skipExisting);
    line("SKIP_MISSING_EMAIL", totals.skipMissingEmail);
    line("SKIP_REFUNDED", totals.skipRefunded);
    line("SKIP_MANUAL_REVIEW", totals.skipManualReview);
    console.log("");

    console.log("LICENSES BY PRODUCT (CREATE decisions)");
    // With --only-emails the product mix shown is the targeted customers', not the whole plan's.
    const productDecisions = input.decisions.filter((decision) => decision.action === "CREATE" && (!input.targeting || decision.inThisRun));
    for (const product of summarizeLicensesByProduct(productDecisions.map((decision) => decision.customer))) {
        console.log(
            `  ${product.label.padEnd(66)} customers ${String(product.customers).padStart(3)}  units ${String(product.units).padStart(3)}  licenses ${String(product.licenses).padStart(3)}`
        );
    }
    console.log("");

    console.log("WRITE / EMAIL OUTCOME");
    line("Workspaces written", wrote);
    line("Emails sent", emailed);
    line("Customer write failures", failures.length);
    line("Email failures (workspace kept)", emailFailures.length);
    if (input.writeMode.emailsEnabled && input.emailIssues.length > 0) {
        console.log(`  Email config: ${input.emailIssues.join("; ")}`);
        console.log("  Set HEALTHAGE_ANDROID_URL, HEALTHAGE_WINDOWS_URL, and HEALTHAGE_SUPPORT_EMAIL before sending mail.");
    }
    console.log("");

    // With --only-emails only the requested addresses are listed (the rest are out of scope, and
    // printing every other customer's address would only add noise and exposure).
    const requested = new Set(input.targeting?.requested ?? []);
    const listed = input.targeting ? input.decisions.filter((decision) => requested.has(decision.customer.email)) : input.decisions;
    const byAction = (action: string) => listed.filter((decision) => decision.action === action);
    const printGroup = (title: string, rows: readonly ApplyDecision[]) => {
        console.log(`${title} (${rows.length})`);
        for (const decision of rows) {
            const marker = decision.inThisRun ? "RUN" : "   ";
            console.log(
                `  [${marker}] ${decision.action.padEnd(20)} ${String(decision.customer.licenseQuantity).padStart(2)} lic  ${(decision.customer.email || "(no email)").padEnd(36)} ${decision.customer.orderNumbers.join(", ")}`
            );
        }
        if (rows.length === 0) console.log("  none");
        console.log("");
    };

    printGroup("CREATE", byAction("CREATE"));
    printGroup("SKIP_MISSING_EMAIL", byAction("SKIP_MISSING_EMAIL"));
    printGroup("SKIP_REFUNDED", byAction("SKIP_REFUNDED"));
    printGroup("SKIP_MANUAL_REVIEW", byAction("SKIP_MANUAL_REVIEW"));
    printGroup("SKIP_EXISTING", byAction("SKIP_EXISTING"));

    if (failures.length > 0) {
        console.log("WRITE FAILURES");
        for (const failure of failures) console.log(`  ${failure.email}: ${failure.error}`);
        console.log("");
    }
    if (emailFailures.length > 0) {
        console.log("EMAIL FAILURES (workspace was still created)");
        for (const failure of emailFailures) console.log(`  ${failure.email}: ${failure.emailError}`);
        console.log("");
    }

    console.log("REPORT");
    console.log(`  ${input.reportPath}`);
    console.log("");
    if (!input.writeMode.writesEnabled) {
        console.log("No database rows were inserted, updated, or deleted.");
        console.log("No emails were sent.");
        console.log("");
    } else if (!input.writeMode.emailsEnabled) {
        console.log("No emails were sent (--no-email). Migrated customers have not been notified yet.");
        console.log("");
    }
}

async function main(): Promise<void> {
    const args = parseApplyArgs(process.argv.slice(2));
    const writeMode = resolveWriteMode(args);
    const runDate = new Date();
    const csvPath = resolve(process.cwd(), args.csvPath);
    const emailConfig = readEmailConfig(process.env);

    const csv = readOrdersCsv(csvPath);
    const plan = buildMigrationPlan(csv);
    const emails = [...new Set(plan.customers.map((customer) => customer.email).filter((email) => email.length > 0))];

    const snapshot = args.skipDb ? EMPTY_SNAPSHOT : await loadDbSnapshot(emails);
    const decided = plan.customers.map((customer) =>
        decideCustomer({
            customer,
            runDate,
            user: customer.email ? snapshot.usersByEmail.get(customer.email) : undefined,
            workspaces: customer.email ? (snapshot.workspacesByOwnerEmail.get(customer.email) ?? []) : [],
            dbChecked: !args.skipDb,
        })
    );
    // With --only-emails this either targets EXACTLY the listed addresses or throws (before any
    // write, when writes are enabled). It never falls back to the --limit / everyone behaviour.
    const { decisions, targeting } = selectDecisions({
        decided,
        limit: args.limit,
        onlyEmails: args.onlyEmails,
        writesEnabled: writeMode.writesEnabled,
    });
    const allowlist = args.onlyEmails.length > 0 ? new Set(args.onlyEmails) : undefined;

    const outDir = resolve(process.cwd(), args.outDir);
    mkdirSync(outDir, { recursive: true });
    const stamp = runDate.toISOString().replace(/[:.]/g, "-");
    const reportPath = resolve(outDir, `legacy-shopify-apply-${stamp}.csv`);

    const results: CustomerApplyResult[] = [];

    if (writeMode.writesEnabled) {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
            throw new Error("DATABASE_URL is required for --apply");
        }
        const pool = new Pool({ connectionString: databaseUrl });
        const runner = createPgRunner(pool);
        const notesClient = await pool.connect();
        const notesWriter = executorForClient(notesClient);
        try {
            for (const decision of decisions) {
                if (decision.action !== "CREATE" || !decision.inThisRun) {
                    results.push({
                        email: decision.customer.email,
                        action: decision.action,
                        wrote: false,
                        workspaceId: decision.existingWorkspaceIds[0] ?? null,
                        membershipStatus: null,
                        emailed: false,
                        emailError: null,
                        error: null,
                    });
                    continue;
                }

                const result = await applyOneCustomer({
                    runner,
                    notesWriter,
                    customer: decision.customer,
                    decision,
                    writeMode,
                    emailConfig,
                    onlyEmails: allowlist,
                    sendEmail: sendFreeYearEmail,
                    now: runDate,
                });
                results.push(result);
            }
        } finally {
            notesClient.release();
            await pool.end();
        }
    } else {
        for (const decision of decisions) {
            results.push({
                email: decision.customer.email,
                action: decision.action,
                wrote: false,
                workspaceId: null,
                membershipStatus: null,
                emailed: false,
                emailError: null,
                error: null,
            });
        }
    }

    writeReport(decisions, results, reportPath);
    printSummary({
        csvPath,
        runDate,
        writeMode,
        skipDb: args.skipDb,
        limit: args.limit,
        decisions,
        results,
        reportPath,
        emailIssues: [...emailConfigIssues(emailConfig)],
        targeting,
    });
}

const invoked = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invoked.endsWith("/apply.ts") || invoked.endsWith("/apply.js")) {
    main().catch((error) => {
        console.error("Legacy Shopify customer migration apply failed.");
        console.error(error);
        process.exit(1);
    });
}

export { main as runLegacyShopifyApply };
