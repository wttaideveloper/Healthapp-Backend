/**
 * Stage 2 of the legacy Shopify migration: send the approved free-year email to
 * customers whose workspaces stage 1 created, and record each success in the
 * existing email ledger (`free_year_email_sent_at:` in `workspaces.notes`).
 *
 * Pure and injectable: no database driver, no mail library, no clock except the
 * one passed in. The CLI (`send-emails.ts`) supplies pg and nodemailer; the tests
 * supply in-memory fakes, which is how "no real email during testing" is kept
 * structural rather than a matter of discipline.
 *
 * Safety model, outermost first:
 *   1. Nothing is sent unless the command says so. No flags = preview.
 *   2. Test mode redirects every message to an explicit allowlist and can never
 *      contact a customer or touch the ledger.
 *   3. Every outbound message passes one guard (`createGuardedSender`) that
 *      re-checks the recipient against what the mode allows.
 *   4. Live mode sends under a per-workspace lock, re-checks the ledger under the
 *      lock, and writes the ledger entry only after the SMTP server accepted the
 *      message. A failed send writes nothing, so it stays retryable.
 *   5. The first send that goes out but cannot be recorded (`sent_unrecorded`) ends
 *      the run: no further customer is attempted, and the run exits non-zero.
 *   6. `--only-emails` makes the listed addresses the whole scope: nobody else can be
 *      selected, locked or sent to, and an address that cannot be emailed refuses the
 *      entire run before anything leaves.
 */

import {
    buildFreeYearEmailSentMarker,
    emailConfigIssues,
    isWorkspaceAccessActiveAt,
    notesIndicateFreeYearEmailSent,
    parseEmailAllowlist,
    type EmailConfig,
} from "./apply-core";
import { formatGrantDisplayDate, isUsableEmail, normalizeEmail } from "./build-plan";
import type { FreeYearEmailRequest } from "./email-transport";
import { inferMigrationCustomerDisplayName } from "./migration-email";
import { GRANT_CONFIG } from "./product-eligibility";

/** Header added to test messages. The subject and body stay exactly as approved. */
export const TEST_MODE_HEADER = "X-HealthAge-Migration-Email-Mode";

/** A test run sends for one customer unless told otherwise. */
export const DEFAULT_TEST_LIMIT = 1;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export type SendEmailsArgs = {
    readonly csvPath: string;
    readonly outDir: string;
    readonly dryRun: boolean;
    readonly send: boolean;
    readonly all: boolean;
    readonly limit: number | null;
    /** Normalized (trimmed, lower-cased, de-duplicated) test allowlist. Empty = not a test run. */
    readonly testRecipients: readonly string[];
    /** Exact customer allowlist for a live pilot (normalized, de-duplicated). Empty = not supplied. */
    readonly onlyEmails: readonly string[];
    readonly allowMissingPlatformLinks: boolean;
};

const SUPPORTED_FLAGS =
    "--dry-run, --send, --all, --limit=N, --only-emails=a@x.com,b@y.com, --test-recipients=a@x.com,b@y.com, --allow-missing-platform-links, --csv=, --out=";

/**
 * Unrecognised arguments are rejected, never ignored. In particular the stage 1
 * flags (`--apply`, `--no-email`) are errors here, so the two commands cannot be
 * mixed up.
 */
export function parseSendEmailsArgs(argv: readonly string[]): SendEmailsArgs {
    let csvPath = "orders_export_1.csv";
    let outDir = "migration-reports";
    let dryRun = false;
    let send = false;
    let all = false;
    let limit: number | null = null;
    let testRecipients: string[] | null = null;
    let onlyEmails: string[] | null = null;
    let allowMissingPlatformLinks = false;

    for (const argument of argv) {
        // pnpm forwards a literal "--" separator to the script; it carries no meaning.
        if (argument === "--") continue;
        if (argument === "--dry-run") dryRun = true;
        else if (argument === "--send") send = true;
        else if (argument === "--all") all = true;
        else if (argument === "--allow-missing-platform-links") allowMissingPlatformLinks = true;
        else if (argument.startsWith("--csv=")) csvPath = argument.slice("--csv=".length);
        else if (argument.startsWith("--out=")) outDir = argument.slice("--out=".length);
        else if (argument.startsWith("--limit=")) {
            const parsed = Number(argument.slice("--limit=".length));
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error(`Invalid --limit value: ${argument}`);
            }
            limit = parsed;
        } else if (argument.startsWith("--test-recipients=")) {
            if (testRecipients !== null) throw new Error("--test-recipients was given more than once");
            testRecipients = parseTestRecipients(argument.slice("--test-recipients=".length));
        } else if (argument.startsWith("--only-emails=")) {
            if (onlyEmails !== null) throw new Error("--only-emails was given more than once");
            onlyEmails = parseEmailAllowlist("--only-emails", argument.slice("--only-emails=".length));
        } else {
            throw new Error(`Unknown argument: ${argument}. Supported: ${SUPPORTED_FLAGS}`);
        }
    }

    return {
        csvPath,
        outDir,
        dryRun,
        send,
        all,
        limit,
        testRecipients: testRecipients ?? [],
        onlyEmails: onlyEmails ?? [],
        allowMissingPlatformLinks,
    };
}

function parseTestRecipients(value: string): string[] {
    const addresses = value
        .split(",")
        .map((entry) => normalizeEmail(entry))
        .filter((entry) => entry.length > 0);

    if (addresses.length === 0) {
        throw new Error("--test-recipients needs at least one address, e.g. --test-recipients=you@example.com");
    }
    for (const address of addresses) {
        if (!isUsableEmail(address)) throw new Error(`--test-recipients contains an invalid address: ${address}`);
    }
    return [...new Set(addresses)];
}

export type SendMode = {
    /** Who a message goes to: the customers ("live") or only the allowlist ("test"). */
    readonly target: "live" | "test";
    /** False = preview: nothing leaves the process and nothing is written. */
    readonly sends: boolean;
    readonly testRecipients: readonly string[];
    /**
     * Exact customer allowlist (live only). When non-empty it IS the scope: only these
     * addresses can be selected and only these can be sent to.
     */
    readonly onlyEmails: readonly string[];
    /** Customers processed this run. Null for `--all` and for an `--only-emails` run (the list is the scope). */
    readonly limit: number | null;
    readonly allowMissingPlatformLinks: boolean;
};

/**
 * Turns flags into a mode, rejecting every combination that is ambiguous or
 * unsafe. Nothing sends unless `--send` (live) or `--test-recipients` (test) was
 * given and `--dry-run` was not.
 */
export function resolveSendMode(args: SendEmailsArgs): SendMode {
    const isTest = args.testRecipients.length > 0;
    const isTargeted = args.onlyEmails.length > 0;

    if (isTargeted && isTest) {
        throw new Error(
            "--only-emails and --test-recipients cannot be combined: test mode never contacts customers, while --only-emails exists to contact exactly the listed customers."
        );
    }
    if (isTargeted && args.all) {
        throw new Error("--all is not allowed with --only-emails: the listed addresses are the scope.");
    }
    if (isTargeted && args.limit !== null) {
        throw new Error("--limit is not allowed with --only-emails: the listed addresses are the scope.");
    }

    if (isTest && args.send) {
        throw new Error(
            "--send and --test-recipients cannot be combined: test mode only ever emails the allowlist and never contacts customers."
        );
    }
    if (args.all && args.limit !== null) {
        throw new Error("--all and --limit cannot be combined.");
    }

    if (isTest) {
        if (args.all) {
            throw new Error("--all is not allowed with --test-recipients; use --limit=N for a larger test.");
        }
        return {
            target: "test",
            sends: !args.dryRun,
            testRecipients: args.testRecipients,
            onlyEmails: [],
            limit: args.limit ?? DEFAULT_TEST_LIMIT,
            allowMissingPlatformLinks: args.allowMissingPlatformLinks,
        };
    }

    // --only-emails without --send is a PREVIEW of exactly that list (nothing is sent); sending to a
    // list needs --send as well. The list is itself the explicit scope that --send otherwise demands.
    const sends = args.send && !args.dryRun;
    if (sends && args.limit === null && !args.all && !isTargeted) {
        throw new Error(
            "A live send needs an explicit scope: pass --limit=N for a controlled batch, --all for everyone pending, or --only-emails=a@x.com,b@y.com for exact customers."
        );
    }

    return {
        target: "live",
        sends,
        testRecipients: [],
        onlyEmails: args.onlyEmails,
        limit: args.all ? null : args.limit,
        allowMissingPlatformLinks: args.allowMissingPlatformLinks,
    };
}

/**
 * Reasons a live send must not start. A preview or test run reports these but is
 * not blocked by them: the point of a test is to see what the email would contain.
 *
 * iOS and macOS links are required for a live send because the email omits an
 * unset platform silently; sending before those links are approved is exactly
 * what the two-stage process exists to prevent.
 */
export function liveSendBlockers(config: EmailConfig, mode: Pick<SendMode, "allowMissingPlatformLinks">): string[] {
    const blockers = [...emailConfigIssues(config)];
    if (!mode.allowMissingPlatformLinks) {
        if (!config.iosUrl) blockers.push("HEALTHAGE_IOS_URL is not set");
        if (!config.macosUrl) blockers.push("HEALTHAGE_MACOS_URL is not set");
    }
    return blockers;
}

// ---------------------------------------------------------------------------
// Who is eligible
// ---------------------------------------------------------------------------

/** A stage 1 workspace plus the owner facts needed to decide whether to email. */
export type MigratedWorkspaceRow = {
    readonly id: string;
    readonly name: string;
    readonly owner_email: string;
    readonly status: string;
    readonly subscription_status: string;
    readonly expires_at: Date | null;
    readonly notes: string | null;
    readonly billing_source: string;
    /** Status of the owner's membership row; null when no owner membership exists. */
    readonly owner_member_status: string | null;
    /** Status of the owner's user account; null when they have not registered yet. */
    readonly user_status: string | null;
};

export const SKIP_REASONS = [
    "not_migration_workspace",
    "already_emailed",
    "invalid_owner_email",
    "workspace_not_active",
    "no_expiry_on_record",
    "owner_membership_inactive",
    "account_disabled",
    "not_in_csv_plan",
    "workspace_missing",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export type EmailCandidate = {
    readonly workspace: MigratedWorkspaceRow;
    /** Normalized owner email: the customer. */
    readonly email: string;
    /** Greeting name, inferred from the customer's own address when the CSV has no name. */
    readonly displayName: string;
    /** First day of the grant: the expiry minus the grant length. */
    readonly startDate: string;
    readonly expiryDate: string;
};

export type Classification =
    | { readonly kind: "pending"; readonly candidate: EmailCandidate }
    | { readonly kind: "skip"; readonly workspace: MigratedWorkspaceRow; readonly reason: SkipReason; readonly detail: string };

export type ClassifyContext = {
    /** Billing name per normalized email, from the same CSV plan stage 1 used. */
    readonly nameByEmail: ReadonlyMap<string, string>;
    readonly now: Date;
};

/**
 * Decides whether one migrated workspace is owed the email. A workspace is owed
 * it only if it is a stage 1 workspace, the ledger has no entry for it, it still
 * grants access, its owner can still be reached, and the CSV plan can say who
 * the customer is (the greeting name is not stored in the database).
 */
export function classifyWorkspace(workspace: MigratedWorkspaceRow, context: ClassifyContext): Classification {
    const skip = (reason: SkipReason, detail: string): Classification => ({ kind: "skip", workspace, reason, detail });

    if (workspace.billing_source !== GRANT_CONFIG.workspaceBillingSource) {
        return skip("not_migration_workspace", `billing_source is "${workspace.billing_source}"`);
    }
    if (notesIndicateFreeYearEmailSent(workspace.notes)) {
        return skip("already_emailed", "the email ledger already has an entry");
    }

    const email = normalizeEmail(workspace.owner_email);
    if (!isUsableEmail(email)) {
        return skip("invalid_owner_email", `owner_email "${workspace.owner_email}" is not a usable address`);
    }
    if (!isWorkspaceAccessActiveAt(workspace, context.now.getTime())) {
        return skip(
            "workspace_not_active",
            `status "${workspace.status}", subscription "${workspace.subscription_status}", expires ${workspace.expires_at?.toISOString() ?? "never"}`
        );
    }
    if (workspace.expires_at === null) {
        return skip("no_expiry_on_record", "the email states an expiry date and this workspace has none");
    }
    if (workspace.owner_member_status !== "invited" && workspace.owner_member_status !== "active") {
        return skip("owner_membership_inactive", `owner membership is ${workspace.owner_member_status ?? "missing"}`);
    }
    if (workspace.user_status === "disabled") {
        return skip("account_disabled", "the owner's account is deactivated");
    }
    if (!context.nameByEmail.has(email)) {
        return skip("not_in_csv_plan", "the owner is not in the CSV plan, so the greeting name is unknown (wrong CSV?)");
    }

    const start = new Date(workspace.expires_at.getTime());
    start.setUTCDate(start.getUTCDate() - GRANT_CONFIG.accessDurationDays);

    return {
        kind: "pending",
        candidate: {
            workspace,
            email,
            displayName: inferMigrationCustomerDisplayName(email, context.nameByEmail.get(email)),
            startDate: formatGrantDisplayDate(start),
            expiryDate: formatGrantDisplayDate(workspace.expires_at),
        },
    };
}

/** What a targeted (`--only-emails`) run will do with one requested address. */
export type EmailTargetState =
    /** Owed the email and unambiguous: will be sent. */
    | "selected"
    /** The ledger already has it: nothing to send, which makes a re-run safe. */
    | "already_emailed"
    /** Cannot be emailed (no workspace, inactive, duplicate workspaces, ...). A live run is refused. */
    | "unresolved";

export type EmailTargetEntry = { readonly email: string; readonly state: EmailTargetState; readonly detail: string };

export type EmailTargeting = {
    readonly requested: readonly string[];
    readonly entries: readonly EmailTargetEntry[];
    readonly selected: readonly EmailTargetEntry[];
    readonly alreadyEmailed: readonly EmailTargetEntry[];
    readonly unresolved: readonly EmailTargetEntry[];
};

export type EmailRunPlan = {
    /** Everyone currently owed the email, in send order. */
    readonly pending: readonly EmailCandidate[];
    /** The part of `pending` this run handles. */
    readonly selected: readonly EmailCandidate[];
    readonly skipped: readonly Extract<Classification, { kind: "skip" }>[];
    /** Per-address outcome of an `--only-emails` run; null when no allowlist was given. */
    readonly targeting: EmailTargeting | null;
};

/**
 * Pending customers are ordered by email, so `--limit=N` is deterministic and
 * repeated limited runs walk through the list: a customer who was sent drops out
 * of `pending` because the ledger now has their entry.
 *
 * With `onlyEmails` the selection is EXACTLY the requested addresses that are owed the
 * email, matched on the normalized address. `pending` still lists everyone owed it, so
 * the preview can say how many customers a targeted run is deliberately leaving alone.
 */
export function planEmailRun(
    rows: readonly MigratedWorkspaceRow[],
    context: ClassifyContext,
    limit: number | null,
    onlyEmails: readonly string[] = []
): EmailRunPlan {
    const classified = rows.map((row) => classifyWorkspace(row, context));
    const pending = classified
        .flatMap((entry) => (entry.kind === "pending" ? [entry.candidate] : []))
        .sort((left, right) => left.email.localeCompare(right.email) || left.workspace.id.localeCompare(right.workspace.id));
    const skipped = classified.flatMap((entry) => (entry.kind === "skip" ? [entry] : []));

    if (onlyEmails.length === 0) {
        return { pending, selected: limit === null ? pending : pending.slice(0, limit), skipped, targeting: null };
    }
    if (limit !== null) {
        throw new Error("planEmailRun: an --only-emails run cannot also have a limit; the listed addresses are the scope.");
    }

    const targeting = buildEmailTargeting(classified, pending, onlyEmails);
    const chosen = new Set(targeting.selected.map((entry) => entry.email));
    return { pending, selected: pending.filter((candidate) => chosen.has(candidate.email)), skipped, targeting };
}

function buildEmailTargeting(
    classified: readonly Classification[],
    pending: readonly EmailCandidate[],
    onlyEmails: readonly string[]
): EmailTargeting {
    const requested = [...new Set(onlyEmails.map(normalizeEmail))];

    const entries = requested.map((email): EmailTargetEntry => {
        const owed = pending.filter((candidate) => candidate.email === email);
        const skips = classified.flatMap((entry) =>
            entry.kind === "skip" && normalizeEmail(entry.workspace.owner_email) === email ? [entry] : []
        );
        const alreadyEmailed = skips.filter((entry) => entry.reason === "already_emailed");

        // More than one workspace could be emailed for one address: sending would reach the customer twice.
        if (owed.length > 1 || (owed.length === 1 && alreadyEmailed.length > 0)) {
            return {
                email,
                state: "unresolved",
                detail: `${owed.length + alreadyEmailed.length} migration workspaces share this address and at least one is owed the email; resolve the duplicate first, or the customer would be emailed twice`,
            };
        }
        if (owed.length === 1) return { email, state: "selected", detail: "owed the email: will be sent" };

        if (skips.length === 0) {
            return { email, state: "unresolved", detail: "no migration workspace for this address (run stage 1 for it first, or check the spelling)" };
        }
        const blocking = skips.find((entry) => entry.reason !== "already_emailed");
        if (!blocking) return { email, state: "already_emailed", detail: "the email ledger already has an entry; nothing to send" };
        return { email, state: "unresolved", detail: `${blocking.reason}: ${blocking.detail}` };
    });

    return {
        requested,
        entries,
        selected: entries.filter((entry) => entry.state === "selected"),
        alreadyEmailed: entries.filter((entry) => entry.state === "already_emailed"),
        unresolved: entries.filter((entry) => entry.state === "unresolved"),
    };
}

/**
 * A live targeted run must be able to email, or find already emailed, EVERY address it
 * was given. One typo or one ineligible customer refuses the whole run before anything is
 * sent, so a pilot never half-happens and a mistyped address is never quietly dropped.
 */
export function assertTargetingActionable(targeting: EmailTargeting | null): void {
    if (!targeting || targeting.unresolved.length === 0) return;
    throw new Error(
        `--only-emails names ${targeting.unresolved.length} address(es) that cannot be emailed, so NOTHING was sent:\n` +
            targeting.unresolved.map((entry) => `  ${entry.email}  ${entry.detail}`).join("\n")
    );
}

/**
 * A test address that belongs to a real customer would deliver a "test" message
 * to that customer, so it is refused. `customerEmails` should be every migrated
 * owner plus every customer in the CSV plan.
 */
export function assertTestRecipientsAreNotCustomers(testRecipients: readonly string[], customerEmails: Iterable<string>): void {
    const customers = new Set([...customerEmails].map(normalizeEmail));
    const offenders = testRecipients.filter((address) => customers.has(normalizeEmail(address)));
    if (offenders.length > 0) {
        throw new Error(
            `Refusing to run: ${offenders.join(", ")} ${offenders.length === 1 ? "is a" : "are"} real customer address(es). Test recipients must be addresses that are not migration customers.`
        );
    }
}

// ---------------------------------------------------------------------------
// The one gate every outbound message passes through
// ---------------------------------------------------------------------------

export type EmailSender = (
    request: FreeYearEmailRequest,
    options?: { readonly headers?: Readonly<Record<string, string>> }
) => Promise<void>;

/**
 * Wraps the raw sender so the mode's promise holds even if the code above it is
 * wrong:
 *   - preview: refuses everything
 *   - test:    refuses any address not on the allowlist, and marks the message
 *   - live:    refuses any address that is not one of this run's selected customers
 */
export function createGuardedSender(input: {
    mode: SendMode;
    /** Normalized emails of the customers this run is allowed to contact (live mode only). */
    liveRecipients: ReadonlySet<string>;
    rawSender: EmailSender;
}): EmailSender {
    const testAllowlist = new Set(input.mode.testRecipients.map(normalizeEmail));
    const onlyAllowlist = new Set(input.mode.onlyEmails.map(normalizeEmail));

    return async (request, options) => {
        const to = normalizeEmail(request.to);

        if (!input.mode.sends) {
            throw new Error("Refusing to send: this run is a preview.");
        }
        if (input.mode.target === "test") {
            if (!testAllowlist.has(to)) {
                throw new Error(`Refusing to send to ${to}: not on the test recipient allowlist.`);
            }
            return input.rawSender(request, { headers: { ...options?.headers, [TEST_MODE_HEADER]: "test" } });
        }
        if (input.mode.onlyEmails.length > 0 && !onlyAllowlist.has(to)) {
            throw new Error(`Refusing to send to ${to}: not on the --only-emails allowlist.`);
        }
        if (!input.liveRecipients.has(to)) {
            throw new Error(`Refusing to send to ${to}: not a selected pending migration customer.`);
        }
        return input.rawSender(request, options);
    };
}

// ---------------------------------------------------------------------------
// Running the stage
// ---------------------------------------------------------------------------

/** What a ledger transaction can do. The pg implementation holds a per-workspace lock for its lifetime. */
export type LedgerTransaction = {
    /**
     * Takes the per-workspace lock (blocking any other stage 2 run on the same
     * workspace) and returns the workspace's CURRENT columns, or null if it is gone.
     */
    claimWorkspace(workspaceId: string): Promise<LockedWorkspaceRow | null>;
    /** Appends the ledger line to `workspaces.notes`. Must not touch `updated_at`. */
    recordEmailSent(workspaceId: string, markerLine: string): Promise<void>;
};

export type LockedWorkspaceRow = Pick<
    MigratedWorkspaceRow,
    "id" | "owner_email" | "status" | "subscription_status" | "expires_at" | "notes" | "billing_source"
>;

export type LedgerRunner = {
    runInTransaction<T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
};

export const EMAIL_OUTCOME_STATUSES = [
    "previewed",
    "test_sent",
    "sent",
    "failed",
    "skipped",
    "sent_unrecorded",
] as const;

export type EmailOutcomeStatus = (typeof EMAIL_OUTCOME_STATUSES)[number];

export type EmailOutcome = {
    readonly workspaceId: string;
    /** The customer. */
    readonly ownerEmail: string;
    /** Where the message actually went (or would go): the customer, or the test addresses. */
    readonly deliveredTo: readonly string[];
    readonly status: EmailOutcomeStatus;
    readonly reason: string | null;
    readonly error: string | null;
    /** For `sent_unrecorded`: the line to add to `workspaces.notes` by hand before any re-run. */
    readonly ledgerLine: string | null;
};

function requestFor(candidate: EmailCandidate, to: string, config: EmailConfig): FreeYearEmailRequest {
    return {
        to,
        customerName: candidate.displayName,
        startDate: candidate.startDate,
        expiryDate: candidate.expiryDate,
        androidUrl: config.androidUrl,
        windowsUrl: config.windowsUrl,
        iosUrl: config.iosUrl,
        macosUrl: config.macosUrl,
        supportEmail: config.supportEmail!,
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function runEmailStage(input: {
    mode: SendMode;
    selected: readonly EmailCandidate[];
    emailConfig: EmailConfig;
    /** Must be the guarded sender (`createGuardedSender`). */
    sender: EmailSender;
    /** Required for a live send; never used by preview or test runs. */
    ledger: LedgerRunner | null;
    context: ClassifyContext;
    now?: () => Date;
}): Promise<EmailOutcome[]> {
    const { mode } = input;
    const now = input.now ?? (() => new Date());

    // An exact-recipient run must never be handed anyone else. Checked before anything is
    // sent or locked, so a mis-wired caller fails closed.
    if (mode.onlyEmails.length > 0) {
        const allowed = new Set(mode.onlyEmails.map(normalizeEmail));
        const stray = input.selected.filter((candidate) => !allowed.has(candidate.email));
        if (stray.length > 0) {
            throw new Error(
                `Refusing to run: ${stray.length} selected customer(s) are not on the --only-emails allowlist (${stray.map((candidate) => candidate.email).join(", ")}).`
            );
        }
    }

    if (mode.sends) {
        const issues = emailConfigIssues(input.emailConfig);
        if (issues.length > 0) throw new Error(`Email configuration is incomplete: ${issues.join("; ")}`);
    }
    if (mode.sends && mode.target === "live" && input.ledger === null) {
        throw new Error("A live send needs the email ledger; refusing to send without one.");
    }

    const outcomes: EmailOutcome[] = [];

    for (const candidate of input.selected) {
        const base = { workspaceId: candidate.workspace.id, ownerEmail: candidate.email };

        if (!mode.sends) {
            outcomes.push({
                ...base,
                deliveredTo: mode.target === "test" ? mode.testRecipients : [candidate.email],
                status: "previewed",
                reason: null,
                error: null,
                ledgerLine: null,
            });
            continue;
        }

        if (mode.target === "test") {
            // Test mode: the customer is never a recipient and the ledger is never touched.
            const failures: string[] = [];
            for (const address of mode.testRecipients) {
                try {
                    await input.sender(requestFor(candidate, address, input.emailConfig));
                } catch (error) {
                    failures.push(`${address}: ${messageOf(error)}`);
                }
            }
            outcomes.push({
                ...base,
                deliveredTo: mode.testRecipients,
                status: failures.length === 0 ? "test_sent" : "failed",
                reason: null,
                error: failures.length === 0 ? null : failures.join("; "),
                ledgerLine: null,
            });
            continue;
        }

        const outcome = await sendLive({ ...input, candidate, now });
        outcomes.push(outcome);

        // A message is out and the ledger does not know. Whatever broke the ledger write may
        // break the next one too, and every further send would then be a duplicate waiting to
        // happen on the re-run. So this is the last customer of the run: the ones not yet
        // attempted are left untouched and stay pending.
        if (outcome.status === "sent_unrecorded") break;
    }

    return outcomes;
}

async function sendLive(input: {
    candidate: EmailCandidate;
    emailConfig: EmailConfig;
    sender: EmailSender;
    ledger: LedgerRunner | null;
    context: ClassifyContext;
    now: () => Date;
}): Promise<EmailOutcome> {
    const { candidate } = input;
    const base = { workspaceId: candidate.workspace.id, ownerEmail: candidate.email, deliveredTo: [candidate.email] };
    let delivered = false;
    let ledgerLine: string | null = null;

    try {
        return await input.ledger!.runInTransaction(async (tx): Promise<EmailOutcome> => {
            // Under the lock, look again: another run may have sent while this one waited.
            const locked = await tx.claimWorkspace(candidate.workspace.id);
            if (!locked) {
                return { ...base, status: "skipped", reason: "workspace_missing", error: null, ledgerLine: null };
            }
            const recheck = classifyWorkspace({ ...candidate.workspace, ...locked }, input.context);
            if (recheck.kind === "skip") {
                return { ...base, status: "skipped", reason: recheck.reason, error: null, ledgerLine: null };
            }

            try {
                await input.sender(requestFor(recheck.candidate, recheck.candidate.email, input.emailConfig));
            } catch (error) {
                // Nothing recorded: the next run picks this customer up again.
                return { ...base, status: "failed", reason: null, error: messageOf(error), ledgerLine: null };
            }
            delivered = true;

            ledgerLine = buildFreeYearEmailSentMarker(input.now());
            await tx.recordEmailSent(candidate.workspace.id, ledgerLine);
            return { ...base, status: "sent", reason: null, error: null, ledgerLine: null };
        });
    } catch (error) {
        if (delivered) {
            // The message is out but the ledger write failed or its commit is unconfirmed.
            // Re-running could email this customer twice, so it is surfaced, not retried.
            return {
                ...base,
                status: "sent_unrecorded",
                reason: null,
                error: messageOf(error),
                ledgerLine,
            };
        }
        return { ...base, status: "failed", reason: null, error: messageOf(error), ledgerLine: null };
    }
}

export function summarizeOutcomes(outcomes: readonly EmailOutcome[]): Record<EmailOutcomeStatus, number> {
    const counts = Object.fromEntries(EMAIL_OUTCOME_STATUSES.map((status) => [status, 0])) as Record<EmailOutcomeStatus, number>;
    for (const outcome of outcomes) counts[outcome.status] += 1;
    return counts;
}

/**
 * The process exit code for a finished run: non-zero when any send failed or went
 * out without being recorded, so a script or an operator cannot mistake a run that
 * needs attention for a clean one.
 */
export function emailRunExitCode(outcomes: readonly EmailOutcome[]): 0 | 1 {
    const counts = summarizeOutcomes(outcomes);
    return counts.failed > 0 || counts.sent_unrecorded > 0 ? 1 : 0;
}

/**
 * How many selected customers have no outcome at all, i.e. were never attempted.
 * Non-zero only when the run stopped early (see `runEmailStage`); those customers
 * are untouched and still pending.
 */
export function countNotAttempted(selected: readonly EmailCandidate[], outcomes: readonly EmailOutcome[]): number {
    const handled = new Set(outcomes.map((outcome) => outcome.workspaceId));
    return selected.filter((candidate) => !handled.has(candidate.workspace.id)).length;
}
