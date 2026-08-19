/**
 * Legacy Shopify customer migration apply CLI.
 *
 * Writes are OFF unless --apply is passed AND --dry-run is not passed.
 * Emails are never sent during dry-run. They are sent only after a customer's
 * workspace/membership transaction commits.
 *
 * Does not insert users, shopify_orders, or Shopify-managed workspaces.
 *
 * Usage:
 *   pnpm migrate:legacy-shopify:apply --dry-run
 *   pnpm migrate:legacy-shopify:apply --dry-run --limit=5
 *   pnpm migrate:legacy-shopify:apply --apply --limit=5
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import { Pool, type PoolClient } from "pg";

import { readOrdersCsv, toCsvLine } from "./orders-csv";
import { buildMigrationPlan } from "./build-plan";
import { GRANT_CONFIG } from "./product-eligibility";
import {
    applyCreateLimit,
    applyOneCustomer,
    decideCustomer,
    emailConfigIssues,
    parseApplyArgs,
    readEmailConfig,
    resolveWriteMode,
    summarizeDecisions,
    type ApplyDecision,
    type ApplyExecutor,
    type CustomerApplyResult,
    type ExistingUser,
    type ExistingWorkspace,
} from "./apply-core";
import { getLegacyFreeYearEmailContent, inferMigrationCustomerDisplayName } from "./migration-email";

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
                    GRANT_CONFIG.ownerRole,
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

async function sendFreeYearEmail(input: {
    to: string;
    customerName: string;
    startDate: string;
    expiryDate: string;
    androidUrl: string | null;
    windowsUrl: string | null;
    iosUrl: string | null;
    macosUrl: string | null;
    supportEmail: string;
}): Promise<void> {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? "0");
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !port || !user || !pass) {
        throw new Error("SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS are not configured");
    }

    const content = getLegacyFreeYearEmailContent({
        customerName: inferMigrationCustomerDisplayName(input.to, input.customerName),
        startDate: input.startDate,
        expiryDate: input.expiryDate,
        androidUrl: input.androidUrl,
        windowsUrl: input.windowsUrl,
        iosUrl: input.iosUrl,
        macosUrl: input.macosUrl,
        supportEmail: input.supportEmail,
    });

    const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
    });

    await transport.sendMail({
        from: process.env.EMAIL_FROM ?? user,
        to: input.to,
        subject: content.subject,
        text: content.text,
        html: content.html,
    });
}

function writeReport(decisions: readonly ApplyDecision[], results: readonly CustomerApplyResult[], outPath: string): void {
    const resultByEmail = new Map(results.map((result) => [result.email, result]));
    const header = [
        "email",
        "customer_name",
        "order_numbers",
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
    console.log(`  Writes        : ${input.writeMode.writesEnabled ? "YES (--apply)" : "NO (pass --apply to write)"}`);
    console.log(`  Emails        : ${input.writeMode.emailsEnabled ? "yes, after each successful commit" : "NO"}`);
    console.log(`  DB inspected  : ${input.skipDb ? "no (--skip-db)" : "yes (read-only snapshot)"}`);
    console.log(`  Limit         : ${input.limit ?? "none"}`);
    console.log("");

    console.log("THIS PHASE: Discover Your Health Age software only. Venue kits are not migrated.");
    console.log("");

    console.log("ACTIONS");
    line("CREATE (eligible)", totals.create);
    line("CREATE in this run", totals.createThisRun);
    line("Total licenses (eligible)", totals.licensesEligible);
    line("Total licenses (this run)", totals.licensesThisRun);
    line("SKIP_EXISTING", totals.skipExisting);
    line("SKIP_MISSING_EMAIL", totals.skipMissingEmail);
    line("SKIP_REFUNDED", totals.skipRefunded);
    line("SKIP_MANUAL_REVIEW", totals.skipManualReview);
    line("Venue kit customers (not migrated)", totals.skipVenueKit);
    console.log("");

    console.log("WRITE / EMAIL OUTCOME");
    line("Workspaces written", wrote);
    line("Emails sent", emailed);
    line("Customer write failures", failures.length);
    line("Email failures (workspace kept)", emailFailures.length);
    if (input.emailIssues.length > 0) {
        console.log(`  Email config: ${input.emailIssues.join("; ")}`);
        console.log("  Set HEALTHAGE_ANDROID_URL, HEALTHAGE_WINDOWS_URL, and HEALTHAGE_SUPPORT_EMAIL before sending mail.");
    }
    console.log("");

    const byAction = (action: string) => input.decisions.filter((decision) => decision.action === action);
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
    const decisions = applyCreateLimit(decided, args.limit);

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
