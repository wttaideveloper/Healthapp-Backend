/**
 * Legacy Shopify customer migration, STAGE 2: send the free-year email.
 *
 * Stage 1 (`apply.ts --apply --no-email`) creates the workspaces. This command
 * emails the owners of those workspaces whose email ledger entry is missing.
 *
 * Nothing is sent unless asked:
 *   (no flags)                       preview: lists who would be emailed
 *   --dry-run                        preview, whatever else is passed
 *   --test-recipients=a@x.com,...    TEST: messages go ONLY to those addresses,
 *                                    customers are never contacted, ledger untouched
 *   --send --limit=N | --send --all  LIVE: emails the customers, records each success
 *   --send --only-emails=a@x.com,... LIVE PILOT: emails EXACTLY those customers and nobody else
 *                                    (without --send it is a preview of exactly that list)
 *   --sample --test-recipients=...   SAMPLE PREVIEW: shows the approved email filled with synthetic
 *                                    data. Sends nothing. No database, no CSV, no ledger.
 *   --sample --send-sample --test-recipients=...
 *                                    SAMPLE SEND: delivers that synthetic email to ONLY those addresses
 *
 * Sample mode is decided in main() before the database, the CSV or the report folder is touched.
 *
 * The database is only read, except for one `UPDATE workspaces SET notes` per
 * successfully emailed customer in a live send. No users, members or workspaces
 * are created or otherwise changed, and the live Shopify webhook is not involved.
 *
 * Usage: see README.md ("Stage 2").
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import { Pool, type PoolClient } from "pg";

import { emailConfigIssues, readEmailConfig, type EmailConfig } from "./apply-core";
import { buildMigrationPlan } from "./build-plan";
import { readSmtpSettings, sendFreeYearEmail } from "./email-transport";
import { readOrdersCsv, toCsvLine } from "./orders-csv";
import { APPLY_SCOPE, GRANT_CONFIG } from "./product-eligibility";
import {
    SAMPLE_CUSTOMER_NAME,
    SAMPLE_EXPIRY_DATE,
    SAMPLE_START_DATE,
    SKIP_REASONS,
    assertTargetingActionable,
    assertTestRecipientsAreNotCustomers,
    countNotAttempted,
    createGuardedSender,
    emailRunExitCode,
    liveSendBlockers,
    parseSendEmailsArgs,
    planEmailRun,
    renderSampleEmail,
    resolveSendMode,
    runEmailStage,
    runSampleStage,
    sampleSendBlockers,
    summarizeOutcomes,
    type EmailOutcome,
    type EmailRunPlan,
    type LedgerRunner,
    type LedgerTransaction,
    type LockedWorkspaceRow,
    type MigratedWorkspaceRow,
    type SampleOutcome,
    type SendMode,
} from "./send-emails-core";

const MIGRATED_WORKSPACES_SQL = `
    SELECT w.id, w.name, w.owner_email, w.status, w.subscription_status, w.expires_at, w.notes, w.billing_source,
           m.status AS owner_member_status,
           u.status::text AS user_status
    FROM workspaces w
    LEFT JOIN workspace_members m
           ON m.workspace_id = w.id AND lower(m.email) = lower(w.owner_email) AND m.role = 'owner'
    LEFT JOIN users u ON lower(u.email) = lower(w.owner_email)
    WHERE w.billing_source = $1
    ORDER BY lower(w.owner_email), w.id`;

/** Every stage 1 workspace with its owner's membership and account status. Read-only. */
async function loadMigratedWorkspaces(pool: Pool): Promise<MigratedWorkspaceRow[]> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const result = await client.query<MigratedWorkspaceRow>(MIGRATED_WORKSPACES_SQL, [GRANT_CONFIG.workspaceBillingSource]);
        await client.query("ROLLBACK");

        const seen = new Set<string>();
        for (const row of result.rows) {
            if (seen.has(row.id)) {
                // More than one owner-membership or account row for one workspace: the data is not what
                // this tool assumes, so stop instead of guessing which row describes the owner.
                throw new Error(`Workspace ${row.id} matched more than one owner membership/account row; resolve that before sending.`);
            }
            seen.add(row.id);
        }
        return result.rows;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

function ledgerTransactionFor(client: PoolClient): LedgerTransaction {
    return {
        async claimWorkspace(workspaceId): Promise<LockedWorkspaceRow | null> {
            // An advisory lock serialises stage 2 runs per workspace, so two operators (or a re-run
            // started too early) cannot both send. Unlike FOR UPDATE it does not block the live
            // app's own row locks (seat assignment, admin edits) while the SMTP call is in flight.
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`legacy-free-year-email:${workspaceId}`]);
            const result = await client.query<LockedWorkspaceRow>(
                `SELECT id, owner_email, status, subscription_status, expires_at, notes, billing_source
                 FROM workspaces WHERE id = $1`,
                [workspaceId]
            );
            return result.rows[0] ?? null;
        },
        async recordEmailSent(workspaceId, markerLine) {
            // Appends relative to the CURRENT notes (so a concurrent admin edit is not overwritten) and
            // is a no-op if the marker is already there. `updated_at` is deliberately NOT touched:
            // entitlement picks among a member's active workspaces by updated_at, and an email ledger
            // entry must not change which workspace a user resolves to.
            const result = await client.query(
                `UPDATE workspaces
                 SET notes = CASE
                       WHEN btrim(coalesce(notes, ''), chr(32) || chr(9) || chr(10) || chr(13)) = '' THEN $2::text
                       ELSE btrim(notes, chr(32) || chr(9) || chr(10) || chr(13)) || chr(10) || $2::text
                     END
                 WHERE id = $1
                   AND billing_source = $3
                   AND position($4::text in coalesce(notes, '')) = 0`,
                [workspaceId, markerLine, GRANT_CONFIG.workspaceBillingSource, APPLY_SCOPE.emailSentMarker]
            );
            if (result.rowCount !== 1) {
                throw new Error("Ledger update changed 0 rows (entry already present, or the workspace changed)");
            }
        },
    };
}

function createPgLedgerRunner(pool: Pool): LedgerRunner {
    return {
        async runInTransaction<T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const result = await fn(ledgerTransactionFor(client));
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

function writeReport(mode: SendMode, outcomes: readonly EmailOutcome[], outPath: string): void {
    const header = ["mode", "workspace_id", "customer_email", "delivered_to", "status", "reason", "error", "ledger_line_to_add_by_hand"];
    const label = `${mode.target}${mode.sends ? "" : "-preview"}`;
    const lines = [toCsvLine(header)];
    for (const outcome of outcomes) {
        lines.push(
            toCsvLine([
                label,
                outcome.workspaceId,
                outcome.ownerEmail,
                outcome.deliveredTo.join(" | "),
                outcome.status,
                outcome.reason ?? "",
                outcome.error ?? "",
                outcome.ledgerLine ?? "",
            ])
        );
    }
    writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function printSummary(input: {
    mode: SendMode;
    runDate: Date;
    emailConfig: EmailConfig;
    totalMigrated: number;
    runPlan: EmailRunPlan;
    outcomes: readonly EmailOutcome[];
    blockers: readonly string[];
    reportPath: string;
}): void {
    const { mode, runPlan } = input;
    const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(46, ".")} ${value}`);
    const counts = summarizeOutcomes(input.outcomes);

    console.log("");
    console.log("=".repeat(78));
    console.log("  LEGACY SHOPIFY CUSTOMER MIGRATION — STAGE 2: FREE-YEAR EMAIL");
    console.log("=".repeat(78));
    console.log(`  Run date : ${input.runDate.toISOString()}`);

    if (!mode.sends) {
        console.log("  MODE     : PREVIEW — nothing is sent and nothing is written.");
        if (mode.target === "test") {
            console.log(`             A test send would go ONLY to: ${mode.testRecipients.join(", ")}`);
        } else if (mode.onlyEmails.length > 0) {
            console.log("             Sending to exactly these addresses needs --send as well.");
        } else {
            console.log("             A live send needs --send plus --limit=N, --all or --only-emails=....");
        }
    } else if (mode.target === "test") {
        console.log(`  MODE     : TEST SEND — messages go ONLY to: ${mode.testRecipients.join(", ")}`);
        console.log("             Customers are NOT contacted. The email ledger is NOT written.");
    } else if (mode.onlyEmails.length > 0) {
        console.log(`  MODE     : LIVE SEND to ONLY the ${mode.onlyEmails.length} listed address(es); each success is recorded in the ledger.`);
    } else {
        console.log("  MODE     : LIVE SEND — customers WILL be emailed; each success is recorded in the ledger.");
    }
    console.log(
        `  Limit    : ${mode.onlyEmails.length > 0 ? `none: only the ${mode.onlyEmails.length} address(es) in --only-emails` : (mode.limit ?? "none (--all)")}`
    );
    console.log("");

    if (runPlan.targeting) {
        const targeting = runPlan.targeting;
        console.log("ONLY-EMAILS TARGETING (exact match on the normalized address; nobody else is contacted)");
        line("Requested addresses", targeting.requested.length);
        line("Owed the email: will be sent", targeting.selected.length);
        line("Already emailed: nothing to send", targeting.alreadyEmailed.length);
        line("CANNOT BE EMAILED", targeting.unresolved.length);
        for (const entry of targeting.entries) console.log(`    ${entry.state.padEnd(16)} ${entry.email}  ${entry.detail}`);
        line("Other customers owed the email, left alone", runPlan.pending.length - targeting.selected.length);
        if (targeting.unresolved.length > 0) {
            console.log("  !! A live send (--send) is REFUSED while any listed address cannot be emailed; nothing would be sent.");
        }
        console.log("");
    }

    const links = [
        input.emailConfig.androidUrl && "Android",
        input.emailConfig.windowsUrl && "Windows",
        input.emailConfig.iosUrl && "iOS",
        input.emailConfig.macosUrl && "macOS",
    ].filter((value): value is string => Boolean(value));
    console.log(`  Platform links in the email : ${links.join(", ") || "none"}`);
    console.log(`  Support address in the email: ${input.emailConfig.supportEmail ?? "(not set)"}`);
    if (input.blockers.length > 0) {
        console.log(`  A LIVE SEND WOULD BE REFUSED: ${input.blockers.join("; ")}`);
    }
    console.log("");

    console.log("LEDGER");
    line("Stage 1 workspaces found", input.totalMigrated);
    line("Already emailed (ledger entry present)", runPlan.skipped.filter((entry) => entry.reason === "already_emailed").length);
    line("Pending (owed the email)", runPlan.pending.length);
    line("Selected for this run", runPlan.selected.length);
    console.log("");

    const skippedOther = runPlan.skipped.filter((entry) => entry.reason !== "already_emailed");
    console.log(`NOT PENDING, NOT ALREADY EMAILED (${skippedOther.length})`);
    for (const reason of SKIP_REASONS) {
        const entries = skippedOther.filter((entry) => entry.reason === reason);
        if (entries.length === 0) continue;
        console.log(`  ${reason} (${entries.length})`);
        for (const entry of entries) console.log(`    ${entry.workspace.owner_email}  — ${entry.detail}`);
    }
    if (skippedOther.length === 0) console.log("  none");
    console.log("");

    console.log("THIS RUN");
    for (const outcome of input.outcomes) {
        const target = outcome.deliveredTo.join(", ");
        console.log(
            `  ${outcome.status.padEnd(16)} ${outcome.ownerEmail.padEnd(36)} -> ${target}${outcome.reason ? `  [${outcome.reason}]` : ""}${outcome.error ? `  ERROR: ${outcome.error}` : ""}`
        );
    }
    if (input.outcomes.length === 0) console.log("  nothing to do");
    console.log("");

    line("Previewed", counts.previewed);
    line("Test emails sent", counts.test_sent);
    line("Customer emails sent and recorded", counts.sent);
    line("Failed (not recorded, will be retried)", counts.failed);
    line("Skipped under the lock", counts.skipped);
    line("SENT BUT NOT RECORDED", counts.sent_unrecorded);
    console.log("");

    const unrecorded = input.outcomes.filter((outcome) => outcome.status === "sent_unrecorded");
    if (unrecorded.length > 0) {
        console.log("!! SENT BUT NOT RECORDED — do NOT re-run for these until the ledger line is added:");
        for (const outcome of unrecorded) {
            console.log(`   ${outcome.ownerEmail} (workspace ${outcome.workspaceId}): add this line to workspaces.notes`);
            console.log(`     ${outcome.ledgerLine}`);
            console.log(`     (${outcome.error})`);
        }
        const notAttempted = countNotAttempted(runPlan.selected, input.outcomes);
        if (notAttempted > 0) {
            console.log(
                `!! RUN STOPPED at the first unrecorded send: ${notAttempted} selected customer(s) were NOT attempted and are still pending.`
            );
        }
        console.log("");
    }

    console.log(`REPORT\n  ${input.reportPath}\n`);
    if (!mode.sends) console.log("No emails were sent. No database rows were changed.\n");
    else if (mode.target === "test") console.log("No customer was contacted. No database rows were changed.\n");
}

/**
 * `--sample`: synthetic data, explicit test addresses, nothing else. Deliberately free of the
 * database, the CSV, the report folder and the ledger: it does not use `Pool`, `readOrdersCsv`,
 * `mkdirSync` or `writeFileSync`, and `main` calls it before any of them.
 */
async function runSampleMode(mode: SendMode, emailConfig: EmailConfig): Promise<void> {
    const blockers = sampleSendBlockers(emailConfig);
    if (mode.sends) {
        // Refuse before the mail server is contacted. There is no override: a sample must show all four links.
        if (blockers.length > 0) {
            throw new Error(
                `Sample send refused: ${blockers.join("; ")}. Set the missing values in the environment; a sample must show all four platform links.`
            );
        }
        readSmtpSettings(process.env);
    }

    const sender = createGuardedSender({
        mode,
        liveRecipients: new Set(), // a sample has no customers
        rawSender: (request, options) =>
            sendFreeYearEmail(request, { env: process.env, createTransport: (config) => nodemailer.createTransport(config) }, options),
    });
    const outcomes = await runSampleStage({ mode, emailConfig, sender });

    printSampleSummary({ mode, emailConfig, blockers, outcomes });
    process.exitCode = outcomes.some((outcome) => outcome.status === "failed") ? 1 : 0;
}

function printSampleSummary(input: {
    mode: SendMode;
    emailConfig: EmailConfig;
    blockers: readonly string[];
    outcomes: readonly SampleOutcome[];
}): void {
    const { mode, emailConfig } = input;
    const content = renderSampleEmail(emailConfig);
    const link = (label: string, url: string | null) => console.log(`    ${label.padEnd(8)} ${url ?? "NOT SET"}`);

    console.log("");
    console.log("=".repeat(78));
    console.log("  LEGACY SHOPIFY MIGRATION — SAMPLE EMAIL (synthetic data)");
    console.log("=".repeat(78));
    console.log(
        mode.sends
            ? "  MODE     : SAMPLE SEND — delivers the sample email to the addresses below, and ONLY those."
            : "  MODE     : SAMPLE PREVIEW — nothing is sent. Add --send-sample to deliver it."
    );
    console.log("             No customers, database, CSV, workspaces or email ledger are involved.");
    console.log("");
    console.log(`  Recipients (${mode.testRecipients.length}, exactly as given): ${mode.testRecipients.join(", ")}`);
    console.log(`  Sample customer : ${SAMPLE_CUSTOMER_NAME}`);
    console.log(`  Sample dates    : ${SAMPLE_START_DATE}  ->  ${SAMPLE_EXPIRY_DATE}`);
    console.log(`  Support address : ${emailConfig.supportEmail ?? "NOT SET"}`);
    console.log(`  From            : ${process.env.EMAIL_FROM?.trim() || "(the SMTP user)"}`);
    console.log("  Platform links  :");
    link("Android", emailConfig.androidUrl);
    link("Windows", emailConfig.windowsUrl);
    link("iOS", emailConfig.iosUrl);
    link("macOS", emailConfig.macosUrl);
    if (input.blockers.length > 0) {
        console.log(`  !! A SAMPLE SEND WOULD BE REFUSED: ${input.blockers.join("; ")}`);
    }
    console.log("");
    console.log(`  Subject: ${content.subject}`);
    console.log("  Body (plain-text part):");
    for (const textLine of content.text.split("\n")) console.log(`  | ${textLine}`);
    console.log("");

    for (const outcome of input.outcomes) {
        console.log(`  ${outcome.status.padEnd(10)} ${outcome.to}${outcome.error ? `  ERROR: ${outcome.error}` : ""}`);
    }
    console.log("");
    if (!mode.sends) {
        console.log("No email was sent. Nothing was read from or written to a database, a CSV or a ledger.\n");
    } else {
        console.log(`Delivered to ${input.outcomes.filter((outcome) => outcome.status === "sent").length} of ${input.outcomes.length} address(es).`);
        console.log("No customer was contacted. Nothing was read from or written to a database, a CSV or a ledger.\n");
    }
}

async function main(): Promise<void> {
    const args = parseSendEmailsArgs(process.argv.slice(2));
    const mode = resolveSendMode(args);
    const runDate = new Date();
    const emailConfig = readEmailConfig(process.env);

    // Sample mode never reaches the code below: no DATABASE_URL, no Pool, no CSV, no report folder.
    if (mode.target === "sample") {
        await runSampleMode(mode, emailConfig);
        return;
    }

    const blockers = liveSendBlockers(emailConfig, mode);
    const liveSend = mode.sends && mode.target === "live";

    // Refuse before touching the database or the mail server.
    if (liveSend && blockers.length > 0) {
        throw new Error(
            `Live send refused: ${blockers.join("; ")}. Set the platform links in .env, or pass --allow-missing-platform-links if sending without them is approved.`
        );
    }
    if (mode.sends) {
        const issues = emailConfigIssues(emailConfig);
        if (issues.length > 0) throw new Error(`Email configuration is incomplete: ${issues.join("; ")}`);
        readSmtpSettings(process.env);
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is not set. Stage 2 reads the migrated workspaces and their email ledger from the database.");
    }

    // The CSV supplies the customer's name for the greeting, exactly as stage 1 would have.
    const csvPath = resolve(process.cwd(), args.csvPath);
    const plan = buildMigrationPlan(readOrdersCsv(csvPath));
    const nameByEmail = new Map(plan.customers.filter((customer) => customer.email).map((customer) => [customer.email, customer.customerName]));

    const pool = new Pool({ connectionString: databaseUrl });
    try {
        const rows = await loadMigratedWorkspaces(pool);

        if (mode.target === "test") {
            assertTestRecipientsAreNotCustomers(mode.testRecipients, [...rows.map((row) => row.owner_email), ...nameByEmail.keys()]);
        }

        const context = { nameByEmail, now: runDate };
        const runPlan = planEmailRun(rows, context, mode.limit, mode.onlyEmails);
        // A live exact-recipient run is refused outright, before any lock or SMTP call, unless every
        // listed address can be emailed or is already done. A preview just reports it.
        if (mode.sends) assertTargetingActionable(runPlan.targeting);

        const sender = createGuardedSender({
            mode,
            liveRecipients: new Set(runPlan.selected.map((candidate) => candidate.email)),
            rawSender: (request, options) =>
                sendFreeYearEmail(request, { env: process.env, createTransport: (config) => nodemailer.createTransport(config) }, options),
        });

        const outcomes = await runEmailStage({
            mode,
            selected: runPlan.selected,
            emailConfig,
            sender,
            ledger: liveSend ? createPgLedgerRunner(pool) : null,
            context,
        });

        const outDir = resolve(process.cwd(), args.outDir);
        mkdirSync(outDir, { recursive: true });
        const reportPath = resolve(outDir, `legacy-shopify-send-emails-${runDate.toISOString().replace(/[:.]/g, "-")}.csv`);
        writeReport(mode, outcomes, reportPath);

        printSummary({ mode, runDate, emailConfig, totalMigrated: rows.length, runPlan, outcomes, blockers, reportPath });

        process.exitCode = emailRunExitCode(outcomes);
    } finally {
        await pool.end();
    }
}

const invoked = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invoked.endsWith("/send-emails.ts") || invoked.endsWith("/send-emails.js")) {
    main().catch((error) => {
        console.error("Legacy Shopify customer migration stage 2 (send emails) failed.");
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}

export { main as runLegacyShopifySendEmails };
