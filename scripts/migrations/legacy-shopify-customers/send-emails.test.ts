/**
 * Stage 2 (send-emails) tests.
 *
 * Nothing here can reach a mail server or a database: the mail transport, the
 * sender and the ledger are all in-memory fakes, and a source scan at the bottom
 * fails the suite if a test file ever imports `pg` or `nodemailer`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import {
    applyCreateLimit,
    applyOneCustomer,
    assertTargetActionable,
    buildTargetReport,
    decideCustomer,
    notesIndicateFreeYearEmailSent,
    parseEmailAllowlist,
    resolveWriteMode,
    parseApplyArgs,
    selectDecisions,
    type ApplyDecision,
    type ApplyExecutor,
    type EmailConfig,
    type ExistingWorkspace,
    type TransactionRunner,
} from "./apply-core.ts";
import { buildMigrationPlan } from "./build-plan.ts";
import {
    buildFreeYearMessage,
    readSmtpSettings,
    sendFreeYearEmail,
    type FreeYearEmailRequest,
    type MailMessage,
    type SendMailResult,
    type SmtpTransportConfig,
    type TransportDeps,
} from "./email-transport.ts";
import { EMAIL_SUBJECTS, emailSubjectFor, getLegacyFreeYearEmailContent, type PurchaseSummary } from "./migration-email.ts";
import { parseOrdersCsvText, readOrdersCsv } from "./orders-csv.ts";
import { ELIGIBLE_PRODUCTS } from "./product-eligibility.ts";
import { buildPurchaseIndex } from "./purchase-summary.ts";
import {
    DEFAULT_TEST_LIMIT,
    EMAIL_OUTCOME_STATUSES,
    SAMPLE_ACCOUNT_EMAIL,
    SAMPLE_CUSTOMER_NAME,
    SAMPLE_EXPIRY_DATE,
    SAMPLE_START_DATE,
    SAMPLE_WORKSPACE_NAME,
    TEST_MODE_HEADER,
    assertTargetingActionable,
    assertTestRecipientsAreNotCustomers,
    buildSamplePurchase,
    buildSampleRequest,
    classifyWorkspace,
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
    type ClassifyContext,
    type EmailSender,
    type LedgerRunner,
    type LedgerTransaction,
    type MigratedWorkspaceRow,
} from "./send-emails-core.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-10T12:00:00.000Z");
/** A stage 1 run on 2026-11-04 expires 365 days later. */
const EXPIRES = new Date("2027-11-04T09:00:00.000Z");

const FULL_CONFIG: EmailConfig = {
    androidUrl: "https://play.google.com/store/apps/details?id=com.wtt.healthAge",
    windowsUrl: "https://apps.microsoft.com/detail/9P8MFP2CBVL5",
    iosUrl: "https://apps.apple.com/example-ios",
    macosUrl: "https://apps.apple.com/example-macos",
    supportEmail: "support@healthexporesources.com",
};
const NO_APPLE_CONFIG: EmailConfig = { ...FULL_CONFIG, iosUrl: null, macosUrl: null };

const NAMES = new Map<string, string>([
    ["ann@example.com", "Ann Archer"],
    ["bob@example.com", "Bob Baker"],
    ["cy@example.com", "Cy Clark"],
    ["dee@example.com", "Dee Doyle"],
    ["eve@example.com", ""],
]);
/** A 1-license software purchase: matches `row()`'s default seat_limit of 1. */
const ONE_LICENSE: PurchaseSummary = {
    licenses: 1,
    lines: [{ kind: "dyha", label: "Discover Your Health Age", units: 1, licenses: 1 }],
};
const PURCHASES = new Map<string, PurchaseSummary>([...NAMES.keys()].map((email) => [email, ONE_LICENSE]));
const CONTEXT = { nameByEmail: NAMES, purchaseByEmail: PURCHASES, now: NOW };

function row(id: string, email: string, overrides: Partial<MigratedWorkspaceRow> = {}): MigratedWorkspaceRow {
    return {
        id,
        name: "Org",
        owner_email: email,
        status: "active",
        subscription_status: "active",
        expires_at: EXPIRES,
        notes: "Legacy Shopify migration — order(s) #1",
        billing_source: "legacy_shopify_migration",
        seat_limit: 1,
        owner_member_status: "invited",
        user_status: null,
        ...overrides,
    };
}

const standardRows = () => [
    row("ws-ann", "ann@example.com"),
    row("ws-bob", "bob@example.com"),
    row("ws-cy", "cy@example.com"),
    row("ws-dee", "dee@example.com"),
];

/** Records every send attempt; can be told to fail for chosen addresses. */
function createSenderLog(failFor: readonly string[] = []) {
    const failing = new Set(failFor.map((address) => address.toLowerCase()));
    const sent: Array<{ request: FreeYearEmailRequest; headers: Readonly<Record<string, string>> | undefined }> = [];
    const attempts: string[] = [];
    const raw: EmailSender = async (request, options) => {
        attempts.push(request.to);
        if (failing.has(request.to.toLowerCase())) throw new Error("smtp 451 temporary failure");
        sent.push({ request, headers: options?.headers });
    };
    return { sent, attempts, raw, recipients: () => sent.map((entry) => entry.request.to) };
}

/**
 * In-memory ledger. `claimWorkspace` takes a per-workspace lock held until the
 * transaction ends (like the advisory lock), and ledger writes apply only at
 * commit, so a rolled-back or failed commit leaves no trace.
 */
function createLedgerDb(initial: readonly MigratedWorkspaceRow[]) {
    const workspaces = new Map(initial.map((workspace) => [workspace.id, { ...workspace }]));
    const locks = new Map<string, Promise<void>>();
    const failures: { record: Error | null; commit: Error | null } = { record: null, commit: null };
    let transactions = 0;
    let ledgerWrites = 0;

    const runner: LedgerRunner = {
        async runInTransaction<T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
            transactions += 1;
            const releases: Array<() => void> = [];
            const staged = new Map<string, string>();

            const tx: LedgerTransaction = {
                async claimWorkspace(workspaceId) {
                    const previous = locks.get(workspaceId) ?? Promise.resolve();
                    let release!: () => void;
                    const mine = new Promise<void>((resolveLock) => {
                        release = resolveLock;
                    });
                    locks.set(workspaceId, previous.then(() => mine));
                    await previous;
                    releases.push(release);
                    const current = workspaces.get(workspaceId);
                    return current
                        ? {
                              id: current.id,
                              name: current.name,
                              owner_email: current.owner_email,
                              status: current.status,
                              subscription_status: current.subscription_status,
                              expires_at: current.expires_at,
                              notes: current.notes,
                              billing_source: current.billing_source,
                              seat_limit: current.seat_limit,
                          }
                        : null;
                },
                async recordEmailSent(workspaceId, markerLine) {
                    if (failures.record) throw failures.record;
                    staged.set(workspaceId, markerLine);
                },
            };

            try {
                const result = await fn(tx);
                if (failures.commit) throw failures.commit;
                for (const [workspaceId, markerLine] of staged) {
                    const current = workspaces.get(workspaceId)!;
                    const base = (current.notes ?? "").trim();
                    workspaces.set(workspaceId, { ...current, notes: base ? `${base}\n${markerLine}` : markerLine });
                    ledgerWrites += 1;
                }
                return result;
            } finally {
                for (const release of releases) release();
            }
        },
    };

    return {
        runner,
        failures,
        rows: () => [...workspaces.values()],
        get: (id: string) => workspaces.get(id)!,
        transactions: () => transactions,
        ledgerWrites: () => ledgerWrites,
    };
}

/** Runs the same sequence as the CLI: parse -> mode -> plan -> guarded sender -> stage. */
async function runStage(input: {
    args: string[];
    db: ReturnType<typeof createLedgerDb>;
    log: ReturnType<typeof createSenderLog>;
    config?: EmailConfig;
    /** Replaces the db's own ledger runner, e.g. with `failingLedger(...)`. */
    ledger?: LedgerRunner;
    /** Customer names / clock; defaults to the ann/bob/cy/dee fixtures. */
    context?: ClassifyContext;
}) {
    const context = input.context ?? CONTEXT;
    const mode = resolveSendMode(parseSendEmailsArgs(input.args));
    const runPlan = planEmailRun(input.db.rows(), context, mode.limit, mode.onlyEmails);
    // Same order as the CLI: a live exact-recipient run is refused before any sender exists.
    if (mode.sends) assertTargetingActionable(runPlan.targeting);
    const sender = createGuardedSender({
        mode,
        liveRecipients: new Set(runPlan.selected.map((candidate) => candidate.email)),
        rawSender: input.log.raw,
    });
    const outcomes = await runEmailStage({
        mode,
        selected: runPlan.selected,
        emailConfig: input.config ?? FULL_CONFIG,
        sender,
        ledger: mode.sends && mode.target === "live" ? (input.ledger ?? input.db.runner) : null,
        context,
        now: () => NOW,
    });
    return { mode, runPlan, outcomes };
}

/**
 * A ledger whose WRITE fails for chosen workspaces; the lock/read side and every
 * other write go to the real in-memory ledger. `claimed` lists, in order, every
 * workspace a transaction was opened for, which is how a test proves that a
 * customer was never even looked at. With `once`, each chosen workspace fails only
 * the first time, i.e. a transient fault that would have cleared for the next one.
 */
function failingLedger(
    db: ReturnType<typeof createLedgerDb>,
    failForWorkspaces: readonly string[],
    options: { once?: boolean } = {}
) {
    const remaining = new Set(failForWorkspaces);
    const claimed: string[] = [];
    const runner: LedgerRunner = {
        runInTransaction: (fn) =>
            db.runner.runInTransaction((tx) =>
                fn({
                    claimWorkspace: async (workspaceId) => {
                        claimed.push(workspaceId);
                        return tx.claimWorkspace(workspaceId);
                    },
                    recordEmailSent: async (workspaceId, markerLine) => {
                        if (remaining.has(workspaceId)) {
                            if (options.once) remaining.delete(workspaceId);
                            throw new Error("connection reset");
                        }
                        return tx.recordEmailSent(workspaceId, markerLine);
                    },
                })
            ),
    };
    return { runner, claimed };
}

// ---------------------------------------------------------------------------
// Arguments and mode
// ---------------------------------------------------------------------------

describe("stage 2 arguments and mode resolution", () => {
    const modeOf = (...args: string[]) => resolveSendMode(parseSendEmailsArgs(args));

    it("no flags is a preview: nothing sends", () => {
        const mode = modeOf();
        assert.equal(mode.sends, false);
        assert.equal(mode.target, "live");
    });

    it("--dry-run previews even when --send and a scope are also passed", () => {
        const mode = modeOf("--send", "--limit=5", "--dry-run");
        assert.equal(mode.sends, false);
    });

    it("a live send needs --send and an explicit scope (--limit=N or --all)", () => {
        assert.throws(() => modeOf("--send"), /explicit scope/);
        assert.deepEqual(
            { sends: modeOf("--send", "--limit=2").sends, limit: modeOf("--send", "--limit=2").limit },
            { sends: true, limit: 2 }
        );
        const everyone = modeOf("--send", "--all");
        assert.equal(everyone.sends, true);
        assert.equal(everyone.limit, null);
    });

    it("--all and --limit contradict each other", () => {
        assert.throws(() => modeOf("--send", "--all", "--limit=3"), /cannot be combined/);
    });

    it("--send and --test-recipients can never be combined", () => {
        assert.throws(() => modeOf("--send", "--limit=1", "--test-recipients=me@test.example"), /cannot be combined/);
    });

    it("--test-recipients selects test mode, defaults to one customer, and honours --limit", () => {
        const mode = modeOf("--test-recipients=me@test.example");
        assert.equal(mode.target, "test");
        assert.equal(mode.sends, true);
        assert.equal(mode.limit, DEFAULT_TEST_LIMIT);
        assert.equal(DEFAULT_TEST_LIMIT, 1);
        assert.equal(modeOf("--test-recipients=me@test.example", "--limit=3").limit, 3);
        assert.throws(() => modeOf("--test-recipients=me@test.example", "--all"), /not allowed/);
    });

    it("--dry-run turns a test send into a preview", () => {
        const mode = modeOf("--test-recipients=me@test.example", "--dry-run");
        assert.equal(mode.target, "test");
        assert.equal(mode.sends, false);
    });

    it("the test allowlist is trimmed, lower-cased and de-duplicated", () => {
        const args = parseSendEmailsArgs(["--test-recipients= Me@Test.example , you@test.example,ME@test.example,"]);
        assert.deepEqual(args.testRecipients, ["me@test.example", "you@test.example"]);
    });

    it("an empty or invalid allowlist, or a repeated flag, is rejected", () => {
        assert.throws(() => parseSendEmailsArgs(["--test-recipients="]), /at least one address/);
        assert.throws(() => parseSendEmailsArgs(["--test-recipients=,"]), /at least one address/);
        assert.throws(() => parseSendEmailsArgs(["--test-recipients=not-an-email"]), /invalid address/);
        assert.throws(
            () => parseSendEmailsArgs(["--test-recipients=a@test.example", "--test-recipients=b@test.example"]),
            /more than once/
        );
    });

    it("unknown flags are rejected, including the stage 1 flags", () => {
        assert.throws(() => parseSendEmailsArgs(["--apply"]), /Unknown argument: --apply/);
        assert.throws(() => parseSendEmailsArgs(["--no-email"]), /Unknown argument/);
        assert.throws(() => parseSendEmailsArgs(["--sned"]), /Unknown argument: --sned/);
        assert.throws(() => parseSendEmailsArgs(["--test-recipient=a@test.example"]), /Unknown argument/);
        assert.throws(() => parseSendEmailsArgs(["--limit=0"]), /Invalid --limit/);
        assert.throws(() => parseSendEmailsArgs(["--limit=1.5"]), /Invalid --limit/);
    });

    it("accepts the pnpm '--' separator and every documented flag", () => {
        const args = parseSendEmailsArgs([
            "--",
            "--dry-run",
            "--send",
            "--all",
            "--allow-missing-platform-links",
            "--csv=x.csv",
            "--out=reports",
        ]);
        assert.deepEqual(args, {
            csvPath: "x.csv",
            outDir: "reports",
            dryRun: true,
            send: true,
            all: true,
            limit: null,
            testRecipients: [],
            onlyEmails: [],
            allowMissingPlatformLinks: true,
            sample: false,
            sendSample: false,
            sampleProduct: null,
            csvExplicit: true,
            outExplicit: true,
        });
    });

    it("a live send is blocked until the iOS and macOS links are configured, unless explicitly overridden", () => {
        const strict = { allowMissingPlatformLinks: false };
        assert.deepEqual(liveSendBlockers(FULL_CONFIG, strict), []);
        assert.deepEqual(liveSendBlockers(NO_APPLE_CONFIG, strict), [
            "HEALTHAGE_IOS_URL is not set",
            "HEALTHAGE_MACOS_URL is not set",
        ]);
        assert.deepEqual(liveSendBlockers(NO_APPLE_CONFIG, { allowMissingPlatformLinks: true }), []);
        // The override covers the Apple links only, never a missing support address.
        assert.ok(liveSendBlockers({ ...FULL_CONFIG, supportEmail: null }, { allowMissingPlatformLinks: true }).length > 0);
    });
});

// ---------------------------------------------------------------------------
// Who is owed the email
// ---------------------------------------------------------------------------

describe("stage 2 eligibility (migration records + email ledger)", () => {
    const skipReasonOf = (workspace: MigratedWorkspaceRow) => {
        const result = classifyWorkspace(workspace, CONTEXT);
        return result.kind === "skip" ? result.reason : "pending";
    };

    it("a fresh stage 1 workspace is pending, greeted by the CSV billing name", () => {
        const result = classifyWorkspace(row("w", "Ann@Example.com"), CONTEXT);
        assert.equal(result.kind, "pending");
        if (result.kind === "pending") {
            assert.equal(result.candidate.email, "ann@example.com");
            assert.equal(result.candidate.displayName, "Ann Archer");
        }
    });

    it("falls back to the customer's own address when the CSV has no billing name", () => {
        const result = classifyWorkspace(row("w", "eve@example.com"), CONTEXT);
        assert.equal(result.kind === "pending" && result.candidate.displayName, "eve");
    });

    it("start date is the expiry minus 365 days, the expiry is the workspace expiry", () => {
        const result = classifyWorkspace(row("w", "ann@example.com"), CONTEXT);
        assert.equal(result.kind === "pending" && result.candidate.startDate, "2026-11-04");
        assert.equal(result.kind === "pending" && result.candidate.expiryDate, "2027-11-04");

        // 365 days back from 29 Feb 2028 is 1 Mar 2027: the leap day is counted, as in stage 1.
        const leap = classifyWorkspace(row("w", "ann@example.com", { expires_at: new Date("2028-02-29T10:00:00.000Z") }), CONTEXT);
        assert.equal(leap.kind === "pending" && leap.candidate.startDate, "2027-03-01");
        assert.equal(leap.kind === "pending" && leap.candidate.expiryDate, "2028-02-29");
    });

    it("invited and active owner memberships are both eligible", () => {
        assert.equal(skipReasonOf(row("w", "ann@example.com", { owner_member_status: "invited" })), "pending");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { owner_member_status: "active", user_status: "active" })), "pending");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { user_status: "pending" })), "pending");
    });

    it("never selects a workspace the ledger says was already emailed", () => {
        const emailed = row("w", "ann@example.com", {
            notes: "Legacy Shopify migration — order(s) #1\nfree_year_email_sent_at: 2026-11-05T10:00:00.000Z",
        });
        assert.equal(skipReasonOf(emailed), "already_emailed");
        // Stage 1 wrote the same marker when it emailed inline, so those customers are covered too.
        assert.equal(skipReasonOf(row("w", "ann@example.com", { notes: "free_year_email_sent_at: 2026-08-17T00:00:00.000Z" })), "already_emailed");
    });

    it("skips everything that is not a currently valid stage 1 customer, with a reason", () => {
        assert.equal(skipReasonOf(row("w", "ann@example.com", { billing_source: "shopify" })), "not_migration_workspace");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { billing_source: "manual" })), "not_migration_workspace");
        assert.equal(skipReasonOf(row("w", "not-an-email")), "invalid_owner_email");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { status: "revoked" })), "workspace_not_active");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { status: "suspended" })), "workspace_not_active");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { subscription_status: "expired" })), "workspace_not_active");
        assert.equal(
            skipReasonOf(row("w", "ann@example.com", { expires_at: new Date("2026-11-09T00:00:00.000Z") })),
            "workspace_not_active"
        );
        assert.equal(skipReasonOf(row("w", "ann@example.com", { expires_at: null })), "no_expiry_on_record");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { owner_member_status: null })), "owner_membership_inactive");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { owner_member_status: "revoked" })), "owner_membership_inactive");
        assert.equal(skipReasonOf(row("w", "ann@example.com", { user_status: "disabled" })), "account_disabled");
        assert.equal(skipReasonOf(row("w", "stranger@example.com")), "not_in_csv_plan");
    });

    it("orders pending customers by email and applies --limit to that order", () => {
        const shuffled = [row("3", "dee@example.com"), row("1", "ann@example.com"), row("4", "cy@example.com"), row("2", "bob@example.com")];
        const plan = planEmailRun(shuffled, CONTEXT, 2);
        assert.deepEqual(plan.pending.map((candidate) => candidate.email), ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"]);
        assert.deepEqual(plan.selected.map((candidate) => candidate.email), ["ann@example.com", "bob@example.com"]);
        assert.equal(planEmailRun(shuffled, CONTEXT, null).selected.length, 4);
    });

    it("reports what it skipped", () => {
        const plan = planEmailRun(
            [row("1", "ann@example.com"), row("2", "bob@example.com", { notes: "free_year_email_sent_at: x" }), row("3", "cy@example.com", { status: "revoked" })],
            CONTEXT,
            null
        );
        assert.equal(plan.pending.length, 1);
        assert.deepEqual(plan.skipped.map((entry) => entry.reason).sort(), ["already_emailed", "workspace_not_active"]);
    });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("stage 2 preview (--dry-run and the default)", () => {
    for (const args of [[], ["--dry-run"], ["--send", "--all", "--dry-run"], ["--send", "--limit=2", "--dry-run"]]) {
        it(`sends nothing and writes nothing: ${args.join(" ") || "(no flags)"}`, async () => {
            const db = createLedgerDb(standardRows());
            const log = createSenderLog();
            const before = JSON.stringify(db.rows());
            const { outcomes } = await runStage({ args, db, log });

            assert.deepEqual(log.attempts, []);
            assert.equal(db.transactions(), 0);
            assert.equal(db.ledgerWrites(), 0);
            assert.equal(JSON.stringify(db.rows()), before);
            assert.ok(outcomes.length > 0);
            assert.ok(outcomes.every((outcome) => outcome.status === "previewed"));
        });
    }

    it("lists the customers a live send would email", async () => {
        const { outcomes } = await runStage({ args: ["--dry-run"], db: createLedgerDb(standardRows()), log: createSenderLog() });
        assert.deepEqual(outcomes.map((outcome) => outcome.deliveredTo[0]), ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"]);
    });

    it("a previewed test run shows the test addresses, not the customers", async () => {
        const { outcomes } = await runStage({
            args: ["--test-recipients=me@test.example", "--dry-run"],
            db: createLedgerDb(standardRows()),
            log: createSenderLog(),
        });
        assert.deepEqual(outcomes.map((outcome) => outcome.deliveredTo), [["me@test.example"]]);
        assert.equal(outcomes[0]?.ownerEmail, "ann@example.com");
    });

    it("the guard itself refuses to send in a preview even if the code above it is wrong", async () => {
        const log = createSenderLog();
        const mode = resolveSendMode(parseSendEmailsArgs([]));
        const guarded = createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw });
        await assert.rejects(
            guarded({ ...baseRequest(), to: "ann@example.com" }),
            /preview/
        );
        assert.deepEqual(log.attempts, []);
    });
});

function baseRequest(overrides: Partial<FreeYearEmailRequest> = {}): FreeYearEmailRequest {
    return {
        to: "ann@example.com",
        customerName: "Ann Archer",
        accountEmail: "ann@example.com",
        workspaceName: "Org",
        purchase: ONE_LICENSE,
        startDate: "2026-11-04",
        expiryDate: "2027-11-04",
        androidUrl: FULL_CONFIG.androidUrl,
        windowsUrl: FULL_CONFIG.windowsUrl,
        iosUrl: FULL_CONFIG.iosUrl,
        macosUrl: FULL_CONFIG.macosUrl,
        supportEmail: FULL_CONFIG.supportEmail!,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Live send and the ledger
// ---------------------------------------------------------------------------

describe("stage 2 live send", () => {
    it("emails each pending customer once and records it in the existing ledger", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const { outcomes } = await runStage({ args: ["--send", "--all"], db, log });

        assert.deepEqual(log.recipients(), ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"]);
        assert.ok(outcomes.every((outcome) => outcome.status === "sent"));
        for (const workspace of db.rows()) {
            assert.equal(notesIndicateFreeYearEmailSent(workspace.notes), true);
            assert.match(workspace.notes ?? "", /^Legacy Shopify migration — order\(s\) #1\nfree_year_email_sent_at: 2026-11-10T12:00:00\.000Z$/);
        }
        assert.equal(db.ledgerWrites(), 4);
    });

    it("carries the grant dates, greeting and platform links from the workspace and configuration", async () => {
        const log = createSenderLog();
        await runStage({ args: ["--send", "--limit=1"], db: createLedgerDb(standardRows()), log });
        const request = log.sent[0]!.request;
        assert.equal(request.to, "ann@example.com");
        assert.equal(request.customerName, "Ann Archer");
        assert.equal(request.startDate, "2026-11-04");
        assert.equal(request.expiryDate, "2027-11-04");
        assert.equal(request.iosUrl, FULL_CONFIG.iosUrl);
        assert.equal(request.macosUrl, FULL_CONFIG.macosUrl);
        assert.equal(request.supportEmail, FULL_CONFIG.supportEmail);
        assert.equal(log.sent[0]!.headers, undefined, "live messages carry no test marker");
    });

    it("never resends an email that was already recorded, in the same run or a later one", async () => {
        const rows = standardRows();
        rows[1] = row("ws-bob", "bob@example.com", { notes: "Legacy Shopify migration — order(s) #1\nfree_year_email_sent_at: 2026-11-05T08:00:00.000Z" });
        const db = createLedgerDb(rows);
        const log = createSenderLog();

        await runStage({ args: ["--send", "--all"], db, log });
        assert.ok(!log.recipients().includes("bob@example.com"));
        assert.equal(log.sent.length, 3);

        const second = createSenderLog();
        const rerun = await runStage({ args: ["--send", "--all"], db, log: second });
        assert.deepEqual(second.attempts, []);
        assert.equal(rerun.outcomes.length, 0);
        assert.equal(db.ledgerWrites(), 3, "no ledger entry is written twice");
    });

    it("--limit=N sends exactly N, in a stable order, and successive runs walk the list", async () => {
        const db = createLedgerDb(standardRows());
        const first = createSenderLog();
        await runStage({ args: ["--send", "--limit=2"], db, log: first });
        assert.deepEqual(first.recipients(), ["ann@example.com", "bob@example.com"]);

        const second = createSenderLog();
        await runStage({ args: ["--send", "--limit=2"], db, log: second });
        assert.deepEqual(second.recipients(), ["cy@example.com", "dee@example.com"]);

        const third = createSenderLog();
        await runStage({ args: ["--send", "--limit=2"], db, log: third });
        assert.deepEqual(third.attempts, []);
    });

    it("a failed send writes nothing, is reported, does not stop the others, and is retried next run", async () => {
        const db = createLedgerDb(standardRows());
        const flaky = createSenderLog(["bob@example.com"]);
        const { outcomes } = await runStage({ args: ["--send", "--all"], db, log: flaky });

        const byEmail = Object.fromEntries(outcomes.map((outcome) => [outcome.ownerEmail, outcome]));
        assert.equal(byEmail["bob@example.com"]?.status, "failed");
        assert.match(byEmail["bob@example.com"]?.error ?? "", /451/);
        assert.deepEqual(
            ["ann@example.com", "cy@example.com", "dee@example.com"].map((email) => byEmail[email]?.status),
            ["sent", "sent", "sent"]
        );
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-bob").notes), false);
        assert.equal(db.get("ws-bob").notes, "Legacy Shopify migration — order(s) #1");

        const retry = createSenderLog();
        const again = await runStage({ args: ["--send", "--all"], db, log: retry });
        assert.deepEqual(retry.recipients(), ["bob@example.com"], "only the failed customer is retried");
        assert.equal(again.outcomes[0]?.status, "sent");
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-bob").notes), true);
    });

    it("if the ledger write fails after a successful send it is flagged loudly with the line to add by hand", async () => {
        const db = createLedgerDb([row("ws-ann", "ann@example.com")]);
        db.failures.record = new Error("connection reset");
        const log = createSenderLog();
        const { outcomes } = await runStage({ args: ["--send", "--limit=1"], db, log });

        assert.equal(log.sent.length, 1);
        assert.equal(outcomes[0]?.status, "sent_unrecorded");
        assert.match(outcomes[0]?.ledgerLine ?? "", /^free_year_email_sent_at: 2026-11-10T12:00:00\.000Z$/);
        assert.match(outcomes[0]?.error ?? "", /connection reset/);
        assert.equal(summarizeOutcomes(outcomes).sent_unrecorded, 1);
    });

    it("an unconfirmed commit after a successful send is also treated as sent-but-unrecorded, not as a failure to retry", async () => {
        const db = createLedgerDb([row("ws-ann", "ann@example.com")]);
        db.failures.commit = new Error("commit status unknown");
        const log = createSenderLog();
        const { outcomes } = await runStage({ args: ["--send", "--limit=1"], db, log });
        assert.equal(outcomes[0]?.status, "sent_unrecorded");
        assert.notEqual(outcomes[0]?.status, "failed");
    });

    it("two overlapping live runs email each customer exactly once", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const [a, b] = await Promise.all([
            runStage({ args: ["--send", "--all"], db, log }),
            runStage({ args: ["--send", "--all"], db, log }),
        ]);

        assert.deepEqual([...log.recipients()].sort(), ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"]);
        assert.equal(db.ledgerWrites(), 4);
        const all = [...a.outcomes, ...b.outcomes];
        assert.equal(all.filter((outcome) => outcome.status === "sent").length, 4);
        assert.ok(all.filter((outcome) => outcome.status === "skipped").every((outcome) => outcome.reason === "already_emailed"));
    });

    it("re-checks under the lock: a workspace revoked after the preview is skipped, not emailed", async () => {
        const db = createLedgerDb([row("ws-ann", "ann@example.com")]);
        const mode = resolveSendMode(parseSendEmailsArgs(["--send", "--all"]));
        const runPlan = planEmailRun(db.rows(), CONTEXT, mode.limit);
        assert.equal(runPlan.selected.length, 1);

        // Between planning and sending, an admin revokes the workspace.
        const revoked = { ...db.get("ws-ann"), status: "revoked" };
        const log = createSenderLog();
        const staleDb = createLedgerDb([revoked]);
        const outcomes = await runEmailStage({
            mode,
            selected: runPlan.selected,
            emailConfig: FULL_CONFIG,
            sender: createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw }),
            ledger: staleDb.runner,
            context: CONTEXT,
            now: () => NOW,
        });
        assert.deepEqual(log.attempts, []);
        assert.equal(outcomes[0]?.status, "skipped");
        assert.equal(outcomes[0]?.reason, "workspace_not_active");
    });

    it("the live guard refuses any address that is not a selected pending customer", async () => {
        const log = createSenderLog();
        const mode = resolveSendMode(parseSendEmailsArgs(["--send", "--limit=1"]));
        const guarded = createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw });
        await assert.rejects(guarded({ ...baseRequest(), to: "someone.else@example.com" }), /not a selected pending/);
        await guarded({ ...baseRequest(), to: "Ann@Example.com" });
        assert.deepEqual(log.attempts, ["Ann@Example.com"]);
    });

    it("refuses to send without a ledger, or with an incomplete email configuration", async () => {
        const mode = resolveSendMode(parseSendEmailsArgs(["--send", "--all"]));
        const plan = planEmailRun(standardRows(), CONTEXT, null);
        const log = createSenderLog();
        const sender = createGuardedSender({ mode, liveRecipients: new Set(plan.selected.map((c) => c.email)), rawSender: log.raw });

        await assert.rejects(
            runEmailStage({ mode, selected: plan.selected, emailConfig: FULL_CONFIG, sender, ledger: null, context: CONTEXT }),
            /needs the email ledger/
        );
        await assert.rejects(
            runEmailStage({
                mode,
                selected: plan.selected,
                emailConfig: { ...FULL_CONFIG, supportEmail: null },
                sender,
                ledger: createLedgerDb(standardRows()).runner,
                context: CONTEXT,
            }),
            /configuration is incomplete/
        );
        assert.deepEqual(log.attempts, []);
    });
});

// ---------------------------------------------------------------------------
// A message went out but the ledger does not know: the run must stop
// ---------------------------------------------------------------------------

describe("stage 2 stops at the first SENT BUT NOT RECORDED", () => {
    const ALL = ["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"];
    const statuses = (outcomes: ReadonlyArray<{ status: string }>) => outcomes.map((outcome) => outcome.status);

    it("a fault that hits every ledger write: the first customer is sent_unrecorded and nobody after them is emailed", async () => {
        const db = createLedgerDb(standardRows());
        db.failures.record = new Error("permission denied for table workspaces");
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log });

        assert.equal(runPlan.selected.length, 4, "all four customers were selected");
        assert.deepEqual(log.attempts, ["ann@example.com"], "exactly one send was attempted");
        assert.equal(db.transactions(), 1, "no transaction, and so no lock, was opened for anyone else");
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0]?.status, "sent_unrecorded");
        assert.equal(outcomes[0]?.ownerEmail, "ann@example.com");
        assert.match(outcomes[0]?.error ?? "", /permission denied/);
        assert.match(outcomes[0]?.ledgerLine ?? "", /^free_year_email_sent_at: 2026-11-10T12:00:00\.000Z$/);
        const counts = summarizeOutcomes(outcomes);
        assert.deepEqual({ sent: counts.sent, sent_unrecorded: counts.sent_unrecorded }, { sent: 0, sent_unrecorded: 1 });
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 3);
        assert.equal(db.ledgerWrites(), 0);
    });

    it("a one-off fault stops the run just the same, even though the ledger would have worked for the next customer", async () => {
        const db = createLedgerDb(standardRows());
        const ledger = failingLedger(db, ["ws-ann"], { once: true });
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log, ledger: ledger.runner });

        assert.deepEqual(log.attempts, ["ann@example.com"]);
        assert.deepEqual(ledger.claimed, ["ws-ann"], "no later customer was even locked");
        assert.deepEqual(statuses(outcomes), ["sent_unrecorded"]);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 3);
        for (const id of ["ws-ann", "ws-bob", "ws-cy", "ws-dee"]) {
            assert.equal(notesIndicateFreeYearEmailSent(db.get(id).notes), false, `${id} must be untouched`);
        }
    });

    it("an unconfirmed commit after a successful send stops the run too", async () => {
        const db = createLedgerDb(standardRows());
        db.failures.commit = new Error("commit status unknown");
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log });

        assert.deepEqual(log.attempts, ["ann@example.com"]);
        assert.deepEqual(statuses(outcomes), ["sent_unrecorded"]);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 3);
    });

    it("a fault in the middle keeps earlier customers recorded and leaves later ones untouched", async () => {
        const db = createLedgerDb(standardRows());
        const ledger = failingLedger(db, ["ws-bob"]);
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log, ledger: ledger.runner });

        assert.deepEqual(log.attempts, ["ann@example.com", "bob@example.com"]);
        assert.deepEqual(ledger.claimed, ["ws-ann", "ws-bob"]);
        assert.deepEqual(statuses(outcomes), ["sent", "sent_unrecorded"]);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-ann").notes), true);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-bob").notes), false);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-cy").notes), false);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-dee").notes), false);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 2);
    });

    it("works inside a --limit batch: only the batch is in play, and it still stops at the fault", async () => {
        const db = createLedgerDb(standardRows());
        const ledger = failingLedger(db, ["ws-ann"]);
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--limit=3"], db, log, ledger: ledger.runner });

        assert.equal(runPlan.selected.length, 3);
        assert.deepEqual(log.attempts, ["ann@example.com"]);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 2);
    });

    it("when the unrecorded send is the last selected customer there is simply nothing left to skip", async () => {
        const db = createLedgerDb(standardRows());
        const ledger = failingLedger(db, ["ws-dee"]);
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log, ledger: ledger.runner });

        assert.deepEqual(log.attempts, ALL);
        assert.deepEqual(statuses(outcomes), ["sent", "sent", "sent", "sent_unrecorded"]);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 0);
        assert.equal(emailRunExitCode(outcomes), 1);
    });

    it("the run reports failure: a stopped run exits non-zero, and so does any failed send", async () => {
        const broken = createLedgerDb(standardRows());
        broken.failures.record = new Error("connection reset");
        const stopped = await runStage({ args: ["--send", "--all"], db: broken, log: createSenderLog() });
        assert.equal(emailRunExitCode(stopped.outcomes), 1);

        const failed = await runStage({
            args: ["--send", "--all"],
            db: createLedgerDb(standardRows()),
            log: createSenderLog(["bob@example.com"]),
        });
        assert.equal(emailRunExitCode(failed.outcomes), 1);
    });

    it("the exit code is non-zero for exactly the failed and sent-but-unrecorded outcomes", () => {
        for (const status of EMAIL_OUTCOME_STATUSES) {
            const outcome = {
                workspaceId: "w",
                ownerEmail: "a@example.com",
                deliveredTo: ["a@example.com"],
                status,
                reason: null,
                error: null,
                ledgerLine: null,
            };
            const expected = status === "failed" || status === "sent_unrecorded" ? 1 : 0;
            assert.equal(emailRunExitCode([outcome]), expected, status);
        }
        assert.equal(emailRunExitCode([]), 0, "nothing to do is success");
    });

    it("preview, test and clean live runs all still exit 0", async () => {
        const live = await runStage({ args: ["--send", "--all"], db: createLedgerDb(standardRows()), log: createSenderLog() });
        const preview = await runStage({ args: ["--dry-run"], db: createLedgerDb(standardRows()), log: createSenderLog() });
        const test = await runStage({
            args: ["--test-recipients=qa@test.example"],
            db: createLedgerDb(standardRows()),
            log: createSenderLog(),
        });
        for (const run of [live, preview, test]) assert.equal(emailRunExitCode(run.outcomes), 0);
    });

    it("recovery: once the ledger line is added by hand, a re-run emails exactly the customers who were not attempted, so nobody gets two emails", async () => {
        const first = createLedgerDb(standardRows());
        first.failures.record = new Error("connection reset");
        const firstLog = createSenderLog();
        const { outcomes } = await runStage({ args: ["--send", "--all"], db: first, log: firstLog });
        const line = outcomes[0]?.ledgerLine;
        assert.ok(line, "the outcome carries the exact line to add");

        // The operator adds that line to the first customer's notes, as the report instructs.
        const repaired = createLedgerDb(
            first.rows().map((workspace) => (workspace.id === "ws-ann" ? { ...workspace, notes: `${workspace.notes}\n${line}` } : workspace))
        );
        const rerun = createSenderLog();
        const again = await runStage({ args: ["--send", "--all"], db: repaired, log: rerun });

        assert.deepEqual(firstLog.recipients(), ["ann@example.com"], "the first run emailed only the customer it could not record");
        assert.deepEqual(rerun.recipients(), ["bob@example.com", "cy@example.com", "dee@example.com"]);
        assert.deepEqual(statuses(again.outcomes), ["sent", "sent", "sent"]);
        assert.equal(emailRunExitCode(again.outcomes), 0);
        // Across both runs every customer received exactly one email.
        assert.deepEqual([...firstLog.recipients(), ...rerun.recipients()].sort(), ALL);
    });

    it("an ordinary SMTP failure is NOT a stop: the run continues, nothing is recorded, and the customer is retried next run", async () => {
        const db = createLedgerDb(standardRows());
        const flaky = createSenderLog(["ann@example.com"]); // the FIRST customer fails
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log: flaky });

        assert.deepEqual(flaky.attempts, ALL, "every customer was still attempted");
        assert.deepEqual(statuses(outcomes), ["failed", "sent", "sent", "sent"]);
        assert.match(outcomes[0]?.error ?? "", /451/);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 0);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-ann").notes), false);
        assert.equal(db.ledgerWrites(), 3);
        assert.equal(emailRunExitCode(outcomes), 1, "a failed send still makes the run exit non-zero");

        const retry = createSenderLog();
        const again = await runStage({ args: ["--send", "--all"], db, log: retry });
        assert.deepEqual(retry.recipients(), ["ann@example.com"], "only the failed customer is retried");
        assert.deepEqual(statuses(again.outcomes), ["sent"]);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-ann").notes), true);
        assert.equal(emailRunExitCode(again.outcomes), 0);
    });

    it("SMTP failures scattered through a run never stop it", async () => {
        const db = createLedgerDb(standardRows());
        const flaky = createSenderLog(["ann@example.com", "cy@example.com"]);
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log: flaky });

        assert.deepEqual(flaky.attempts, ALL);
        assert.deepEqual(statuses(outcomes), ["failed", "sent", "failed", "sent"]);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 0);
    });

    it("a failed send is never reported as unrecorded, even if the ledger is also broken: the first DELIVERED message is what stops the run", async () => {
        const db = createLedgerDb(standardRows());
        db.failures.record = new Error("connection reset");
        const flaky = createSenderLog(["ann@example.com"]);
        const { outcomes } = await runStage({ args: ["--send", "--all"], db, log: flaky });

        // Nothing was delivered to ann, so there is nothing to record and the run goes on to bob,
        // whose message IS delivered and cannot be recorded: that is the point at which it stops.
        assert.deepEqual(flaky.attempts, ["ann@example.com", "bob@example.com"]);
        assert.deepEqual(statuses(outcomes), ["failed", "sent_unrecorded"]);
    });

    it("successful sends continue normally to the last customer", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({ args: ["--send", "--all"], db, log });

        assert.deepEqual(log.recipients(), ALL);
        assert.deepEqual(statuses(outcomes), ["sent", "sent", "sent", "sent"]);
        assert.equal(outcomes.length, runPlan.selected.length);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 0);
        assert.equal(db.ledgerWrites(), 4);
        assert.equal(db.transactions(), 4);
        assert.equal(emailRunExitCode(outcomes), 0);
    });

    it("the CLI takes its exit code from the same helper and tells the operator that the run stopped", () => {
        const cli = readFileSync(resolve(process.cwd(), "scripts/migrations/legacy-shopify-customers/send-emails.ts"), "utf8");
        assert.match(cli, /process\.exitCode\s*=\s*emailRunExitCode\(outcomes\)/);
        assert.match(cli, /countNotAttempted\(/);
        assert.match(cli, /RUN STOPPED/);
    });
});

// ---------------------------------------------------------------------------
// Test mode
// ---------------------------------------------------------------------------

describe("stage 2 test mode (--test-recipients)", () => {
    const TESTERS = ["qa.one@test.example", "qa.two@test.example"];
    const testArg = `--test-recipients=${TESTERS.join(",")}`;

    it("emails only the allowlisted addresses, never a customer", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const { outcomes } = await runStage({ args: [testArg, "--limit=4"], db, log });

        assert.equal(log.sent.length, 4 * TESTERS.length);
        for (const entry of log.sent) {
            assert.ok(TESTERS.includes(entry.request.to), `${entry.request.to} must be a test address`);
            assert.ok(!NAMES.has(entry.request.to));
        }
        assert.ok(log.attempts.every((address) => !address.endsWith("@example.com")));
        assert.ok(outcomes.every((outcome) => outcome.status === "test_sent" && outcome.deliveredTo.length === 2));
    });

    it("sends for one customer by default", async () => {
        const log = createSenderLog();
        await runStage({ args: [testArg], db: createLedgerDb(standardRows()), log });
        assert.equal(log.sent.length, TESTERS.length);
        assert.ok(log.sent.every((entry) => entry.request.customerName === "Ann Archer"));
    });

    it("never touches the email ledger: no transaction, no write, no change to any workspace", async () => {
        const db = createLedgerDb(standardRows());
        const before = JSON.stringify(db.rows());
        await runStage({ args: [testArg, "--limit=4"], db, log: createSenderLog() });

        assert.equal(db.transactions(), 0);
        assert.equal(db.ledgerWrites(), 0);
        assert.equal(JSON.stringify(db.rows()), before);
    });

    it("leaves every customer pending, so a real send afterwards still reaches them", async () => {
        const db = createLedgerDb(standardRows());
        await runStage({ args: [testArg, "--limit=4"], db, log: createSenderLog() });
        assert.equal(planEmailRun(db.rows(), CONTEXT, null).pending.length, 4);
    });

    it("does not need, and is not given, a ledger at all", async () => {
        const mode = resolveSendMode(parseSendEmailsArgs([testArg]));
        const plan = planEmailRun(standardRows(), CONTEXT, mode.limit);
        const log = createSenderLog();
        const explodingLedger: LedgerRunner = {
            async runInTransaction() {
                throw new Error("the ledger must not be used in test mode");
            },
        };
        const outcomes = await runEmailStage({
            mode,
            selected: plan.selected,
            emailConfig: FULL_CONFIG,
            sender: createGuardedSender({ mode, liveRecipients: new Set(), rawSender: log.raw }),
            ledger: explodingLedger,
            context: CONTEXT,
        });
        assert.ok(outcomes.every((outcome) => outcome.status === "test_sent"));
    });

    it("renders the customer's content: greeting and dates come from the customer, never from the tester's address", async () => {
        const rows = [row("ws-eve", "eve@example.com")];
        const log = createSenderLog();
        await runStage({ args: [testArg], db: createLedgerDb(rows), log });

        for (const entry of log.sent) {
            // eve has no billing name in the CSV; the greeting is inferred from HER address, not "qa.one".
            assert.equal(entry.request.customerName, "eve");
            assert.equal(entry.request.startDate, "2026-11-04");
            assert.equal(entry.request.expiryDate, "2027-11-04");
            const message = buildFreeYearMessage(entry.request, "from@test.invalid");
            assert.match(message.text, /^Hi eve,/);
        }
    });

    it("marks test messages with a header and leaves the approved subject and body untouched", async () => {
        const log = createSenderLog();
        await runStage({ args: [testArg], db: createLedgerDb(standardRows()), log });
        assert.ok(log.sent.every((entry) => entry.headers?.[TEST_MODE_HEADER] === "test"));

        const request = log.sent[0]!.request;
        const approved = getLegacyFreeYearEmailContent({
            customerName: request.customerName,
            accountEmail: request.accountEmail,
            workspaceName: request.workspaceName,
            purchase: request.purchase,
            startDate: request.startDate,
            expiryDate: request.expiryDate,
            androidUrl: request.androidUrl,
            windowsUrl: request.windowsUrl,
            iosUrl: request.iosUrl,
            macosUrl: request.macosUrl,
            supportEmail: request.supportEmail,
        });
        const message = buildFreeYearMessage(request, "from@test.invalid", log.sent[0]!.headers);
        assert.equal(message.subject, approved.subject);
        assert.equal(message.text, approved.text);
        assert.equal(message.html, approved.html);
        assert.doesNotMatch(message.subject, /test/i);
    });

    it("the guard refuses a non-allowlisted address even if the code above it tries to send one", async () => {
        const log = createSenderLog();
        const mode = resolveSendMode(parseSendEmailsArgs([testArg]));
        const guarded = createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw });

        await assert.rejects(guarded({ ...baseRequest(), to: "ann@example.com" }), /not on the test recipient allowlist/);
        await assert.rejects(guarded({ ...baseRequest(), to: "qa.three@test.example" }), /not on the test recipient allowlist/);
        await guarded({ ...baseRequest(), to: "QA.One@test.example" });
        assert.deepEqual(log.attempts, ["QA.One@test.example"]);
    });

    it("refuses test addresses that belong to real customers (migrated owners or anyone in the CSV plan)", () => {
        assert.throws(
            () => assertTestRecipientsAreNotCustomers(["Ann@Example.com"], ["ann@example.com", "bob@example.com"]),
            /real customer/
        );
        assert.throws(() => assertTestRecipientsAreNotCustomers(["qa@test.example", "bob@example.com"], NAMES.keys()), /bob@example\.com/);
        assert.doesNotThrow(() => assertTestRecipientsAreNotCustomers(TESTERS, [...NAMES.keys(), "ann@example.com"]));
    });

    it("a failing test send is reported as failed for that address and still writes nothing", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog(["qa.two@test.example"]);
        const { outcomes } = await runStage({ args: [testArg], db, log });
        assert.equal(outcomes[0]?.status, "failed");
        assert.match(outcomes[0]?.error ?? "", /qa\.two@test\.example/);
        assert.equal(log.sent.length, 1);
        assert.equal(db.ledgerWrites(), 0);
    });
});

// ---------------------------------------------------------------------------
// The mail transport (fake SMTP)
// ---------------------------------------------------------------------------

describe("stage 2 mail transport (no real SMTP)", () => {
    const SMTP_ENV = {
        SMTP_HOST: "smtp.test.invalid",
        SMTP_PORT: "587",
        SMTP_USER: "smtp-user",
        SMTP_PASS: "smtp-pass",
        EMAIL_FROM: "HealthAge <noreply@test.invalid>",
    };

    function fakeTransport(result: SendMailResult | Error, env: Record<string, string | undefined> = SMTP_ENV) {
        const calls: Array<{ config: SmtpTransportConfig; message: MailMessage }> = [];
        let created = 0;
        const deps: TransportDeps = {
            env,
            createTransport: (config) => {
                created += 1;
                return {
                    async sendMail(message) {
                        calls.push({ config, message });
                        if (result instanceof Error) throw result;
                        return result;
                    },
                };
            },
        };
        return { calls, deps, created: () => created };
    }

    it("builds the approved template, from EMAIL_FROM, to the recipient", async () => {
        const fake = fakeTransport({ accepted: ["ann@example.com"], rejected: [] });
        await sendFreeYearEmail(baseRequest(), fake.deps);

        assert.equal(fake.calls.length, 1);
        const { message, config } = fake.calls[0]!;
        const approved = getLegacyFreeYearEmailContent({ ...baseRequest() });
        assert.equal(message.from, "HealthAge <noreply@test.invalid>");
        assert.equal(message.to, "ann@example.com");
        assert.equal(message.subject, EMAIL_SUBJECTS.existing_customer);
        assert.equal(message.text, approved.text);
        assert.equal(message.html, approved.html);
        assert.deepEqual(config, { host: "smtp.test.invalid", port: 587, secure: false, auth: { user: "smtp-user", pass: "smtp-pass" } });
        assert.equal(message.headers, undefined);
    });

    it("falls back to the SMTP user as sender and uses TLS on port 465", async () => {
        const fake = fakeTransport({ accepted: ["ann@example.com"] }, { ...SMTP_ENV, SMTP_PORT: "465", EMAIL_FROM: undefined });
        await sendFreeYearEmail(baseRequest(), fake.deps);
        assert.equal(fake.calls[0]!.message.from, "smtp-user");
        assert.equal(fake.calls[0]!.config.secure, true);
    });

    it("passes extra headers through and nothing else changes", async () => {
        const fake = fakeTransport({ accepted: ["ann@example.com"] });
        await sendFreeYearEmail(baseRequest(), fake.deps, { headers: { [TEST_MODE_HEADER]: "test" } });
        assert.deepEqual(fake.calls[0]!.message.headers, { [TEST_MODE_HEADER]: "test" });
    });

    it("includes the iOS and macOS links only when configured, and the Android/Windows links always", async () => {
        const withApple = fakeTransport({ accepted: ["ann@example.com"] });
        await sendFreeYearEmail(baseRequest(), withApple.deps);
        const withoutApple = fakeTransport({ accepted: ["ann@example.com"] });
        await sendFreeYearEmail(baseRequest({ iosUrl: null, macosUrl: null }), withoutApple.deps);

        const full = withApple.calls[0]!.message.text;
        const reduced = withoutApple.calls[0]!.message.text;
        assert.match(full, /iOS: https:\/\/apps\.apple\.com\/example-ios/);
        assert.match(full, /macOS: https:\/\/apps\.apple\.com\/example-macos/);
        assert.doesNotMatch(reduced, /\biOS:|\bmacOS:/);
        for (const text of [full, reduced]) {
            assert.match(text, /Android: https:\/\/play\.google\.com/);
            assert.match(text, /Windows: https:\/\/apps\.microsoft\.com/);
        }
    });

    it("treats a rejected recipient as a failure, so nothing would be recorded", async () => {
        const fake = fakeTransport({ accepted: [], rejected: ["ann@example.com"] });
        await assert.rejects(sendFreeYearEmail(baseRequest(), fake.deps), /rejected recipient/);
    });

    it("treats a missing acceptance as a failure", async () => {
        await assert.rejects(sendFreeYearEmail(baseRequest(), fakeTransport({ accepted: ["other@example.com"] }).deps), /did not confirm acceptance/);
        await assert.rejects(sendFreeYearEmail(baseRequest(), fakeTransport({}).deps), /did not confirm acceptance/);
    });

    it("propagates a transport error", async () => {
        await assert.rejects(sendFreeYearEmail(baseRequest(), fakeTransport(new Error("ECONNREFUSED")).deps), /ECONNREFUSED/);
    });

    it("fails before creating a transport when SMTP is not configured", async () => {
        for (const env of [{}, { ...SMTP_ENV, SMTP_HOST: undefined }, { ...SMTP_ENV, SMTP_PORT: "0" }, { ...SMTP_ENV, SMTP_PASS: "" }]) {
            const fake = fakeTransport({ accepted: ["ann@example.com"] }, env);
            await assert.rejects(sendFreeYearEmail(baseRequest(), fake.deps), /SMTP_HOST\/SMTP_PORT\/SMTP_USER\/SMTP_PASS are not configured/);
            assert.equal(fake.created(), 0);
        }
        assert.throws(() => readSmtpSettings({}), /not configured/);
    });

    it("a transport rejection through the whole live flow leaves the customer retryable", async () => {
        const db = createLedgerDb([row("ws-ann", "ann@example.com")]);
        const mode = resolveSendMode(parseSendEmailsArgs(["--send", "--all"]));
        const plan = planEmailRun(db.rows(), CONTEXT, null);
        const rejecting = fakeTransport({ accepted: [], rejected: ["ann@example.com"] });
        const rawSender: EmailSender = (request, options) => sendFreeYearEmail(request, rejecting.deps, options);

        const outcomes = await runEmailStage({
            mode,
            selected: plan.selected,
            emailConfig: FULL_CONFIG,
            sender: createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender }),
            ledger: db.runner,
            context: CONTEXT,
        });
        assert.equal(outcomes[0]?.status, "failed");
        assert.equal(db.ledgerWrites(), 0);
        assert.equal(planEmailRun(db.rows(), CONTEXT, null).pending.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Stage 1 -> stage 2, end to end on the real export
// ---------------------------------------------------------------------------

describe("stage 1 (--apply --no-email) followed by stage 2, on orders_export_1.csv", () => {
    /** Runs the real stage 1 apply logic into an in-memory database. */
    async function runStageOne() {
        const plan = buildMigrationPlan(readOrdersCsv(resolve(process.cwd(), "orders_export_1.csv")));
        const runDate = new Date("2026-11-04T09:00:00.000Z");

        let seq = 1;
        const workspaces: ExistingWorkspace[] = [];
        const members: Array<{ workspaceId: string; email: string; status: string }> = [];
        const executor: ApplyExecutor = {
            async findWorkspacesByOwnerEmail(email) {
                return workspaces.filter((workspace) => workspace.owner_email === email);
            },
            async findUserByEmail() {
                return null;
            },
            async findOwnerMembership(workspaceId, email) {
                return members.some((member) => member.workspaceId === workspaceId && member.email === email) ? { id: "m" } : null;
            },
            async insertWorkspace(values) {
                const created: ExistingWorkspace = {
                    id: `ws-${seq++}`,
                    name: values.name,
                    owner_email: values.ownerEmail,
                    status: "active",
                    subscription_status: "active",
                    plan: "organization",
                    seat_limit: values.seatLimit,
                    expires_at: values.expiresAt,
                    billing_source: "legacy_shopify_migration",
                    notes: values.notes,
                };
                workspaces.push(created);
                return { id: created.id };
            },
            async insertOwnerMembership(values) {
                members.push({ workspaceId: values.workspaceId, email: values.email, status: values.status });
            },
            async updateWorkspaceNotes() {
                throw new Error("stage 1 with --no-email must not write the email ledger");
            },
        };
        const runner: TransactionRunner = { runInTransaction: (fn) => fn(executor) };

        const writeMode = resolveWriteMode(parseApplyArgs(["--apply", "--no-email"]));
        const decisions = applyCreateLimit(
            plan.customers.map((customer) => decideCustomer({ customer, runDate, user: undefined, workspaces: [], dbChecked: true })),
            null
        );
        let stageOneEmails = 0;
        for (const decision of decisions) {
            await applyOneCustomer({
                runner,
                notesWriter: executor,
                customer: decision.customer,
                decision,
                writeMode,
                emailConfig: FULL_CONFIG,
                sendEmail: async () => {
                    stageOneEmails += 1;
                },
                now: runDate,
            });
        }

        const rows: MigratedWorkspaceRow[] = workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            owner_email: workspace.owner_email,
            status: workspace.status,
            subscription_status: workspace.subscription_status,
            expires_at: workspace.expires_at,
            notes: workspace.notes,
            billing_source: workspace.billing_source,
            seat_limit: workspace.seat_limit,
            owner_member_status: members.find((member) => member.workspaceId === workspace.id)?.status ?? null,
            user_status: null,
        }));
        const nameByEmail = new Map(plan.customers.filter((customer) => customer.email).map((customer) => [customer.email, customer.customerName]));
        const purchaseByEmail = buildPurchaseIndex(plan.customers);
        return { rows, nameByEmail, purchaseByEmail, stageOneEmails, plan };
    }

    it("stage 1 with --no-email leaves all 39 customers pending and sends nothing", async () => {
        const { rows, nameByEmail, purchaseByEmail, stageOneEmails } = await runStageOne();
        assert.equal(stageOneEmails, 0);
        assert.equal(rows.length, 39);
        assert.ok(rows.every((workspace) => !notesIndicateFreeYearEmailSent(workspace.notes)));

        const pending = planEmailRun(rows, { nameByEmail, purchaseByEmail, now: new Date("2026-11-10T00:00:00.000Z") }, null);
        assert.equal(pending.pending.length, 39);
        assert.equal(pending.skipped.length, 0);
    });

    it("test send -> controlled live batches -> everyone done, nobody twice, ledger recorded for exactly the sent", async () => {
        const { rows, nameByEmail, purchaseByEmail } = await runStageOne();
        const context = { nameByEmail, purchaseByEmail, now: new Date("2026-11-10T00:00:00.000Z") };
        const db = createLedgerDb(rows);

        const run = async (args: string[], log: ReturnType<typeof createSenderLog>) => {
            const mode = resolveSendMode(parseSendEmailsArgs(args));
            const runPlan = planEmailRun(db.rows(), context, mode.limit);
            return runEmailStage({
                mode,
                selected: runPlan.selected,
                emailConfig: FULL_CONFIG,
                sender: createGuardedSender({ mode, liveRecipients: new Set(runPlan.selected.map((c) => c.email)), rawSender: log.raw }),
                ledger: mode.sends && mode.target === "live" ? db.runner : null,
                context,
                now: () => new Date("2026-11-10T00:00:00.000Z"),
            });
        };

        // 1. Test send: only the tester receives, nothing recorded, all 39 still pending.
        const testLog = createSenderLog();
        await run(["--test-recipients=qa@test.example", "--limit=3"], testLog);
        assert.deepEqual([...new Set(testLog.recipients())], ["qa@test.example"]);
        assert.equal(testLog.sent.length, 3);
        assert.equal(db.ledgerWrites(), 0);
        assert.equal(planEmailRun(db.rows(), context, null).pending.length, 39);

        // 2. Controlled live batch of 5.
        const batch = createSenderLog();
        await run(["--send", "--limit=5"], batch);
        assert.equal(batch.sent.length, 5);
        assert.equal(db.ledgerWrites(), 5);
        assert.equal(planEmailRun(db.rows(), context, null).pending.length, 34);

        // 3. The rest.
        const rest = createSenderLog();
        await run(["--send", "--all"], rest);
        assert.equal(rest.sent.length, 34);
        assert.equal(planEmailRun(db.rows(), context, null).pending.length, 0);

        // 4. Nobody received two emails, and every customer is in the ledger.
        const everyone = [...batch.recipients(), ...rest.recipients()];
        assert.equal(new Set(everyone).size, 39);
        assert.equal(everyone.length, 39);
        assert.ok(db.rows().every((workspace) => notesIndicateFreeYearEmailSent(workspace.notes)));

        // 5. A further run is a no-op.
        const again = createSenderLog();
        await run(["--send", "--all"], again);
        assert.deepEqual(again.attempts, []);

        // The grant dates in every email are stage 1's: run date and run date + 365 days.
        const allRequests = [...batch.sent, ...rest.sent].map((entry) => entry.request);
        assert.ok(allRequests.every((request) => request.startDate === "2026-11-04" && request.expiryDate === "2027-11-04"));
    });

    it("order #1425, refunded and missing-email customers never had a workspace, so stage 2 can never email them", async () => {
        const { rows, nameByEmail, purchaseByEmail } = await runStageOne();
        const owners = new Set(rows.map((workspace) => workspace.owner_email));
        assert.equal(owners.has("munthaliw101@gmail.com"), false);
        assert.equal(owners.has("zdingez@gmail.com"), false);
        assert.equal(owners.has("chaus@awhn.org"), false);
        // A stray legacy workspace for a held customer would still be skipped: the CSV plan knows them,
        // but a customer unknown to the CSV is never emailed.
        const stray = row("stray", "unknown@nowhere.example");
        const plan = planEmailRun([...rows, stray], { nameByEmail, purchaseByEmail, now: new Date("2026-11-10T00:00:00.000Z") }, null);
        assert.equal(plan.pending.length, 39);
        assert.equal(plan.skipped[0]?.reason, "not_in_csv_plan");
    });
});

// ---------------------------------------------------------------------------
// Pilot fixtures: a synthetic export with look-alike customers, and an in-memory stage 1
// ---------------------------------------------------------------------------

const PILOT_HEADER =
    "Name,Email,Financial Status,Created at,Cancelled at,Refunded Amount,Id,Billing Name,Lineitem name,Lineitem quantity,Lineitem sku,Lineitem price";
const KIT_LARGE = "Health Expo Screening Kits - English / Large";
const KIT_SMALL = "Health Expo Screening Kits - English / Small";

function pilotOrder(
    n: number,
    email: string,
    billingName: string,
    status: string,
    item: string,
    quantity: number,
    sku: string,
    refunded = 0
): string {
    return [`#P${n}`, email, status, "2026-07-01 10:00:00 -0700", "", String(refunded), String(9000 + n), billingName, item, String(quantity), sku, "10.00"].join(",");
}

/**
 * The two pilot-style customers (Large kit = 4 licences, Small kit = 1) sit among customers
 * chosen to catch a sloppy match: a plus-alias of the large buyer, other eligible buyers, a
 * refund, a partial refund, a blank email and a customer who already has a workspace.
 */
const PILOT_CSV = [
    PILOT_HEADER,
    pilotOrder(1, "pilot.large@example.com", "Pilot Large", "paid", KIT_LARGE, 1, "004-2"),
    pilotOrder(2, "pilot.small@example.com", "Pilot Small", "paid", KIT_SMALL, 1, "004-1"),
    pilotOrder(3, "pilot.large+extra@example.com", "Plus Alias", "paid", "Discover Your Health Age - 3", 1, "008"),
    pilotOrder(4, "other.large@example.com", "Other Large", "paid", KIT_LARGE, 2, "004-2"),
    pilotOrder(5, "other.dyha@example.com", "Other Dyha", "paid", "Discover Your Health Age - 2", 1, "008"),
    pilotOrder(6, "refunded@example.com", "Refunded", "refunded", KIT_SMALL, 1, "004-1", 10),
    pilotOrder(7, "partial@example.com", "Partial", "partially_refunded", KIT_LARGE, 1, "004-2", 10),
    pilotOrder(8, "", "No Email", "paid", KIT_SMALL, 1, "004-1"),
    pilotOrder(9, "existing@example.com", "Has Workspace", "paid", "Discover Your Health Age - 1", 1, "008"),
].join("\n");

const PILOT_PLAN = buildMigrationPlan(parseOrdersCsvText(PILOT_CSV, "pilot-fixture"));
const PILOT_RUN_DATE = new Date("2026-11-04T09:00:00.000Z");
const PILOT_PAIR = "pilot.large@example.com,pilot.small@example.com";

const EXISTING_WORKSPACE: ExistingWorkspace = {
    id: "ws-existing",
    name: "Has Workspace",
    owner_email: "existing@example.com",
    status: "active",
    subscription_status: "active",
    plan: "organization",
    seat_limit: 1,
    expires_at: new Date("2027-06-01T00:00:00.000Z"),
    billing_source: "legacy_shopify_migration",
    notes: "Legacy Shopify migration — order(s) #P9",
};

/** The same writes stage 1 makes, held in memory. Counts transactions so a test can prove none ran. */
function createStageOneStore(initial: readonly ExistingWorkspace[] = [{ ...EXISTING_WORKSPACE }]) {
    let seq = 1;
    let transactions = 0;
    const workspaces: ExistingWorkspace[] = [...initial];
    const members: Array<{ workspaceId: string; email: string; role: string; status: string }> = [];

    const executor: ApplyExecutor = {
        async findWorkspacesByOwnerEmail(email) {
            return workspaces.filter((workspace) => workspace.owner_email === email);
        },
        async findUserByEmail() {
            return null;
        },
        async findOwnerMembership(workspaceId, email) {
            return members.some((member) => member.workspaceId === workspaceId && member.email === email) ? { id: "m" } : null;
        },
        async insertWorkspace(values) {
            const created: ExistingWorkspace = {
                id: `ws-new-${seq++}`,
                name: values.name,
                owner_email: values.ownerEmail,
                status: "active",
                subscription_status: "active",
                plan: "organization",
                seat_limit: values.seatLimit,
                expires_at: values.expiresAt,
                billing_source: "legacy_shopify_migration",
                notes: values.notes,
            };
            workspaces.push(created);
            return { id: created.id };
        },
        async insertOwnerMembership(values) {
            members.push({ workspaceId: values.workspaceId, email: values.email, role: values.role, status: values.status });
        },
        async updateWorkspaceNotes() {
            throw new Error("stage 1 with --no-email must not write the email ledger");
        },
    };
    const runner: TransactionRunner = {
        runInTransaction: (fn) => {
            transactions += 1;
            return fn(executor);
        },
    };
    return { workspaces, members, executor, runner, transactions: () => transactions };
}

type StageOneStore = ReturnType<typeof createStageOneStore>;

/** Runs the same sequence as apply.ts: parse -> mode -> decide -> select -> apply one by one. */
async function runStageOneWith(input: { store: StageOneStore; args: string[]; decided?: ApplyDecision[] }) {
    const args = parseApplyArgs(input.args);
    const writeMode = resolveWriteMode(args);
    const decided =
        input.decided ??
        PILOT_PLAN.customers.map((customer) =>
            decideCustomer({
                customer,
                runDate: PILOT_RUN_DATE,
                user: undefined,
                workspaces: input.store.workspaces.filter((workspace) => workspace.owner_email === customer.email),
                dbChecked: true,
            })
        );
    const { decisions, targeting } = selectDecisions({
        decided,
        limit: args.limit,
        onlyEmails: args.onlyEmails,
        writesEnabled: writeMode.writesEnabled,
    });
    const allowlist = args.onlyEmails.length > 0 ? new Set(args.onlyEmails) : undefined;

    const sentEmails: string[] = [];
    const results: Array<Awaited<ReturnType<typeof applyOneCustomer>>> = [];
    if (writeMode.writesEnabled) {
        for (const decision of decisions) {
            results.push(
                await applyOneCustomer({
                    runner: input.store.runner,
                    notesWriter: input.store.executor,
                    customer: decision.customer,
                    decision,
                    writeMode,
                    emailConfig: FULL_CONFIG,
                    onlyEmails: allowlist,
                    sendEmail: async (payload) => {
                        sentEmails.push(payload.to);
                    },
                    now: PILOT_RUN_DATE,
                })
            );
        }
    }
    return { args, writeMode, decided, decisions, targeting, results, sentEmails };
}

const workspacesOf = (store: StageOneStore, email: string) => store.workspaces.filter((workspace) => workspace.owner_email === email);

/** What stage 2 would read from the database after stage 1. */
function stageTwoRows(store: StageOneStore): MigratedWorkspaceRow[] {
    return store.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        owner_email: workspace.owner_email,
        status: workspace.status,
        subscription_status: workspace.subscription_status,
        expires_at: workspace.expires_at,
        notes: workspace.notes,
        billing_source: workspace.billing_source,
        seat_limit: workspace.seat_limit,
        owner_member_status: store.members.find((member) => member.workspaceId === workspace.id)?.status ?? null,
        user_status: null,
    }));
}

// ---------------------------------------------------------------------------
// Stage 1: exact recipient targeting
// ---------------------------------------------------------------------------

describe("stage 1 exact recipient targeting (--only-emails)", () => {
    it("the fixture behaves as designed: two pilot-style buyers among look-alikes and held customers", () => {
        const byEmail = new Map(PILOT_PLAN.customers.map((customer) => [customer.email, customer]));
        assert.equal(byEmail.get("pilot.large@example.com")?.licenseQuantity, 4);
        assert.equal(byEmail.get("pilot.small@example.com")?.licenseQuantity, 1);
        assert.equal(byEmail.get("pilot.large+extra@example.com")?.licenseQuantity, 3);
        assert.equal(byEmail.get("refunded@example.com")?.status, "skip_no_qualifying_order");
        assert.equal(byEmail.get("partial@example.com")?.status, "manual_review_partial_refund");
        assert.ok(PILOT_PLAN.customers.some((customer) => customer.status === "blocked_missing_email"));
        assert.equal(PILOT_PLAN.customers.filter((customer) => customer.status === "ready_create_workspace").length, 6);
    });

    it("parses the list: trimmed, lower-cased, de-duplicated, first-seen order", () => {
        assert.deepEqual(parseApplyArgs(["--only-emails= Pilot.Large@Example.com , pilot.small@example.com,PILOT.LARGE@example.com,"]).onlyEmails, [
            "pilot.large@example.com",
            "pilot.small@example.com",
        ]);
        assert.deepEqual(parseEmailAllowlist("--x", "A@b.co,a@B.co"), ["a@b.co"]);
        assert.deepEqual(parseApplyArgs(["--dry-run"]).onlyEmails, [], "absent means no targeting");
    });

    it("an empty, malformed or repeated list is an error, so it can never widen into everyone", () => {
        assert.throws(() => parseApplyArgs(["--only-emails="]), /at least one address/);
        assert.throws(() => parseApplyArgs(["--only-emails=,,"]), /at least one address/);
        assert.throws(() => parseApplyArgs(["--only-emails=not-an-email"]), /invalid address/);
        assert.throws(() => parseApplyArgs(["--only-emails=a@x.com b@y.com"]), /invalid address/, "a forgotten comma");
        assert.throws(() => parseApplyArgs(["--only-emails=a@x.com", "--only-emails=b@y.com"]), /more than once/);
        assert.throws(() => parseApplyArgs(["--only-email=a@x.com"]), /Unknown argument/);
        assert.throws(() => parseApplyArgs(["--onlyemails=a@x.com"]), /Unknown argument/);
    });

    it("cannot be combined with --limit, and with --apply it requires --no-email", () => {
        assert.throws(() => parseApplyArgs(["--only-emails=a@x.com", "--limit=1"]), /cannot be combined/);
        assert.throws(() => parseApplyArgs(["--limit=1", "--only-emails=a@x.com"]), /cannot be combined/);

        const withoutNoEmail = parseApplyArgs(["--apply", "--only-emails=a@x.com"]);
        assert.throws(() => resolveWriteMode(withoutNoEmail), /requires --no-email/);
        const ok = resolveWriteMode(parseApplyArgs(["--apply", "--no-email", "--only-emails=a@x.com"]));
        assert.deepEqual(ok, { writesEnabled: true, emailsEnabled: false });
        // A preview needs no such flag, and a run without --only-emails is unchanged.
        assert.equal(resolveWriteMode(parseApplyArgs(["--dry-run", "--only-emails=a@x.com"])).writesEnabled, false);
        assert.equal(resolveWriteMode(parseApplyArgs(["--apply"])).emailsEnabled, true);
    });

    it("creates workspaces for ONLY the two listed customers, with the right seats, and sends nothing", async () => {
        const store = createStageOneStore();
        const run = await runStageOneWith({ store, args: ["--apply", "--no-email", `--only-emails=${PILOT_PAIR}`] });

        assert.deepEqual(run.sentEmails, []);
        const created = store.workspaces.filter((workspace) => workspace.id.startsWith("ws-new-"));
        assert.deepEqual(created.map((workspace) => [workspace.owner_email, workspace.seat_limit]).sort(), [
            ["pilot.large@example.com", 4],
            ["pilot.small@example.com", 1],
        ]);
        assert.equal(store.workspaces.length, 3, "the two new workspaces plus the one that already existed");
        assert.deepEqual(
            store.members.map((member) => [member.email, member.role, member.status]).sort(),
            [
                ["pilot.large@example.com", "owner", "invited"],
                ["pilot.small@example.com", "owner", "invited"],
            ]
        );
        for (const workspace of created) {
            assert.equal(workspace.expires_at?.toISOString(), "2027-11-04T09:00:00.000Z", "365 days from the run date");
            assert.equal(workspace.billing_source, "legacy_shopify_migration");
        }
        // Everyone else, including every other eligible customer, was never touched.
        for (const email of ["other.large@example.com", "other.dyha@example.com", "pilot.large+extra@example.com", "refunded@example.com", "partial@example.com"]) {
            assert.equal(workspacesOf(store, email).length, 0, email);
        }
        assert.equal(store.transactions(), 2, "one transaction per listed customer and no others");
    });

    it("matches exactly: case and duplicates collapse, but an alias or look-alike is a different customer", async () => {
        const store = createStageOneStore();
        await runStageOneWith({
            store,
            args: ["--apply", "--no-email", "--only-emails=PILOT.LARGE@EXAMPLE.COM, pilot.large@example.com ,Pilot.Large@Example.com"],
        });
        assert.equal(workspacesOf(store, "pilot.large@example.com").length, 1, "three spellings of one address make one workspace");
        assert.equal(workspacesOf(store, "pilot.large+extra@example.com").length, 0, "the plus-alias customer is NOT matched");
        assert.equal(store.workspaces.filter((workspace) => workspace.id.startsWith("ws-new-")).length, 1);

        // Asking for the alias creates THAT customer only.
        const second = createStageOneStore();
        await runStageOneWith({ store: second, args: ["--apply", "--no-email", "--only-emails=pilot.large+extra@example.com"] });
        assert.equal(workspacesOf(second, "pilot.large+extra@example.com").length, 1);
        assert.equal(workspacesOf(second, "pilot.large@example.com").length, 0);
    });

    it("a near miss, wildcard or unknown address is reported missing and refuses the WHOLE run: nothing is written", async () => {
        // "large@" and "small@" are SUFFIXES of real customers' addresses: a substring match would take them.
        for (const bad of [
            "pilot.larg@example.com",
            "pilot.large@example.org",
            "large@example.com",
            "small@example.com",
            "*@example.com",
            "ghost@example.com",
            "example.com@example.com",
        ]) {
            const store = createStageOneStore();
            await assert.rejects(
                runStageOneWith({ store, args: ["--apply", "--no-email", `--only-emails=pilot.large@example.com,${bad}`] }),
                (error: Error) => /cannot be migrated, so NOTHING was written/.test(error.message) && error.message.includes(bad),
                bad
            );
            assert.equal(store.workspaces.length, 1, `${bad}: even the valid address in the same list must not be written`);
            assert.equal(store.transactions(), 0);
        }
    });

    it("the second lock compares exactly too: a suffix of a real address on the list authorises nobody", async () => {
        const store = createStageOneStore();
        const decided = PILOT_PLAN.customers.map((customer) =>
            decideCustomer({ customer, runDate: PILOT_RUN_DATE, user: undefined, workspaces: [], dbChecked: true })
        );
        for (const decision of decided.map((candidate) => ({ ...candidate, inThisRun: candidate.action === "CREATE" }))) {
            await applyOneCustomer({
                runner: store.runner,
                notesWriter: store.executor,
                customer: decision.customer,
                decision,
                writeMode: { writesEnabled: true, emailsEnabled: false },
                emailConfig: FULL_CONFIG,
                onlyEmails: new Set(["large@example.com", "small@example.com"]), // suffixes of pilot.large / pilot.small
                sendEmail: async () => {
                    throw new Error("stage 1 must not email");
                },
                now: PILOT_RUN_DATE,
            });
        }
        assert.equal(store.transactions(), 0, "no transaction was opened for anyone");
        assert.equal(store.workspaces.length, 1, "only the pre-existing workspace remains");
    });

    it("classifies every requested address: eligible, already migrated, blocked or missing", () => {
        const store = createStageOneStore();
        const decided = PILOT_PLAN.customers.map((customer) =>
            decideCustomer({
                customer,
                runDate: PILOT_RUN_DATE,
                user: undefined,
                workspaces: store.workspaces.filter((workspace) => workspace.owner_email === customer.email),
                dbChecked: true,
            })
        );
        const report = buildTargetReport(decided, [
            "pilot.large@example.com",
            "existing@example.com",
            "refunded@example.com",
            "partial@example.com",
            "ghost@example.com",
        ]);
        assert.deepEqual(
            report.entries.map((entry) => [entry.email, entry.state]),
            [
                ["pilot.large@example.com", "eligible"],
                ["existing@example.com", "has_workspace"],
                ["refunded@example.com", "blocked"],
                ["partial@example.com", "blocked"],
                ["ghost@example.com", "missing"],
            ]
        );
        assert.match(report.entries[2]?.detail ?? "", /SKIP_REFUNDED/);
        assert.match(report.entries[3]?.detail ?? "", /SKIP_MANUAL_REVIEW/);
        assert.match(report.entries[3]?.detail ?? "", /partially refunded/);
        assert.match(report.entries[4]?.detail ?? "", /not in the migration plan/);
        assert.deepEqual(
            [report.eligible.length, report.hasWorkspace.length, report.unresolved.length],
            [1, 1, 3]
        );
        assert.throws(() => assertTargetActionable(report), /3 address\(es\)/);
    });

    it("says WHICH workspace an address already has: a live Shopify one is not this migration's, and stage 2 would not email it", async () => {
        const store = createStageOneStore([
            { ...EXISTING_WORKSPACE },
            { ...EXISTING_WORKSPACE, id: "ws-live", name: "Live", owner_email: "pilot.small@example.com", billing_source: "shopify", seat_limit: 1 },
        ]);
        const decided = PILOT_PLAN.customers.map((customer) =>
            decideCustomer({
                customer,
                runDate: PILOT_RUN_DATE,
                user: undefined,
                workspaces: store.workspaces.filter((workspace) => workspace.owner_email === customer.email),
                dbChecked: true,
            })
        );
        const report = buildTargetReport(decided, ["existing@example.com", "pilot.small@example.com"]);
        assert.deepEqual(report.entries.map((entry) => entry.state), ["has_workspace", "has_workspace"]);
        assert.match(report.entries[0]?.detail ?? "", /\(legacy_shopify_migration, seats 1/, "names this migration's own workspace");
        assert.match(report.entries[1]?.detail ?? "", /\(shopify, seats 1/, "names the live workspace's billing source");
        assert.equal(report.unresolved.length, 0, "tolerated by stage 1: nothing to create");

        // ...and stage 2 correctly refuses to treat that live workspace as a migration email target.
        const db = createLedgerDb(stageTwoRows(store));
        await assert.rejects(
            runStage({
                args: ["--send", "--only-emails=pilot.small@example.com"],
                db: createLedgerDb(stageTwoRows(store).filter((workspace) => workspace.id === "ws-live")),
                log: createSenderLog(),
                context: {
                    nameByEmail: new Map([["pilot.small@example.com", "Pilot Small"]]),
                    purchaseByEmail: buildPurchaseIndex(PILOT_PLAN.customers),
                    now: new Date("2026-11-10T00:00:00.000Z"),
                },
            }),
            /not_migration_workspace/
        );
        assert.equal(db.ledgerWrites(), 0);
    });

    it("every existing protection still holds for a listed address: refunded, partially refunded and held customers are never created", async () => {
        for (const email of ["refunded@example.com", "partial@example.com"]) {
            const store = createStageOneStore();
            await assert.rejects(runStageOneWith({ store, args: ["--apply", "--no-email", `--only-emails=${email}`] }), /cannot be migrated/);
            assert.equal(workspacesOf(store, email).length, 0, email);
        }
        // The address of the blank-email order cannot even be written down.
        assert.throws(() => parseApplyArgs(["--only-emails="]), /at least one address/);
    });

    it("is idempotent: re-running the same targeted command creates nothing and is not an error", async () => {
        const store = createStageOneStore();
        const args = ["--apply", "--no-email", `--only-emails=${PILOT_PAIR}`];
        await runStageOneWith({ store, args });
        const before = store.workspaces.length;

        const again = await runStageOneWith({ store, args });
        assert.equal(store.workspaces.length, before, "no second workspace");
        assert.equal(store.members.length, 2, "no second owner membership");
        assert.deepEqual(again.targeting?.hasWorkspace.map((entry) => entry.email), ["pilot.large@example.com", "pilot.small@example.com"]);
        assert.equal(again.targeting?.unresolved.length, 0);
        assert.ok(again.results.every((result) => !result.wrote));
    });

    it("re-checks inside the transaction: a workspace created after the snapshot is not duplicated", async () => {
        const store = createStageOneStore();
        // The snapshot saw nothing for the pilot customers...
        const staleDecided = PILOT_PLAN.customers.map((customer) =>
            decideCustomer({ customer, runDate: PILOT_RUN_DATE, user: undefined, workspaces: [], dbChecked: true })
        );
        // ...then another operator created one before this run wrote.
        store.workspaces.push({ ...EXISTING_WORKSPACE, id: "ws-race", owner_email: "pilot.large@example.com", name: "Race" });

        const run = await runStageOneWith({
            store,
            args: ["--apply", "--no-email", "--only-emails=pilot.large@example.com"],
            decided: staleDecided,
        });
        assert.equal(workspacesOf(store, "pilot.large@example.com").length, 1);
        const result = run.results.find((candidate) => candidate.email === "pilot.large@example.com");
        assert.equal(result?.action, "SKIP_EXISTING");
        assert.equal(result?.wrote, false);
    });

    it("a second lock: a CREATE decision for an address that is not on the list is never written, whatever the decision says", async () => {
        const store = createStageOneStore();
        const decided = PILOT_PLAN.customers.map((customer) =>
            decideCustomer({ customer, runDate: PILOT_RUN_DATE, user: undefined, workspaces: [], dbChecked: true })
        );
        // Deliberately mis-wired: everybody marked to run, but the allowlist covers one address only.
        const everyone = decided.map((decision) => ({ ...decision, inThisRun: decision.action === "CREATE" }));
        const results: Array<Awaited<ReturnType<typeof applyOneCustomer>>> = [];
        for (const decision of everyone) {
            results.push(
                await applyOneCustomer({
                    runner: store.runner,
                    notesWriter: store.executor,
                    customer: decision.customer,
                    decision,
                    writeMode: { writesEnabled: true, emailsEnabled: false },
                    emailConfig: FULL_CONFIG,
                    onlyEmails: new Set(["pilot.small@example.com"]),
                    sendEmail: async () => {
                        throw new Error("stage 1 must not email");
                    },
                    now: PILOT_RUN_DATE,
                })
            );
        }
        assert.equal(store.transactions(), 1, "only the listed customer opened a transaction");
        assert.deepEqual(
            store.workspaces.filter((workspace) => workspace.id.startsWith("ws-new-")).map((workspace) => workspace.owner_email),
            ["pilot.small@example.com"]
        );
        assert.equal(results.filter((result) => result.wrote).length, 1);
    });

    it("a preview never writes and never refuses: it just reports what is wrong", async () => {
        const store = createStageOneStore();
        const preview = await runStageOneWith({ store, args: ["--dry-run", "--only-emails=pilot.large@example.com,ghost@example.com"] });
        assert.equal(preview.targeting?.unresolved.length, 1);
        assert.equal(store.workspaces.length, 1);
        assert.equal(store.transactions(), 0);

        // No --apply at all is also a preview.
        const implicit = await runStageOneWith({ store, args: ["--only-emails=pilot.large@example.com"] });
        assert.equal(implicit.writeMode.writesEnabled, false);
        assert.equal(store.workspaces.length, 1);
    });

    it("never falls back to everyone: the selection is exactly the list, and a limit alongside it is refused", () => {
        const decided = PILOT_PLAN.customers.map((customer) =>
            decideCustomer({ customer, runDate: PILOT_RUN_DATE, user: undefined, workspaces: [], dbChecked: true })
        );
        const picked = selectDecisions({ decided, limit: null, onlyEmails: ["pilot.small@example.com"], writesEnabled: true });
        assert.deepEqual(
            picked.decisions.filter((decision) => decision.inThisRun).map((decision) => decision.customer.email),
            ["pilot.small@example.com"]
        );
        assert.throws(() => selectDecisions({ decided, limit: 2, onlyEmails: ["pilot.small@example.com"], writesEnabled: true }), /cannot be combined/);
        // Without a list the behaviour is the old one.
        const limited = selectDecisions({ decided, limit: 2, onlyEmails: [], writesEnabled: true });
        assert.equal(limited.decisions.filter((decision) => decision.inThisRun).length, 2);
        assert.equal(limited.targeting, null);
        const unlimited = selectDecisions({ decided, limit: null, onlyEmails: [], writesEnabled: true });
        assert.equal(unlimited.decisions.filter((decision) => decision.inThisRun).length, 6);
    });

    it("the apply CLI routes selection and the write guard through the tested functions", () => {
        const cli = readFileSync(resolve(process.cwd(), "scripts/migrations/legacy-shopify-customers/apply.ts"), "utf8");
        assert.match(cli, /selectDecisions\(\{/);
        assert.match(cli, /onlyEmails:\s*allowlist/);
        assert.doesNotMatch(cli, /applyCreateLimit\(/, "the CLI must not apply the limit itself and bypass the allowlist");
    });
});

// ---------------------------------------------------------------------------
// Stage 2: exact recipient targeting
// ---------------------------------------------------------------------------

describe("stage 2 exact recipient targeting (--only-emails)", () => {
    const modeOf = (...args: string[]) => resolveSendMode(parseSendEmailsArgs(args));
    const statuses = (outcomes: ReadonlyArray<{ status: string }>) => outcomes.map((outcome) => outcome.status);

    it("parses the list: trimmed, lower-cased, de-duplicated; empty, malformed and repeated lists are errors", () => {
        assert.deepEqual(parseSendEmailsArgs(["--only-emails= Ann@Example.com , ann@example.com,BOB@example.com,"]).onlyEmails, [
            "ann@example.com",
            "bob@example.com",
        ]);
        assert.deepEqual(parseSendEmailsArgs(["--dry-run"]).onlyEmails, []);
        assert.throws(() => parseSendEmailsArgs(["--only-emails="]), /at least one address/);
        assert.throws(() => parseSendEmailsArgs(["--only-emails=,"]), /at least one address/);
        assert.throws(() => parseSendEmailsArgs(["--only-emails=nope"]), /invalid address/);
        assert.throws(() => parseSendEmailsArgs(["--only-emails=a@x.com b@y.com"]), /invalid address/);
        assert.throws(() => parseSendEmailsArgs(["--only-emails=a@x.com", "--only-emails=b@y.com"]), /more than once/);
        assert.throws(() => parseSendEmailsArgs(["--only-email=a@x.com"]), /Unknown argument/);
    });

    it("mode rules: a live pilot needs --send together with the list; the list alone and --dry-run only preview", () => {
        const live = modeOf("--send", "--only-emails=ann@example.com");
        assert.deepEqual([live.target, live.sends, live.limit], ["live", true, null]);
        assert.deepEqual(live.onlyEmails, ["ann@example.com"]);

        assert.equal(modeOf("--only-emails=ann@example.com").sends, false, "the list alone is a preview");
        assert.equal(modeOf("--send", "--dry-run", "--only-emails=ann@example.com").sends, false, "--dry-run wins");
        assert.equal(modeOf("--dry-run", "--only-emails=ann@example.com").sends, false);
        // --send still needs a scope when there is no list.
        assert.throws(() => modeOf("--send"), /explicit scope/);
    });

    it("rejects every unsafe combination with --only-emails", () => {
        assert.throws(() => modeOf("--send", "--only-emails=a@x.com", "--test-recipients=b@y.com"), /cannot be combined/);
        assert.throws(() => modeOf("--only-emails=a@x.com", "--test-recipients=b@y.com"), /cannot be combined/);
        assert.throws(() => modeOf("--send", "--only-emails=a@x.com", "--all"), /--all is not allowed with --only-emails/);
        assert.throws(() => modeOf("--only-emails=a@x.com", "--all"), /--all is not allowed with --only-emails/);
        assert.throws(() => modeOf("--send", "--only-emails=a@x.com", "--limit=1"), /--limit is not allowed with --only-emails/);
        // Test mode on its own is unchanged and carries no list.
        assert.deepEqual(modeOf("--test-recipients=q@test.example").onlyEmails, []);
    });

    it("preview is the default: the list alone, or with --dry-run, sends nothing and writes nothing", async () => {
        for (const args of [["--only-emails=ann@example.com"], ["--send", "--dry-run", "--only-emails=ann@example.com"]]) {
            const db = createLedgerDb(standardRows());
            const log = createSenderLog();
            const before = JSON.stringify(db.rows());
            const { runPlan, outcomes } = await runStage({ args, db, log });

            assert.deepEqual(log.attempts, []);
            assert.equal(db.transactions(), 0);
            assert.equal(JSON.stringify(db.rows()), before);
            assert.deepEqual(runPlan.targeting?.selected.map((entry) => entry.email), ["ann@example.com"]);
            assert.deepEqual(statuses(outcomes), ["previewed"]);
        }
    });

    it("sends to ONLY the listed customers; the other pending customers are never attempted, locked or recorded", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({
            args: ["--send", "--only-emails=ann@example.com,cy@example.com"],
            db,
            log,
        });

        assert.deepEqual(log.attempts, ["ann@example.com", "cy@example.com"]);
        assert.deepEqual(statuses(outcomes), ["sent", "sent"]);
        assert.equal(db.transactions(), 2, "no lock was taken for anyone else");
        assert.equal(runPlan.pending.length, 4, "four customers were owed the email");
        for (const id of ["ws-ann", "ws-cy"]) assert.equal(notesIndicateFreeYearEmailSent(db.get(id).notes), true, id);
        for (const id of ["ws-bob", "ws-dee"]) {
            assert.equal(notesIndicateFreeYearEmailSent(db.get(id).notes), false, `${id} untouched`);
        }
        assert.deepEqual(planEmailRun(db.rows(), CONTEXT, null).pending.map((candidate) => candidate.email), ["bob@example.com", "dee@example.com"]);
    });

    it("matches exactly: case and duplicates collapse to one email, but aliases and look-alikes match nobody", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        await runStage({ args: ["--send", "--only-emails=ANN@EXAMPLE.COM,ann@example.com, Ann@Example.Com"], db, log });
        assert.deepEqual(log.attempts, ["ann@example.com"], "three spellings, one email");
        assert.equal(db.ledgerWrites(), 1);

        // "nn@" is a SUFFIX of ann@example.com: a substring match would take it.
        for (const bad of ["ann+tag@example.com", "an@example.com", "nn@example.com", "ann@example.org", "*@example.com", "example.com@example.com"]) {
            const fresh = createLedgerDb(standardRows());
            const freshLog = createSenderLog();
            await assert.rejects(
                runStage({ args: ["--send", `--only-emails=bob@example.com,${bad}`], db: fresh, log: freshLog }),
                (error: Error) => /cannot be emailed, so NOTHING was sent/.test(error.message) && error.message.includes(bad),
                bad
            );
            assert.deepEqual(freshLog.attempts, [], `${bad}: even the valid address in the same list must not be sent`);
            assert.equal(fresh.transactions(), 0);
        }
    });

    it("a typo that is a suffix of an already-emailed customer is MISSING, never mistaken for 'already emailed'", async () => {
        const db = createLedgerDb(
            standardRows().map((r) => (r.id === "ws-ann" ? { ...r, notes: `${r.notes}\nfree_year_email_sent_at: 2026-11-05T00:00:00.000Z` } : r))
        );
        const preview = await runStage({ args: ["--only-emails=ann@example.com,nn@example.com"], db, log: createSenderLog() });
        assert.deepEqual(
            preview.runPlan.targeting?.entries.map((entry) => [entry.email, entry.state]),
            [
                ["ann@example.com", "already_emailed"],
                ["nn@example.com", "unresolved"],
            ]
        );
        const log = createSenderLog();
        await assert.rejects(runStage({ args: ["--send", "--only-emails=nn@example.com"], db, log }), /no migration workspace/);
        assert.deepEqual(log.attempts, []);
    });

    it("every address must be emailable or already emailed; otherwise nothing at all is sent", async () => {
        const cases: Array<[string, Partial<MigratedWorkspaceRow>, RegExp]> = [
            ["revoked workspace", { status: "revoked" }, /workspace_not_active/],
            ["expired workspace", { expires_at: new Date("2026-11-09T00:00:00.000Z") }, /workspace_not_active/],
            ["revoked owner membership", { owner_member_status: "revoked" }, /owner_membership_inactive/],
            ["disabled account", { user_status: "disabled" }, /account_disabled/],
            ["not a migration workspace", { billing_source: "shopify" }, /not_migration_workspace/],
        ];
        for (const [label, overrides, pattern] of cases) {
            const db = createLedgerDb([row("ws-ann", "ann@example.com", overrides), row("ws-bob", "bob@example.com")]);
            const log = createSenderLog();
            await assert.rejects(
                runStage({ args: ["--send", "--only-emails=ann@example.com,bob@example.com"], db, log }),
                pattern,
                label
            );
            assert.deepEqual(log.attempts, [], `${label}: bob (who is fine) must not be sent either`);
        }

        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        await assert.rejects(runStage({ args: ["--send", "--only-emails=ghost@example.com"], db, log }), /no migration workspace/);
        assert.deepEqual(log.attempts, []);
    });

    it("an address with duplicate migration workspaces is refused, because it would be emailed twice", async () => {
        const twoPending = createLedgerDb([row("ws-a1", "ann@example.com"), row("ws-a2", "ann@example.com"), row("ws-bob", "bob@example.com")]);
        const log = createSenderLog();
        await assert.rejects(runStage({ args: ["--send", "--only-emails=ann@example.com"], db: twoPending, log }), /emailed twice/);

        const oneAlreadySent = createLedgerDb([
            row("ws-a1", "ann@example.com", { notes: "x\nfree_year_email_sent_at: 2026-11-05T00:00:00.000Z" }),
            row("ws-a2", "ann@example.com"),
        ]);
        await assert.rejects(runStage({ args: ["--send", "--only-emails=ann@example.com"], db: oneAlreadySent, log }), /emailed twice/);
        assert.deepEqual(log.attempts, []);
    });

    it("keeps the ledger and retry behaviour: a failed send is retried by the same command, a sent one is tolerated as done", async () => {
        const db = createLedgerDb(standardRows());
        const args = ["--send", "--only-emails=ann@example.com,bob@example.com"];

        const first = createSenderLog(["bob@example.com"]);
        const one = await runStage({ args, db, log: first });
        assert.deepEqual(statuses(one.outcomes), ["sent", "failed"]);
        assert.equal(emailRunExitCode(one.outcomes), 1);
        assert.equal(notesIndicateFreeYearEmailSent(db.get("ws-bob").notes), false, "a failed send records nothing");

        const second = createSenderLog();
        const two = await runStage({ args, db, log: second });
        assert.deepEqual(second.attempts, ["bob@example.com"], "ann is done; only bob is retried");
        assert.deepEqual(two.runPlan.targeting?.alreadyEmailed.map((entry) => entry.email), ["ann@example.com"]);
        assert.deepEqual(statuses(two.outcomes), ["sent"]);
        assert.equal(emailRunExitCode(two.outcomes), 0);

        const third = createSenderLog();
        const three = await runStage({ args, db, log: third });
        assert.deepEqual(third.attempts, [], "a third run is a no-op");
        assert.deepEqual(three.outcomes, []);
        assert.equal(emailRunExitCode(three.outcomes), 0);
    });

    it("re-checks eligibility and the ledger under the lock for a listed customer", async () => {
        const planDb = createLedgerDb(standardRows());
        const run = async (runDb: ReturnType<typeof createLedgerDb>, log: ReturnType<typeof createSenderLog>) => {
            const mode = modeOf("--send", "--only-emails=ann@example.com");
            const runPlan = planEmailRun(planDb.rows(), CONTEXT, mode.limit, mode.onlyEmails);
            assertTargetingActionable(runPlan.targeting);
            return runEmailStage({
                mode,
                selected: runPlan.selected,
                emailConfig: FULL_CONFIG,
                sender: createGuardedSender({ mode, liveRecipients: new Set(runPlan.selected.map((c) => c.email)), rawSender: log.raw }),
                ledger: runDb.runner,
                context: CONTEXT,
                now: () => NOW,
            });
        };

        // (a) someone else emailed ann between the plan and the send
        const emailed = createLedgerDb(
            standardRows().map((r) => (r.id === "ws-ann" ? { ...r, notes: `${r.notes}\nfree_year_email_sent_at: 2026-11-10T11:59:00.000Z` } : r))
        );
        const logA = createSenderLog();
        const a = await run(emailed, logA);
        assert.deepEqual([a[0]?.status, a[0]?.reason], ["skipped", "already_emailed"]);
        assert.deepEqual(logA.attempts, []);

        // (b) the workspace was revoked in the meantime
        const logB = createSenderLog();
        const b = await run(createLedgerDb(standardRows().map((r) => (r.id === "ws-ann" ? { ...r, status: "revoked" } : r))), logB);
        assert.deepEqual([b[0]?.status, b[0]?.reason], ["skipped", "workspace_not_active"]);
        assert.deepEqual(logB.attempts, []);

        // (c) the owner address was changed to someone who is NOT on the list
        const moved = createLedgerDb(standardRows().map((r) => (r.id === "ws-ann" ? { ...r, owner_email: "bob@example.com" } : r)));
        const logC = createSenderLog();
        const c = await run(moved, logC);
        assert.equal(c[0]?.status, "failed");
        assert.match(c[0]?.error ?? "", /not on the --only-emails allowlist/);
        assert.deepEqual(logC.attempts, [], "bob must not be emailed just because ann's workspace now points at him");
        assert.equal(moved.ledgerWrites(), 0);
    });

    it("the send guard refuses any address that is not on the list, even if the plan wrongly contained it", async () => {
        const log = createSenderLog();
        const mode = modeOf("--send", "--only-emails=ann@example.com");
        const guarded = createGuardedSender({
            mode,
            liveRecipients: new Set(["ann@example.com", "bob@example.com"]), // mis-wired: bob slipped into the plan
            rawSender: log.raw,
        });
        await assert.rejects(guarded({ ...baseRequest(), to: "bob@example.com" }), /not on the --only-emails allowlist/);
        await guarded({ ...baseRequest(), to: "ANN@example.com" });
        assert.deepEqual(log.attempts, ["ANN@example.com"]);

        // The comparison is exact: a list entry that is merely a SUFFIX of the address authorises nothing.
        const suffixLog = createSenderLog();
        const suffixGuarded = createGuardedSender({
            mode: modeOf("--send", "--only-emails=nn@example.com"),
            liveRecipients: new Set(["ann@example.com"]), // mis-wired: ann slipped into the plan
            rawSender: suffixLog.raw,
        });
        await assert.rejects(suffixGuarded({ ...baseRequest(), to: "ann@example.com" }), /not on the --only-emails allowlist/);
        assert.deepEqual(suffixLog.attempts, []);
    });

    it("the stage refuses to run at all if it is handed a customer who is not on the list", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const mode = modeOf("--send", "--only-emails=ann@example.com");
        const everyone = planEmailRun(db.rows(), CONTEXT, null); // all four pending
        await assert.rejects(
            runEmailStage({
                mode,
                selected: everyone.selected,
                emailConfig: FULL_CONFIG,
                sender: createGuardedSender({ mode, liveRecipients: new Set(everyone.selected.map((c) => c.email)), rawSender: log.raw }),
                ledger: db.runner,
                context: CONTEXT,
            }),
            /3 selected customer\(s\) are not on the --only-emails allowlist/
        );
        assert.deepEqual(log.attempts, []);
        assert.equal(db.transactions(), 0, "nothing was locked");
    });

    it("sent_unrecorded still stops a targeted run, and the unattempted listed customer stays pending", async () => {
        const db = createLedgerDb(standardRows());
        const ledger = failingLedger(db, ["ws-ann"]);
        const log = createSenderLog();
        const { runPlan, outcomes } = await runStage({
            args: ["--send", "--only-emails=ann@example.com,bob@example.com"],
            db,
            log,
            ledger: ledger.runner,
        });
        assert.deepEqual(log.attempts, ["ann@example.com"]);
        assert.deepEqual(ledger.claimed, ["ws-ann"]);
        assert.deepEqual(statuses(outcomes), ["sent_unrecorded"]);
        assert.equal(countNotAttempted(runPlan.selected, outcomes), 1);
        assert.equal(emailRunExitCode(outcomes), 1);
    });

    it("uses the approved template and all four approved platform links; a live send is refused without the Apple links", async () => {
        const mode = modeOf("--send", "--only-emails=ann@example.com");
        assert.deepEqual(liveSendBlockers(NO_APPLE_CONFIG, mode), ["HEALTHAGE_IOS_URL is not set", "HEALTHAGE_MACOS_URL is not set"]);
        assert.deepEqual(liveSendBlockers(FULL_CONFIG, mode), []);

        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        await runStage({ args: ["--send", "--only-emails=ann@example.com"], db, log });
        const request = log.sent[0]!.request;
        const message = buildFreeYearMessage(request, "from@test.invalid", log.sent[0]!.headers);
        const approved = getLegacyFreeYearEmailContent({
            customerName: request.customerName,
            accountEmail: request.accountEmail,
            workspaceName: request.workspaceName,
            purchase: request.purchase,
            startDate: request.startDate,
            expiryDate: request.expiryDate,
            androidUrl: FULL_CONFIG.androidUrl,
            windowsUrl: FULL_CONFIG.windowsUrl,
            iosUrl: FULL_CONFIG.iosUrl,
            macosUrl: FULL_CONFIG.macosUrl,
            supportEmail: FULL_CONFIG.supportEmail!,
        });
        assert.equal(message.subject, emailSubjectFor(request.purchase));
        assert.equal(message.text, approved.text);
        assert.equal(message.html, approved.html);
        for (const url of [FULL_CONFIG.androidUrl, FULL_CONFIG.windowsUrl, FULL_CONFIG.iosUrl, FULL_CONFIG.macosUrl]) {
            assert.ok(message.text.includes(url!), url!);
        }
        assert.equal(log.sent[0]!.headers, undefined, "a pilot message is the real message: no test marker");
    });

    it("the CLI passes the list into the plan and refuses an unresolvable live run before any sender exists", () => {
        const cli = readFileSync(resolve(process.cwd(), "scripts/migrations/legacy-shopify-customers/send-emails.ts"), "utf8");
        assert.match(cli, /planEmailRun\(rows, context, mode\.limit, mode\.onlyEmails\)/);
        // Look inside main(): the sample runner above it builds its own (guarded) sender.
        const main = cli.slice(cli.indexOf("async function main()"));
        const refuse = main.indexOf("assertTargetingActionable(runPlan.targeting)");
        const sender = main.indexOf("createGuardedSender({");
        assert.ok(refuse > 0 && sender > 0 && refuse < sender, "the refusal must come before the sender is created");
        assert.match(cli, /if \(mode\.sends\) assertTargetingActionable/);
    });
});

// ---------------------------------------------------------------------------
// The pilot, rehearsed end to end on the synthetic export
// ---------------------------------------------------------------------------

describe("pilot rehearsal: stage 1 then stage 2 for exactly two customers", () => {
    const names = new Map(PILOT_PLAN.customers.filter((customer) => customer.email).map((customer) => [customer.email, customer.customerName]));
    const context: ClassifyContext = {
        nameByEmail: names,
        purchaseByEmail: buildPurchaseIndex(PILOT_PLAN.customers),
        now: new Date("2026-11-10T00:00:00.000Z"),
    };

    it("migrates and emails the two listed customers once each, and nobody else, ever", async () => {
        const store = createStageOneStore();
        const stageOne = await runStageOneWith({ store, args: ["--apply", "--no-email", `--only-emails=${PILOT_PAIR.toUpperCase()}`] });
        assert.deepEqual(stageOne.sentEmails, [], "stage 1 sends nothing");
        assert.equal(stageOne.targeting?.eligible.length, 2);

        const db = createLedgerDb(stageTwoRows(store));
        const previewLog = createSenderLog();
        const preview = await runStage({ args: [`--only-emails=${PILOT_PAIR}`], db, log: previewLog, context });
        assert.deepEqual(previewLog.attempts, [], "the preview sends nothing");
        assert.deepEqual(preview.runPlan.targeting?.selected.map((entry) => entry.email), ["pilot.large@example.com", "pilot.small@example.com"]);
        assert.equal(db.ledgerWrites(), 0);

        const live = createSenderLog();
        const sent = await runStage({ args: ["--send", `--only-emails=${PILOT_PAIR}`], db, log: live, context });
        assert.deepEqual(statuses2(sent.outcomes), ["sent", "sent"]);
        assert.deepEqual(live.recipients(), ["pilot.large@example.com", "pilot.small@example.com"]);
        assert.deepEqual(
            live.sent.map((entry) => [entry.request.customerName, entry.request.startDate, entry.request.expiryDate]),
            [
                ["Pilot Large", "2026-11-04", "2027-11-04"],
                ["Pilot Small", "2026-11-04", "2027-11-04"],
            ]
        );
        assert.ok(live.sent.every((entry) => entry.headers === undefined));
        assert.equal(db.ledgerWrites(), 2);
        for (const email of ["pilot.large@example.com", "pilot.small@example.com"]) {
            const workspace = db.rows().find((candidate) => candidate.owner_email === email)!;
            assert.equal(notesIndicateFreeYearEmailSent(workspace.notes), true, email);
        }

        // Nobody else has a workspace, so nobody else can be owed an email.
        for (const email of ["other.large@example.com", "other.dyha@example.com", "pilot.large+extra@example.com", "refunded@example.com", "partial@example.com"]) {
            assert.equal(workspacesOf(store, email).length, 0, email);
        }

        // Re-running the very same command is a harmless no-op.
        const again = createSenderLog();
        const rerun = await runStage({ args: ["--send", `--only-emails=${PILOT_PAIR}`], db, log: again, context });
        assert.deepEqual(again.attempts, []);
        assert.deepEqual(rerun.outcomes, []);
        assert.equal(rerun.runPlan.targeting?.alreadyEmailed.length, 2);
        assert.equal(emailRunExitCode(rerun.outcomes), 0);

        // And a customer outside the list cannot be emailed by naming them: they have no workspace.
        const stranger = createSenderLog();
        await assert.rejects(
            runStage({ args: ["--send", "--only-emails=other.large@example.com"], db, log: stranger, context }),
            /no migration workspace/
        );
        assert.deepEqual(stranger.attempts, []);
    });

    function statuses2(outcomes: ReadonlyArray<{ status: string }>) {
        return outcomes.map((outcome) => outcome.status);
    }

    it("even if other customers were migrated earlier, a pilot send reaches only the listed two", async () => {
        const store = createStageOneStore();
        // Everyone eligible was migrated (by a previous, wider run).
        await runStageOneWith({ store, args: ["--apply", "--no-email"] });
        assert.equal(store.workspaces.length, 6, "five newly migrated customers plus the one that already existed");

        const db = createLedgerDb(stageTwoRows(store));
        const log = createSenderLog();
        const run = await runStage({ args: ["--send", `--only-emails=${PILOT_PAIR}`], db, log, context });

        assert.deepEqual(log.recipients(), ["pilot.large@example.com", "pilot.small@example.com"]);
        assert.ok(run.runPlan.pending.length > 2, "many customers are owed the email");
        const stillPending = planEmailRun(db.rows(), context, null).pending.map((candidate) => candidate.email);
        assert.ok(stillPending.includes("other.large@example.com"));
        assert.ok(stillPending.includes("pilot.large+extra@example.com"));
        assert.ok(!stillPending.includes("pilot.large@example.com"));
    });
});

// ---------------------------------------------------------------------------
// Sample email mode: synthetic data, explicit test addresses, nothing else
// ---------------------------------------------------------------------------

const SAMPLE_ONE = "sample.one@test.example";
const SAMPLE_TWO = "sample.two@test.example";
const SAMPLE_PAIR = `${SAMPLE_ONE},${SAMPLE_TWO}`;
const MIGRATION_DIR = "scripts/migrations/legacy-shopify-customers";
const readMigrationSource = (file: string) => readFileSync(resolve(process.cwd(), MIGRATION_DIR, file), "utf8");

describe("sample email mode (--sample): flags and mode", () => {
    const modeOf = (...args: string[]) => resolveSendMode(parseSendEmailsArgs(args));

    it("recognises the two flags and records whether --csv / --out were given", () => {
        const plain = parseSendEmailsArgs(["--sample", `--test-recipients=${SAMPLE_PAIR}`]);
        assert.deepEqual([plain.sample, plain.sendSample, plain.csvExplicit, plain.outExplicit], [true, false, false, false]);
        const full = parseSendEmailsArgs(["--sample", "--send-sample", "--csv=x.csv", "--out=r"]);
        assert.deepEqual([full.sample, full.sendSample, full.csvExplicit, full.outExplicit], [true, true, true, true]);
        assert.deepEqual(parseSendEmailsArgs([]).sample, false);
    });

    it("preview is the default: --sample alone with test recipients sends nothing", () => {
        const mode = modeOf("--sample", `--test-recipients=${SAMPLE_PAIR}`);
        assert.deepEqual(
            { target: mode.target, sends: mode.sends, limit: mode.limit, only: mode.onlyEmails, links: mode.allowMissingPlatformLinks },
            { target: "sample", sends: false, limit: null, only: [], links: false }
        );
        assert.deepEqual(mode.testRecipients, [SAMPLE_ONE, SAMPLE_TWO]);
    });

    it("actual delivery needs the explicit --send-sample, and --dry-run still wins over it", () => {
        assert.equal(modeOf("--sample", "--send-sample", `--test-recipients=${SAMPLE_PAIR}`).sends, true);
        assert.equal(modeOf("--sample", "--send-sample", "--dry-run", `--test-recipients=${SAMPLE_PAIR}`).sends, false);
        assert.equal(modeOf("--dry-run", "--sample", `--test-recipients=${SAMPLE_PAIR}`).sends, false);
    });

    it("--send-sample on its own is an error: it never delivers anything without --sample", () => {
        assert.throws(() => modeOf("--send-sample", `--test-recipients=${SAMPLE_PAIR}`), /--send-sample requires --sample/);
        assert.throws(() => modeOf("--send-sample"), /--send-sample requires --sample/);
    });

    it("--test-recipients is required, and the list is normalized and de-duplicated", () => {
        assert.throws(() => modeOf("--sample"), /--sample needs --test-recipients/);
        assert.throws(() => modeOf("--sample", "--send-sample"), /--sample needs --test-recipients/);
        assert.throws(() => modeOf("--sample", "--test-recipients="), /at least one address/);
        assert.throws(() => modeOf("--sample", "--test-recipients=not-an-email"), /invalid address/);
        assert.deepEqual(modeOf("--sample", `--test-recipients= ${SAMPLE_ONE.toUpperCase()} ,${SAMPLE_ONE},${SAMPLE_TWO}`).testRecipients, [
            SAMPLE_ONE,
            SAMPLE_TWO,
        ]);
    });

    it("rejects every flag that belongs to real customers or to the export, naming each one", () => {
        const base = ["--sample", `--test-recipients=${SAMPLE_PAIR}`];
        const conflicts: Array<[string, string]> = [
            ["--send", "--send"],
            ["--all", "--all"],
            ["--limit=3", "--limit"],
            ["--only-emails=ann@example.com", "--only-emails"],
            ["--csv=orders_export_1.csv", "--csv"],
            ["--out=reports", "--out"],
            ["--allow-missing-platform-links", "--allow-missing-platform-links"],
        ];
        for (const [flag, name] of conflicts) {
            for (const extra of [[], ["--send-sample"]]) {
                assert.throws(() => modeOf(...base, ...extra, flag), (error: Error) => error.message.includes(`--sample cannot be combined with ${name}`) , `${flag} ${extra.join(" ")}`);
            }
        }
        // Several conflicts are all named at once.
        assert.throws(() => modeOf(...base, "--send", "--all", "--limit=1", "--only-emails=a@x.com"), /--send, --all, --limit, --only-emails/);
        // The error points at the right flag for delivering a sample.
        assert.throws(() => modeOf(...base, "--send"), /use --send-sample/);
    });

    it("can never become a customer run: every accepted sample combination resolves to target 'sample'", () => {
        const optional = [[], ["--send-sample"], ["--dry-run"], ["--send-sample", "--dry-run"]];
        for (const extra of optional) {
            const mode = modeOf("--sample", `--test-recipients=${SAMPLE_PAIR}`, ...extra);
            assert.equal(mode.target, "sample", extra.join(" "));
            assert.deepEqual(mode.onlyEmails, []);
        }
        // Without --sample, --test-recipients keeps its existing (customer-rendering) meaning, and --send-sample is refused.
        assert.equal(modeOf(`--test-recipients=${SAMPLE_PAIR}`).target, "test");
        assert.equal(modeOf("--send", "--all").target, "live");
    });
});

describe("sample email mode (--sample): content and delivery", () => {
    const sampleMode = (...extra: string[]) => resolveSendMode(parseSendEmailsArgs(["--sample", `--test-recipients=${SAMPLE_PAIR}`, ...extra]));
    const runSample = async (extra: string[], config: EmailConfig = FULL_CONFIG, log = createSenderLog()) => {
        const mode = sampleMode(...extra);
        const sender = createGuardedSender({ mode, liveRecipients: new Set(), rawSender: log.raw });
        const outcomes = await runSampleStage({ mode, emailConfig: config, sender });
        return { mode, outcomes, log };
    };

    it("renders the approved subject and body with synthetic, clearly labelled values", () => {
        const content = renderSampleEmail(FULL_CONFIG);
        const approved = getLegacyFreeYearEmailContent({
            customerName: SAMPLE_CUSTOMER_NAME,
            accountEmail: SAMPLE_ACCOUNT_EMAIL,
            workspaceName: SAMPLE_WORKSPACE_NAME,
            purchase: buildSamplePurchase("large"),
            startDate: SAMPLE_START_DATE,
            expiryDate: SAMPLE_EXPIRY_DATE,
            androidUrl: FULL_CONFIG.androidUrl,
            windowsUrl: FULL_CONFIG.windowsUrl,
            iosUrl: FULL_CONFIG.iosUrl,
            macosUrl: FULL_CONFIG.macosUrl,
            supportEmail: FULL_CONFIG.supportEmail!,
        });
        assert.equal(content.subject, EMAIL_SUBJECTS.large_venue_kit);
        assert.equal(content.text, approved.text);
        assert.equal(content.html, approved.html);

        assert.equal(SAMPLE_CUSTOMER_NAME, "HealthAge Test Customer");
        assert.match(content.text, /^Hi HealthAge Test Customer,/);
        assert.match(content.text, /Start Date: 2026-01-01 \(sample date\)/);
        assert.match(content.text, /Expiry Date: 2027-01-01 \(sample date\)/);
        assert.ok(content.text.includes("Important: Discontinuation of the Previous HealthAge Software"), "the sample carries the discontinuation notice");
        assert.ok(content.html.includes("Important: Discontinuation of the Previous HealthAge Software"));
        // In the HTML the label and the value are separate boxes of the details card.
        assert.match(content.html, />Start Date<\/div>/);
        assert.match(content.html, />2026-01-01 \(sample date\)<\/div>/);
        assert.match(SAMPLE_START_DATE + SAMPLE_EXPIRY_DATE, /sample date.*sample date/);
    });

    it("contains all four configured platform links (and the support address) in both the text and the HTML", () => {
        const content = renderSampleEmail(FULL_CONFIG);
        for (const body of [content.text, content.html]) {
            for (const url of [FULL_CONFIG.androidUrl, FULL_CONFIG.windowsUrl, FULL_CONFIG.iosUrl, FULL_CONFIG.macosUrl]) {
                assert.ok(body.includes(url!), `${url} missing from the sample`);
            }
            assert.ok(body.includes(FULL_CONFIG.supportEmail!));
        }
        for (const label of ["Android:", "Windows:", "iOS:", "macOS:"]) assert.ok(content.text.includes(label), label);
        assert.doesNotMatch(content.text + content.html, /undefined|null/);
    });

    it("a sample SEND is refused unless all four links and the support address are configured, with no override", async () => {
        assert.deepEqual(sampleSendBlockers(FULL_CONFIG), []);
        assert.deepEqual(sampleSendBlockers(NO_APPLE_CONFIG), ["HEALTHAGE_IOS_URL is not set", "HEALTHAGE_MACOS_URL is not set"]);
        assert.deepEqual(sampleSendBlockers({ ...FULL_CONFIG, androidUrl: null, windowsUrl: null }), [
            "HEALTHAGE_ANDROID_URL is not set",
            "HEALTHAGE_WINDOWS_URL is not set",
        ]);
        assert.ok(sampleSendBlockers({ ...FULL_CONFIG, supportEmail: null }).length > 0);

        const log = createSenderLog();
        await assert.rejects(runSample(["--send-sample"], NO_APPLE_CONFIG, log), /Sample send refused: HEALTHAGE_IOS_URL is not set; HEALTHAGE_MACOS_URL is not set/);
        assert.deepEqual(log.attempts, [], "nothing was attempted");
        // The live-send override does not exist for samples.
        assert.throws(() => sampleMode("--allow-missing-platform-links", "--send-sample"), /--sample cannot be combined with --allow-missing-platform-links/);
    });

    it("a preview sends nothing, whatever the sender would have done", async () => {
        const { outcomes, log } = await runSample([]);
        assert.deepEqual(log.attempts, []);
        assert.deepEqual(outcomes.map((outcome) => [outcome.to, outcome.status]), [
            [SAMPLE_ONE, "previewed"],
            [SAMPLE_TWO, "previewed"],
        ]);
        const dry = await runSample(["--send-sample", "--dry-run"]);
        assert.deepEqual(dry.log.attempts, []);
        assert.ok(dry.outcomes.every((outcome) => outcome.status === "previewed"));
    });

    it("the guard itself refuses a sample send in preview mode, even if the code above it is wrong", async () => {
        const log = createSenderLog();
        const mode = sampleMode();
        const guarded = createGuardedSender({ mode, liveRecipients: new Set(), rawSender: log.raw });
        await assert.rejects(guarded(buildSampleRequest(SAMPLE_ONE, FULL_CONFIG)), /preview/);
        assert.deepEqual(log.attempts, []);
    });

    it("--send-sample delivers one synthetic email to each listed address and to nobody else", async () => {
        const { outcomes, log } = await runSample(["--send-sample"]);

        assert.deepEqual(log.attempts, [SAMPLE_ONE, SAMPLE_TWO]);
        assert.deepEqual(outcomes.map((outcome) => outcome.status), ["sent", "sent"]);
        for (const entry of log.sent) {
            assert.equal(entry.request.customerName, SAMPLE_CUSTOMER_NAME);
            assert.equal(entry.request.startDate, SAMPLE_START_DATE);
            assert.equal(entry.request.expiryDate, SAMPLE_EXPIRY_DATE);
            assert.equal(entry.request.supportEmail, FULL_CONFIG.supportEmail);
            assert.deepEqual(
                [entry.request.androidUrl, entry.request.windowsUrl, entry.request.iosUrl, entry.request.macosUrl],
                [FULL_CONFIG.androidUrl, FULL_CONFIG.windowsUrl, FULL_CONFIG.iosUrl, FULL_CONFIG.macosUrl]
            );
            assert.equal(entry.headers?.[TEST_MODE_HEADER], "sample", "marked as a sample in a header, body untouched");
        }
        // The message is the approved template byte for byte.
        const message = buildFreeYearMessage(log.sent[0]!.request, "from@test.invalid", log.sent[0]!.headers);
        const content = renderSampleEmail(FULL_CONFIG);
        assert.equal(message.subject, content.subject);
        assert.equal(message.text, content.text);
        assert.equal(message.html, content.html);
    });

    it("exact recipient allowlist: the guard refuses any address that is not listed, however it is spelled", async () => {
        const log = createSenderLog();
        const mode = sampleMode("--send-sample");
        const guarded = createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw });

        for (const stranger of ["ann@example.com", "sample.one+x@test.example", "ample.one@test.example", "sample.one@test.example.org", "sample.three@test.example"]) {
            await assert.rejects(guarded(buildSampleRequest(stranger, FULL_CONFIG)), /not on the test recipient allowlist/, stranger);
        }
        await guarded(buildSampleRequest("SAMPLE.ONE@TEST.EXAMPLE", FULL_CONFIG));
        assert.deepEqual(log.attempts, ["SAMPLE.ONE@TEST.EXAMPLE"], "only the listed address, case-insensitively");
    });

    it("duplicate and differently-cased recipients get exactly one email", async () => {
        const mode = resolveSendMode(
            parseSendEmailsArgs(["--sample", "--send-sample", `--test-recipients=${SAMPLE_ONE.toUpperCase()},${SAMPLE_ONE},${SAMPLE_ONE}`])
        );
        const log = createSenderLog();
        const outcomes = await runSampleStage({
            mode,
            emailConfig: FULL_CONFIG,
            sender: createGuardedSender({ mode, liveRecipients: new Set(), rawSender: log.raw }),
        });
        assert.equal(outcomes.length, 1);
        assert.deepEqual(log.attempts, [SAMPLE_ONE]);
    });

    it("one failing address does not stop the other, and is reported as failed", async () => {
        const { outcomes, log } = await runSample(["--send-sample"], FULL_CONFIG, createSenderLog([SAMPLE_ONE]));
        assert.deepEqual(log.attempts, [SAMPLE_ONE, SAMPLE_TWO]);
        assert.deepEqual(outcomes.map((outcome) => outcome.status), ["failed", "sent"]);
        assert.match(outcomes[0]?.error ?? "", /451/);
    });

    it("the live stage runner refuses a sample mode, so it can never fall through to customers or the ledger", async () => {
        const db = createLedgerDb(standardRows());
        const log = createSenderLog();
        const mode = sampleMode("--send-sample");
        const everyone = planEmailRun(db.rows(), CONTEXT, null);
        await assert.rejects(
            runEmailStage({
                mode,
                selected: everyone.selected,
                emailConfig: FULL_CONFIG,
                sender: createGuardedSender({ mode, liveRecipients: new Set(everyone.selected.map((c) => c.email)), rawSender: log.raw }),
                ledger: db.runner,
                context: CONTEXT,
            }),
            /does not handle sample mode/
        );
        assert.deepEqual(log.attempts, []);
        assert.equal(db.transactions(), 0, "no ledger transaction, no lock");
        assert.equal(db.ledgerWrites(), 0);
    });

    it("the sample runner only runs sample modes", async () => {
        const log = createSenderLog();
        for (const args of [["--send", "--all"], [`--test-recipients=${SAMPLE_PAIR}`], ["--dry-run"]]) {
            const mode = resolveSendMode(parseSendEmailsArgs(args));
            await assert.rejects(
                runSampleStage({ mode, emailConfig: FULL_CONFIG, sender: createGuardedSender({ mode, liveRecipients: new Set(), rawSender: log.raw }) }),
                /only runs in sample mode/,
                args.join(" ")
            );
        }
        assert.deepEqual(log.attempts, []);
    });

    it("existing modes are unchanged: test mode still carries the 'test' marker and the live guard still guards", async () => {
        const log = createSenderLog();
        const test = resolveSendMode(parseSendEmailsArgs([`--test-recipients=${SAMPLE_ONE}`]));
        await createGuardedSender({ mode: test, liveRecipients: new Set(), rawSender: log.raw })(buildSampleRequest(SAMPLE_ONE, FULL_CONFIG));
        assert.equal(log.sent[0]?.headers?.[TEST_MODE_HEADER], "test");

        const live = resolveSendMode(parseSendEmailsArgs(["--send", "--limit=1"]));
        await assert.rejects(
            createGuardedSender({ mode: live, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw })(buildSampleRequest(SAMPLE_ONE, FULL_CONFIG)),
            /not a selected pending/
        );
    });
});

describe("sample email mode (--sample): isolation from the database, the export and the ledger", () => {
    it("the sample code takes no customer, database, export or ledger and calls none", () => {
        const core = readMigrationSource("send-emails-core.ts");
        const section = core.slice(core.indexOf("// Sample email: synthetic data"));
        assert.ok(section.length > 500 && section.includes("runSampleStage"), "found the sample section");
        for (const forbidden of [
            "LedgerRunner",
            "LedgerTransaction",
            "recordEmailSent",
            "claimWorkspace",
            "runInTransaction",
            "MigratedWorkspaceRow",
            "EmailCandidate",
            "planEmailRun",
            "classifyWorkspace",
            "readOrdersCsv",
            "Pool",
        ]) {
            assert.equal(section.includes(forbidden), false, `the sample section must not use ${forbidden}`);
        }
    });

    it("the CLI's sample path touches no database, export, report folder or ledger", () => {
        const cli = readMigrationSource("send-emails.ts");
        const samplePath = cli.slice(cli.indexOf("async function runSampleMode"), cli.indexOf("async function main()"));
        assert.ok(samplePath.includes("runSampleStage") && samplePath.includes("printSampleSummary"));
        for (const forbidden of [
            "Pool",
            "loadMigratedWorkspaces",
            "createPgLedgerRunner",
            "readOrdersCsv",
            "buildMigrationPlan",
            "mkdirSync",
            "writeFileSync",
            "DATABASE_URL",
            "planEmailRun",
            "runEmailStage",
            "writeReport",
        ]) {
            assert.equal(samplePath.includes(forbidden), false, `the sample path must not use ${forbidden}`);
        }
    });

    it("main() decides sample mode before it ever looks at DATABASE_URL, the CSV, the pool or the report folder", () => {
        const cli = readMigrationSource("send-emails.ts");
        const main = cli.slice(cli.indexOf("async function main()"));
        const branch = main.indexOf('mode.target === "sample"');
        assert.ok(branch > 0, "main has a sample branch");
        for (const later of ["liveSendBlockers(", "process.env.DATABASE_URL", "readOrdersCsv(", "new Pool(", "mkdirSync(", "writeReport("]) {
            const at = main.indexOf(later);
            assert.ok(at > branch, `${later} must come after the sample branch`);
        }
        assert.match(main.slice(branch, branch + 200), /await runSampleMode\(mode, emailConfig\);\s*return;/);
    });
});

// ---------------------------------------------------------------------------
// Sample mode end to end: the REAL CLI in a subprocess, against loopback traps only.
//
// The child gets a sanitized environment (never process.env): DATABASE_URL points at a TCP
// listener that counts connection attempts, SMTP points at a fake SMTP server that records
// every recipient and message, and the working directory is an empty temp folder (no CSV, no
// report folder). Nothing here can reach a real database or mail server.
// ---------------------------------------------------------------------------

type FakeSmtp = {
    port: number;
    connections: number;
    rcpts: string[];
    messages: string[];
    close(): Promise<void>;
};

function listen(server: Server): Promise<number> {
    return new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => resolveListen((server.address() as { port: number }).port));
    });
}

const closeServer = (server: Server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()));

/** A minimal SMTP server: accepts everything (except recipients in `reject`), records every accepted recipient and message. */
async function startFakeSmtp(options: { reject?: readonly string[] } = {}): Promise<FakeSmtp> {
    const rejected = new Set((options.reject ?? []).map((address) => address.toLowerCase()));
    const state = { connections: 0, rcpts: [] as string[], messages: [] as string[] };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        state.connections += 1;
        let buffer = "";
        let inData = false;
        let authStep: "none" | "user" | "pass" = "none";
        const reply = (line: string) => socket.write(`${line}\r\n`);
        reply("220 sample.test ESMTP ready");

        socket.on("data", (chunk) => {
            buffer += chunk.toString("latin1");
            for (;;) {
                if (inData) {
                    const end = buffer.indexOf("\r\n.\r\n");
                    if (end < 0) return;
                    state.messages.push(buffer.slice(0, end).replace(/\r\n\.\./g, "\r\n."));
                    buffer = buffer.slice(end + 5);
                    inData = false;
                    reply("250 2.0.0 queued");
                    continue;
                }
                const eol = buffer.indexOf("\r\n");
                if (eol < 0) return;
                const line = buffer.slice(0, eol);
                buffer = buffer.slice(eol + 2);

                if (authStep === "user") {
                    authStep = "pass";
                    reply("334 UGFzc3dvcmQ6");
                } else if (authStep === "pass") {
                    authStep = "none";
                    reply("235 2.7.0 authenticated");
                } else if (/^EHLO/i.test(line)) {
                    socket.write("250-sample.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
                } else if (/^HELO/i.test(line)) {
                    reply("250 sample.test");
                } else if (/^AUTH PLAIN/i.test(line)) {
                    reply("235 2.7.0 authenticated");
                } else if (/^AUTH LOGIN/i.test(line)) {
                    authStep = "user";
                    reply("334 VXNlcm5hbWU6");
                } else if (/^RCPT TO:/i.test(line)) {
                    const address = /<([^>]*)>/.exec(line)?.[1] ?? line;
                    if (rejected.has(address.toLowerCase())) {
                        reply("550 5.1.1 mailbox unavailable");
                    } else {
                        state.rcpts.push(address);
                        reply("250 2.1.5 ok");
                    }
                } else if (/^DATA/i.test(line)) {
                    inData = true;
                    reply("354 end with <CRLF>.<CRLF>");
                } else if (/^QUIT/i.test(line)) {
                    reply("221 2.0.0 bye");
                    socket.end();
                } else {
                    reply("250 2.0.0 ok");
                }
            }
        });
        socket.on("error", () => undefined);
    });
    const port = await listen(server);
    return {
        port,
        get connections() {
            return state.connections;
        },
        get rcpts() {
            return state.rcpts;
        },
        get messages() {
            return state.messages;
        },
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await closeServer(server);
        },
    };
}

/** Stands in for PostgreSQL: counts connection attempts and hangs up. */
async function startDatabaseTrap(): Promise<{ port: number; attempts: () => number; close(): Promise<void> }> {
    let attempts = 0;
    const server = createServer((socket) => {
        attempts += 1;
        socket.destroy();
    });
    const port = await listen(server);
    return { port, attempts: () => attempts, close: () => closeServer(server) };
}

const OS_ENV_KEYS = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"];

function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of OS_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    return { ...env, ...extra };
}

/** Runs the real send-emails.ts under tsx in `cwd` with exactly `env`. */
function runCli(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const tsx = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const script = resolve(process.cwd(), MIGRATION_DIR, "send-emails.ts");
    assert.ok(existsSync(tsx), "tsx is installed");
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [tsx, script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => {
            child.kill();
            rejectRun(new Error(`CLI timed out. stdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 90_000);
        child.on("error", rejectRun);
        child.on("close", (code) => {
            clearTimeout(timer);
            // Let any loopback connection the child made just before exiting reach the traps' counters.
            setTimeout(() => resolveRun({ code, stdout, stderr }), 150);
        });
    });
}

/** Decodes RFC 2047 encoded words (`=?UTF-8?Q?...?=`), which the mailer uses for a header with a non-ASCII character such as the en dash in a subject. */
function decodeMimeWords(value: string): string {
    return value
        .replace(/(=\?UTF-8\?[QB]\?[^?]*\?=)\s+(?==\?UTF-8\?[QB]\?)/gi, "$1")
        .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_match, kind: string, data: string) => {
            if (/^b$/i.test(kind)) return Buffer.from(data, "base64").toString("utf8");
            const text = data.replace(/_/g, " ");
            const bytes: number[] = [];
            for (let i = 0; i < text.length; i++) {
                const hex = text.slice(i + 1, i + 3);
                if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
                    bytes.push(parseInt(hex, 16));
                    i += 2;
                } else bytes.push(text.charCodeAt(i));
            }
            return Buffer.from(bytes).toString("utf8");
        });
}

/** Decodes the text/plain and text/html parts of a captured message. */
function decodeMessage(raw: string): { headers: Record<string, string>; text: string; html: string } {
    const split = (value: string): [string, string] => {
        const at = value.indexOf("\r\n\r\n");
        return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + 4)];
    };
    const parseHeaders = (block: string) => {
        const headers: Record<string, string> = {};
        for (const line of block.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
            const colon = line.indexOf(":");
            if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = decodeMimeWords(line.slice(colon + 1).trim());
        }
        return headers;
    };
    const decodeBody = (body: string, encoding: string | undefined): string => {
        if (/quoted-printable/i.test(encoding ?? "")) {
            const joined = body.replace(/=\r?\n/g, "");
            const bytes: number[] = [];
            for (let i = 0; i < joined.length; i++) {
                const hex = joined.slice(i + 1, i + 3);
                if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
                    bytes.push(parseInt(hex, 16));
                    i += 2;
                } else bytes.push(joined.charCodeAt(i));
            }
            return Buffer.from(bytes).toString("utf8");
        }
        if (/base64/i.test(encoding ?? "")) return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
        return Buffer.from(body, "latin1").toString("utf8");
    };

    const [head, body] = split(raw);
    const headers = parseHeaders(head);
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
    let text = "";
    let html = "";
    const parts = boundary ? body.split(`--${boundary}`).slice(1, -1) : [raw];
    for (const part of parts) {
        const [partHead, partBody] = split(part.replace(/^\r\n/, ""));
        const partHeaders = parseHeaders(partHead);
        const decoded = decodeBody(partBody, partHeaders["content-transfer-encoding"]);
        if (/text\/plain/i.test(partHeaders["content-type"] ?? "")) text = decoded;
        if (/text\/html/i.test(partHeaders["content-type"] ?? "")) html = decoded;
    }
    return { headers, text, html };
}

describe("sample email mode (--sample): the real CLI against loopback traps", () => {
    // FULL_CONFIG has all four links set; these are the strings the child process is given.
    const FOUR_LINKS = [FULL_CONFIG.androidUrl!, FULL_CONFIG.windowsUrl!, FULL_CONFIG.iosUrl!, FULL_CONFIG.macosUrl!];
    const LINKS = {
        HEALTHAGE_ANDROID_URL: FOUR_LINKS[0]!,
        HEALTHAGE_WINDOWS_URL: FOUR_LINKS[1]!,
        HEALTHAGE_IOS_URL: FOUR_LINKS[2]!,
        HEALTHAGE_MACOS_URL: FOUR_LINKS[3]!,
        HEALTHAGE_SUPPORT_EMAIL: FULL_CONFIG.supportEmail!,
    };

    async function withTraps<T>(
        body: (ctx: { cwd: string; smtp: FakeSmtp; db: Awaited<ReturnType<typeof startDatabaseTrap>>; env: (extra?: Record<string, string>) => NodeJS.ProcessEnv }) => Promise<T>,
        smtpOptions: { reject?: readonly string[] } = {}
    ): Promise<T> {
        const smtp = await startFakeSmtp(smtpOptions);
        const db = await startDatabaseTrap();
        const cwd = mkdtempSync(join(tmpdir(), "healthage-sample-"));
        const env = (extra: Record<string, string> = {}) =>
            sanitizedEnv({
                DATABASE_URL: `postgres://trap:trap@127.0.0.1:${db.port}/trap`,
                SMTP_HOST: "127.0.0.1",
                SMTP_PORT: String(smtp.port),
                SMTP_USER: "sample-user",
                SMTP_PASS: "sample-pass",
                EMAIL_FROM: "HealthAge Sample <noreply@sample.test>",
                ...LINKS,
                ...extra,
            });
        try {
            return await body({ cwd, smtp, db, env });
        } finally {
            await smtp.close();
            await db.close();
            rmSync(cwd, { recursive: true, force: true });
        }
    }

    it("PREVIEW: prints the sample email, contacts neither the database nor the mail server, reads no CSV and writes nothing", async () => {
        await withTraps(async ({ cwd, smtp, db, env }) => {
            const result = await runCli(cwd, env(), ["--sample", `--test-recipients=${SAMPLE_PAIR}`]);

            assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
            assert.match(result.stdout, /SAMPLE PREVIEW — nothing is sent/);
            assert.match(result.stdout, /No email was sent/);
            assert.ok(result.stdout.includes(`${SAMPLE_ONE}, ${SAMPLE_TWO}`));
            assert.ok(result.stdout.includes(`Subject: ${EMAIL_SUBJECTS.large_venue_kit}`), "the default sample is the Large Venue Kit email");
            assert.match(result.stdout, /Hi HealthAge Test Customer,/);
            assert.match(result.stdout, /Important: Discontinuation of the Previous HealthAge Software/, "the sample preview shows the notice too");
            assert.match(result.stdout, /Start Date: 2026-01-01 \(sample date\)/);
            for (const url of FOUR_LINKS) {
                assert.ok(result.stdout.includes(url), `preview must show ${url}`);
            }
            assert.equal(db.attempts(), 0, "PostgreSQL must never be contacted");
            assert.equal(smtp.connections, 0, "a preview must not even open a mail connection");
            assert.deepEqual(readdirSync(cwd), [], "no report folder, no CSV, nothing written in the working directory");
        });
    });

    it("SAMPLE SEND: the fake mail server receives exactly the listed addresses, the approved template, and no database is touched", async () => {
        await withTraps(async ({ cwd, smtp, db, env }) => {
            const result = await runCli(cwd, env(), ["--sample", "--send-sample", `--test-recipients=${SAMPLE_PAIR}`]);

            assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
            assert.match(result.stdout, /Delivered to 2 of 2 address\(es\)/);
            assert.deepEqual([...smtp.rcpts].sort(), [SAMPLE_ONE, SAMPLE_TWO], "exactly the two listed recipients, nobody else");
            assert.equal(smtp.messages.length, 2);

            const approved = renderSampleEmail(FULL_CONFIG);
            const normalize = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();
            const toHeaders: string[] = [];
            for (const raw of smtp.messages) {
                const message = decodeMessage(raw);
                toHeaders.push(message.headers["to"] ?? "");
                assert.equal(message.headers["subject"], approved.subject);
                assert.equal(message.headers["x-healthage-migration-email-mode"], "sample");
                assert.ok((message.headers["from"] ?? "").includes("noreply@sample.test"));
                assert.equal(normalize(message.text), normalize(approved.text), "text part is the approved template with sample values");
                assert.equal(normalize(message.html), normalize(approved.html), "html part is the approved template with sample values");
                for (const url of FOUR_LINKS) {
                    assert.ok(message.text.includes(url) && message.html.includes(url), `${url} missing from the delivered message`);
                }
                assert.ok(message.text.includes(FULL_CONFIG.supportEmail!));
            }
            assert.deepEqual(toHeaders.map((value) => value.replace(/.*<|>.*/g, "")).sort(), [SAMPLE_ONE, SAMPLE_TWO]);

            assert.equal(db.attempts(), 0, "PostgreSQL must never be contacted");
            assert.deepEqual(readdirSync(cwd), [], "nothing written: no report, no CSV");
        });
    });

    it("SAMPLE SEND with an unusable link is refused before the mail server is contacted", async () => {
        await withTraps(async ({ cwd, smtp, db, env }) => {
            const environment = env();
            environment.HEALTHAGE_IOS_URL = "javascript:alert(1)";
            const result = await runCli(cwd, environment, ["--sample", "--send-sample", `--test-recipients=${SAMPLE_PAIR}`]);

            assert.equal(result.code, 1);
            assert.match(result.stderr + result.stdout, /HEALTHAGE_IOS_URL is not a plain http\(s\) URL/);
            assert.equal(smtp.connections, 0, "the mail server is never contacted");
            assert.equal(db.attempts(), 0);
            assert.deepEqual(smtp.rcpts, []);
        });
    });

    it("an unset platform link falls back to the published listing, so a sample still shows all four platforms", async () => {
        await withTraps(async ({ cwd, smtp, db, env }) => {
            const environment = env();
            delete environment.HEALTHAGE_IOS_URL;
            delete environment.HEALTHAGE_MACOS_URL;
            const preview = await runCli(cwd, environment, ["--sample", `--test-recipients=${SAMPLE_PAIR}`]);

            assert.equal(preview.code, 0, `stdout:\n${preview.stdout}\nstderr:\n${preview.stderr}`);
            assert.ok(preview.stdout.includes("https://apps.apple.com/in/app/health-age/id6744716742"), "the published iOS listing");
            assert.ok(preview.stdout.includes("https://healthage.healthexporesources.com/download/"), "the published macOS download page");
            assert.doesNotMatch(preview.stdout, /NOT SET|WOULD BE REFUSED/);
            assert.equal(smtp.connections, 0);
            assert.equal(db.attempts(), 0);
        });
    });

    it("SAMPLE SEND when the mail server rejects one address: that address is reported failed, the other is still delivered, and the exit code is 1", async () => {
        await withTraps(
            async ({ cwd, smtp, db, env }) => {
                const result = await runCli(cwd, env(), ["--sample", "--send-sample", `--test-recipients=${SAMPLE_PAIR}`]);

                assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
                assert.match(result.stdout, new RegExp(`failed\\s+${SAMPLE_ONE.replace(/\./g, "\\.")}`));
                assert.match(result.stdout, new RegExp(`sent\\s+${SAMPLE_TWO.replace(/\./g, "\\.")}`));
                assert.match(result.stdout, /Delivered to 1 of 2 address\(es\)/);
                assert.deepEqual(smtp.rcpts, [SAMPLE_TWO], "only the accepted listed address received a message");
                assert.equal(db.attempts(), 0);
            },
            { reject: [SAMPLE_ONE] }
        );
    });

    it("conflicting flags are rejected with a non-zero exit before anything is contacted", async () => {
        await withTraps(async ({ cwd, smtp, db, env }) => {
            for (const args of [
                ["--sample", "--send", `--test-recipients=${SAMPLE_PAIR}`],
                ["--sample", "--send-sample", "--all", `--test-recipients=${SAMPLE_PAIR}`],
                ["--sample", "--limit=1", `--test-recipients=${SAMPLE_PAIR}`],
                ["--sample", "--only-emails=ann@example.com", `--test-recipients=${SAMPLE_PAIR}`],
                ["--sample", "--csv=orders_export_1.csv", `--test-recipients=${SAMPLE_PAIR}`],
                ["--sample", "--send-sample"],
                ["--send-sample", `--test-recipients=${SAMPLE_PAIR}`],
            ]) {
                const result = await runCli(cwd, env(), args);
                assert.equal(result.code, 1, args.join(" "));
                assert.match(result.stderr, /--sample|--send-sample/, args.join(" "));
            }
            assert.equal(smtp.connections, 0);
            assert.equal(db.attempts(), 0);
            assert.deepEqual(readdirSync(cwd), []);
        });
    });
});

// ---------------------------------------------------------------------------
// Personalised onboarding email: what each customer is told, and the protections around it
// ---------------------------------------------------------------------------

describe("stage 2 sends each customer the email for what they actually bought", () => {
    const LATER = new Date("2026-11-10T00:00:00.000Z");
    const contextFor = (): ClassifyContext => ({
        nameByEmail: new Map(PILOT_PLAN.customers.filter((c) => c.email).map((c) => [c.email, c.customerName])),
        purchaseByEmail: buildPurchaseIndex(PILOT_PLAN.customers),
        now: LATER,
    });

    it("end to end: every customer's email states the license count the migration wrote, in words that fit their product", async () => {
        const store = createStageOneStore();
        await runStageOneWith({ store, args: ["--apply", "--no-email"] });
        const db = createLedgerDb(stageTwoRows(store));
        const log = createSenderLog();
        const run = await runStage({ args: ["--send", "--all"], db, log, context: contextFor() });
        assert.equal(emailRunExitCode(run.outcomes), 0);

        // Each customer's email: the template for their product, and the license sentence for their real count.
        const expected: Record<string, { subject: string; licenses: RegExp }> = {
            "pilot.large@example.com": { subject: EMAIL_SUBJECTS.large_venue_kit, licenses: /Your Large Venue Kit includes 4 licenses:/ },
            "pilot.small@example.com": { subject: EMAIL_SUBJECTS.small_venue_kit, licenses: /Your Small Venue Kit includes one license for your personal use\./ },
            "pilot.large+extra@example.com": { subject: EMAIL_SUBJECTS.existing_customer, licenses: /Your Discover Your Health Age purchase includes 3 licenses:/ },
            "other.large@example.com": { subject: EMAIL_SUBJECTS.large_venue_kit, licenses: /Your 2 Large Venue Kits include 8 licenses:/ },
            "other.dyha@example.com": { subject: EMAIL_SUBJECTS.existing_customer, licenses: /Your Discover Your Health Age purchase includes 2 licenses:/ },
        };
        assert.deepEqual([...log.recipients()].sort(), Object.keys(expected).sort());

        const messages = log.sent.map((entry) => ({ entry, message: buildFreeYearMessage(entry.request, "from@test.invalid", entry.headers) }));
        for (const { entry, message } of messages) {
            const email = entry.request.to;
            const workspace = store.workspaces.find((candidate) => candidate.owner_email === email)!;
            const plan = PILOT_PLAN.customers.find((customer) => customer.email === email)!;
            const n = workspace.seat_limit;

            // One number, three sources, all equal: the email, the workspace, the plan.
            assert.equal(entry.request.purchase.licenses, n, `${email}: email vs workspace`);
            assert.equal(entry.request.purchase.licenses, plan.licenseQuantity, `${email}: email vs plan`);

            // The product decides the template (and its subject); the license count decides the route.
            assert.equal(message.subject, expected[email]!.subject, `${email}: template`);
            assert.equal(message.subject, emailSubjectFor(entry.request.purchase), `${email}: subject follows the purchase`);
            assert.match(message.text, expected[email]!.licenses, email);
            // The discontinuation notice reaches every recipient, in the text and the HTML, exactly once.
            assert.equal(message.text.split("Important: Discontinuation of the Previous HealthAge Software").length - 1, 1, `${email}: notice in the text`);
            assert.equal(message.html.split("Important: Discontinuation of the Previous HealthAge Software").length - 1, 1, `${email}: notice in the HTML`);
            assert.ok(message.text.includes("The old software will no longer be supported."), `${email}: notice wording`);
            assert.ok(message.html.includes(`href="${FULL_CONFIG.iosUrl}"`));
            assert.doesNotMatch(message.text + message.html, /sample date|HealthAge Test Customer|test\.customer@example\.com/i);

            if (n === 1) {
                // One license: straight to the app. No Admin Portal, workspace or member instructions.
                assert.doesNotMatch(message.text, /Admin Portal: |Open the HealthAge Admin Portal|My Workspaces|Invite a Member|Manage Organization Members/, `${email}: direct route`);
                assert.ok(message.text.includes(`(“${email}”)`), `${email}: told to use the purchase address`);
            } else {
                // More than one license: the owner manages the workspace.
                assert.ok(message.text.includes(`“1 of ${n} licenses used”`), email);
                assert.ok(message.text.includes(`Your workspace is named “${workspace.name}”`), email);
                assert.ok(message.text.includes(`always use “${email}”`), email);
                assert.match(message.text, /Open the HealthAge Admin Portal/);
                assert.match(message.text, /Invite a Member/, `${email}: member steps when there are licenses to give`);
            }
        }

        // No customer data leaks into another customer's message.
        for (const { entry, message } of messages) {
            for (const other of messages.filter((candidate) => candidate.entry.request.to !== entry.request.to)) {
                const otherEmail = other.entry.request.accountEmail;
                const otherWorkspace = other.entry.request.workspaceName;
                for (const body of [message.text, message.html]) {
                    assert.equal(body.includes(otherEmail), false, `${entry.request.to}'s message contains ${otherEmail}`);
                    if (otherWorkspace !== entry.request.workspaceName) assert.equal(body.includes(`“${otherWorkspace}”`), false, `${entry.request.to}'s message names ${otherWorkspace}`);
                }
            }
        }
    });

    it("a workspace holding a different number of licenses than the plan allocates is held back, never emailed with the wrong count", async () => {
        const db = createLedgerDb([row("ws-ann", "ann@example.com", { seat_limit: 3 })]); // CONTEXT's plan says 1
        const plan = planEmailRun(db.rows(), CONTEXT, null);
        assert.deepEqual(plan.skipped.map((entry) => entry.reason), ["license_mismatch"]);
        assert.match(plan.skipped[0]!.detail, /holds 3 license\(s\) but the plan allocates 1/);

        const log = createSenderLog();
        const live = await runStage({ args: ["--send", "--all"], db, log });
        assert.deepEqual(live.outcomes, []);
        assert.deepEqual(log.attempts, []);
        await assert.rejects(runStage({ args: ["--send", "--only-emails=ann@example.com"], db, log }), /license_mismatch/);
        assert.deepEqual(log.attempts, []);
    });

    it("re-checks the license count under the lock: seats changed after the plan was made, so nothing is sent", async () => {
        const planDb = createLedgerDb([row("ws-ann", "ann@example.com")]);
        const runDb = createLedgerDb([row("ws-ann", "ann@example.com", { seat_limit: 5 })]); // an admin raised the seats meanwhile
        const mode = resolveSendMode(parseSendEmailsArgs(["--send", "--all"]));
        const runPlan = planEmailRun(planDb.rows(), CONTEXT, mode.limit);
        assert.equal(runPlan.selected.length, 1);
        const log = createSenderLog();
        const outcomes = await runEmailStage({
            mode,
            selected: runPlan.selected,
            emailConfig: FULL_CONFIG,
            sender: createGuardedSender({ mode, liveRecipients: new Set(["ann@example.com"]), rawSender: log.raw }),
            ledger: runDb.runner,
            context: CONTEXT,
            now: () => NOW,
        });
        assert.deepEqual([outcomes[0]?.status, outcomes[0]?.reason], ["skipped", "license_mismatch"]);
        assert.deepEqual(log.attempts, []);
        assert.equal(runDb.ledgerWrites(), 0);
    });

    it("a customer the plan has no qualifying purchase for cannot be emailed, because the email could not say what they bought", () => {
        const withoutAnn = { ...CONTEXT, purchaseByEmail: new Map([...PURCHASES].filter(([email]) => email !== "ann@example.com")) };
        const plan = planEmailRun([row("ws-ann", "ann@example.com"), row("ws-bob", "bob@example.com")], withoutAnn, null);
        assert.deepEqual(plan.pending.map((candidate) => candidate.email), ["bob@example.com"]);
        assert.deepEqual(plan.skipped.map((entry) => [entry.workspace.owner_email, entry.reason]), [["ann@example.com", "no_qualifying_purchase"]]);
    });

    it("in a test send the email still describes the CUSTOMER (their address, workspace, licenses), never the tester", async () => {
        const db = createLedgerDb([row("ws-ann", "ann@example.com", { name: "Archer Clinic" })]);
        const log = createSenderLog();
        await runStage({ args: ["--test-recipients=qa@test.example"], db, log });
        const request = log.sent[0]!.request;
        assert.equal(request.to, "qa@test.example");
        assert.equal(request.accountEmail, "ann@example.com");
        assert.equal(request.workspaceName, "Archer Clinic");
        const message = buildFreeYearMessage(request, "from@test.invalid", log.sent[0]!.headers);
        assert.ok(message.text.includes("ann@example.com") && message.html.includes("ann@example.com"));
        assert.ok(!message.text.includes("qa@test.example") && !message.html.includes("qa@test.example"));
        assert.equal(db.ledgerWrites(), 0, "a test send still never touches the ledger");
    });

    it("the legacy stage 1 inline email carries the same personalisation (account, workspace, purchase)", async () => {
        const store = createStageOneStore([]);
        const customer = PILOT_PLAN.customers.find((candidate) => candidate.email === "pilot.large@example.com")!;
        const decision = {
            ...decideCustomer({ customer, runDate: PILOT_RUN_DATE, user: undefined, workspaces: [], dbChecked: true }),
            inThisRun: true,
        };
        const payloads: Array<Parameters<Parameters<typeof applyOneCustomer>[0]["sendEmail"]>[0]> = [];
        const result = await applyOneCustomer({
            runner: store.runner,
            notesWriter: { findWorkspacesByOwnerEmail: store.executor.findWorkspacesByOwnerEmail, updateWorkspaceNotes: async () => undefined },
            customer,
            decision,
            writeMode: { writesEnabled: true, emailsEnabled: true },
            emailConfig: FULL_CONFIG,
            sendEmail: async (payload) => {
                payloads.push(payload);
            },
            now: PILOT_RUN_DATE,
        });
        assert.equal(result.emailed, true);
        const payload = payloads[0]!;
        assert.equal(payload.accountEmail, "pilot.large@example.com");
        assert.equal(payload.workspaceName, "Pilot Large");
        assert.equal(payload.purchase.licenses, 4);
        assert.equal(payload.purchase.licenses, store.workspaces[0]!.seat_limit);
        const content = getLegacyFreeYearEmailContent(payload);
        assert.equal(content.subject, EMAIL_SUBJECTS.large_venue_kit, "the Stage 1 inline email uses the same template as Stage 2");
        assert.match(content.text, /Your Large Venue Kit includes 4 licenses:/);
    });
});

describe("the stage 2 CLI feeds the personalisation from real data", () => {
    const cli = readFileSync(resolve(process.cwd(), "scripts/migrations/legacy-shopify-customers/send-emails.ts"), "utf8");

    it("reads the license count and workspace name from the database, in the snapshot AND under the lock", () => {
        const snapshot = cli.slice(cli.indexOf("const MIGRATED_WORKSPACES_SQL"), cli.indexOf("/** Every stage 1 workspace"));
        assert.match(snapshot, /w\.name/);
        assert.match(snapshot, /w\.seat_limit/);
        const locked = cli.slice(cli.indexOf("async claimWorkspace"), cli.indexOf("async recordEmailSent"));
        assert.match(locked, /SELECT id, name, owner_email, status, subscription_status, expires_at, notes, billing_source, seat_limit/);
    });

    it("builds the purchase index from the same CSV plan as the names, and hands it to the classifier", () => {
        assert.match(cli, /purchaseByEmail: buildPurchaseIndex\(plan\.customers\)/);
        assert.match(cli, /const context = \{ nameByEmail, purchaseByEmail/);
    });
});

describe("sample mode shows each product's email (--sample-product)", () => {
    const modeOf = (...args: string[]) => resolveSendMode(parseSendEmailsArgs(args));
    const seatsPerUnit = (ruleId: string): number => {
        const rule = ELIGIBLE_PRODUCTS.find((candidate) => candidate.id === ruleId);
        assert.ok(rule && rule.licenseQuantity.type === "fixed_per_unit", `${ruleId} is a fixed-per-unit product`);
        return rule.licenseQuantity.seatsPerUnit;
    };

    it("defaults to the Large Venue Kit, and each choice shows that product with the migration's own license count", () => {
        assert.equal(modeOf("--sample", `--test-recipients=${SAMPLE_ONE}`).sampleProduct, "large");
        const expected = {
            existing: /Your New HealthAge Experience Is Ready![\s\S]*Registered Email: test\.customer@example\.com/,
            small: /Your Small Venue Kit includes one license for your personal use\./,
            large: /Your Large Venue Kit includes 4 licenses:/,
            dyha: /Your Discover Your Health Age purchase includes 3 licenses:/,
        };
        const subjects = { existing: EMAIL_SUBJECTS.existing_customer, small: EMAIL_SUBJECTS.small_venue_kit, large: EMAIL_SUBJECTS.large_venue_kit, dyha: EMAIL_SUBJECTS.existing_customer };
        for (const product of ["existing", "small", "large", "dyha"] as const) {
            const mode = modeOf("--sample", `--sample-product=${product}`, `--test-recipients=${SAMPLE_ONE}`);
            assert.equal(mode.sampleProduct, product);
            const content = renderSampleEmail(FULL_CONFIG, product);
            assert.match(content.text, expected[product]);
            assert.equal(content.subject, subjects[product], `${product}: the sample uses the real template for that product`);
            // Kit samples use the real per-unit license counts from the product rules; the DYHA samples are "- 1" and "- 3".
            const expectedLicenses = product === "dyha" ? 3 : product === "existing" ? 1 : seatsPerUnit(`health_expo_screening_kit_${product}`);
            assert.equal(buildSamplePurchase(product).licenses, expectedLicenses);
            assert.match(content.text, /sample date/);
            assert.ok(content.text.includes(SAMPLE_ACCOUNT_EMAIL));
            // The workspace is only part of the email when there are several licenses to manage (the workspace route).
            assert.equal(content.text.includes(SAMPLE_WORKSPACE_NAME), buildSamplePurchase(product).licenses > 1, `${product}: workspace shown only for more than one license`);
        }
    });

    it("rejects an unknown product, a repeated flag, and use without --sample", () => {
        assert.throws(() => modeOf("--sample", "--sample-product=huge", `--test-recipients=${SAMPLE_ONE}`), /Invalid --sample-product value "huge"/);
        assert.throws(() => modeOf("--sample", "--sample-product=small", "--sample-product=large", `--test-recipients=${SAMPLE_ONE}`), /more than once/);
        assert.throws(() => modeOf("--sample-product=small", `--test-recipients=${SAMPLE_ONE}`), /requires --sample/);
        assert.throws(() => modeOf("--send", "--all", "--sample-product=small"), /requires --sample/);
        // It changes nothing about safety: still preview by default, still no customers.
        const mode = modeOf("--sample", "--sample-product=dyha", `--test-recipients=${SAMPLE_ONE}`);
        assert.deepEqual([mode.target, mode.sends, mode.onlyEmails], ["sample", false, []]);
    });

    it("a delivered sample of the chosen product goes only to the listed address", async () => {
        for (const product of ["small", "dyha"] as const) {
            const mode = modeOf("--sample", "--send-sample", `--sample-product=${product}`, `--test-recipients=${SAMPLE_ONE}`);
            const log = createSenderLog();
            await runSampleStage({ mode, emailConfig: FULL_CONFIG, sender: createGuardedSender({ mode, liveRecipients: new Set(), rawSender: log.raw }) });
            assert.deepEqual(log.attempts, [SAMPLE_ONE]);
            assert.deepEqual(log.sent[0]!.request.purchase, buildSamplePurchase(product));
            assert.equal(log.sent[0]!.headers?.[TEST_MODE_HEADER], "sample");
        }
    });
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

describe("stage 2 isolation guarantees", () => {
    const dir = resolve(process.cwd(), "scripts/migrations/legacy-shopify-customers");
    const read = (file: string) => readFileSync(join(dir, file), "utf8");
    const importsOf = (file: string): string[] =>
        [...read(file).matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]!);
    const bare = (specifier: string) => specifier.replace(/\.ts$/, "");

    it("the stage 2 logic and the shared transport import no database driver and no mail library", () => {
        for (const file of ["send-emails-core.ts", "email-transport.ts"]) {
            for (const specifier of importsOf(file)) {
                assert.notEqual(specifier, "pg", `${file} must not import pg`);
                assert.notEqual(specifier, "nodemailer", `${file} must not import nodemailer`);
                assert.doesNotMatch(specifier, /(^|\/)src\//, `${file} must not import application code`);
            }
        }
    });

    it("no test file can reach a real database, mail server, or CLI entry point", () => {
        const forbidden = new Set(["./apply", "./send-emails", "./dry-run"]);
        for (const file of ["apply.test.ts", "send-emails.test.ts"]) {
            for (const specifier of importsOf(file)) {
                assert.notEqual(specifier, "pg", `${file} imports pg`);
                assert.notEqual(specifier, "nodemailer", `${file} imports nodemailer`);
                assert.equal(forbidden.has(bare(specifier)), false, `${file} imports the CLI ${specifier}`);
            }
        }
    });

    it("the only places that import nodemailer are the two CLIs", () => {
        const users = ["apply.ts", "dry-run.ts", "send-emails.ts", "apply-core.ts", "build-plan.ts", "email-transport.ts", "migration-email.ts", "orders-csv.ts", "product-eligibility.ts", "send-emails-core.ts"]
            .filter((file) => importsOf(file).includes("nodemailer"));
        assert.deepEqual(users.sort(), ["apply.ts", "send-emails.ts"]);
    });

    it("the CLI writes only the ledger: one UPDATE of notes, no INSERT or DELETE, and updated_at is left alone", () => {
        const code = read("send-emails.ts")
            .split(/\r?\n/)
            .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
            .join("\n");

        assert.equal((code.match(/\bUPDATE\b/g) ?? []).length, 1);
        assert.doesNotMatch(code, /\b(INSERT|DELETE|TRUNCATE|DROP|ALTER)\b/);

        const update = /UPDATE workspaces[\s\S]*?`/.exec(code)?.[0] ?? "";
        assert.match(update, /SET notes/);
        assert.doesNotMatch(update, /updated_at/);
        assert.match(update, /billing_source = \$3/);
    });

    it("the snapshot read is a read-only transaction", () => {
        assert.match(read("send-emails.ts"), /BEGIN TRANSACTION READ ONLY/);
    });

    it("does not touch the live Shopify webhook code", () => {
        for (const file of ["send-emails.ts", "send-emails-core.ts", "email-transport.ts"]) {
            for (const specifier of importsOf(file)) {
                assert.doesNotMatch(specifier, /shopify\.(service|route|admin|license)/, `${file} imports ${specifier}`);
            }
        }
    });
});
