/**
 * Pure apply-phase decisions for the legacy Shopify customer migration.
 *
 * No database, no SMTP, no clock beyond values passed in. The CLI and the tests
 * share this module so a dry-run report is the same plan the writer would execute.
 */

import { isSafeHttpUrl, type PurchaseSummary } from "./migration-email";
import { buildPurchaseSummary } from "./purchase-summary";
import { APPLY_SCOPE, GRANT_CONFIG } from "./product-eligibility";
import {
    formatGrantDisplayDate,
    isUsableEmail,
    normalizeEmail,
    resolveGrantExpiry,
    type CustomerStatus,
    type PlannedCustomer,
} from "./build-plan";

export const APPLY_ACTIONS = [
    "CREATE",
    "SKIP_EXISTING",
    "SKIP_MISSING_EMAIL",
    "SKIP_REFUNDED",
    "SKIP_MANUAL_REVIEW",
] as const;

export type ApplyAction = (typeof APPLY_ACTIONS)[number];

export type ExistingWorkspace = {
    readonly id: string;
    readonly name: string;
    readonly owner_email: string;
    readonly status: string;
    readonly subscription_status: string;
    readonly plan: string;
    readonly seat_limit: number;
    readonly expires_at: Date | null;
    readonly billing_source: string;
    readonly notes: string | null;
};

export type ExistingUser = { readonly id: string; readonly email: string; readonly name: string };

export type ApplyWriteMode = {
    readonly writesEnabled: boolean;
    /** Never true unless writes are enabled: dry-run and `--no-email` both force it off. */
    readonly emailsEnabled: boolean;
};

export type ApplyDecision = {
    readonly customer: PlannedCustomer;
    readonly action: ApplyAction;
    readonly hasUser: boolean;
    readonly hasActiveWorkspace: boolean;
    readonly hasLegacyMigrationWorkspace: boolean;
    readonly existingWorkspaceIds: readonly string[];
    readonly inThisRun: boolean;
    readonly reviewNotes: readonly string[];
    readonly startDate: string;
    readonly expiryDate: string;
    readonly expiresAt: Date;
};

export type EmailConfig = {
    readonly androidUrl: string | null;
    readonly windowsUrl: string | null;
    readonly iosUrl: string | null;
    readonly macosUrl: string | null;
    readonly supportEmail: string | null;
};

/** Published Google Play listing. Used when HEALTHAGE_ANDROID_URL is unset. */
export const DEFAULT_HEALTHAGE_ANDROID_URL =
    "https://play.google.com/store/apps/details?id=com.wtt.healthAge";

/** Published Microsoft Store listing. Used when HEALTHAGE_WINDOWS_URL is unset. */
export const DEFAULT_HEALTHAGE_WINDOWS_URL = "https://apps.microsoft.com/detail/9P8MFP2CBVL5";

/** Published App Store listing. Used when HEALTHAGE_IOS_URL is unset. */
export const DEFAULT_HEALTHAGE_IOS_URL = "https://apps.apple.com/in/app/health-age/id6744716742";

/** HealthAge macOS download page. Used when HEALTHAGE_MACOS_URL is unset. */
export const DEFAULT_HEALTHAGE_MACOS_URL = "https://healthage.healthexporesources.com/download/";

/** Canonical customer support address. Not EMAIL_FROM. */
export const DEFAULT_HEALTHAGE_SUPPORT_EMAIL = "support@healthexporesources.com";

/**
 * Writes need `--apply` and no `--dry-run`. Emails additionally need the absence
 * of `--no-email`, so a run can create the workspaces now and leave the free-year
 * email until the store links are approved.
 */
export function resolveWriteMode(input: {
    apply: boolean;
    dryRun: boolean;
    noEmail?: boolean;
    onlyEmails?: readonly string[];
}): ApplyWriteMode {
    const writesEnabled = input.apply === true && input.dryRun !== true;
    // A targeted run must not email from stage 1: stage 2 owns sending (advisory lock, ledger,
    // its own recipient allowlist), and a pilot is exactly where that must not be bypassed.
    if (writesEnabled && (input.onlyEmails?.length ?? 0) > 0 && input.noEmail !== true) {
        throw new Error(
            "--only-emails with --apply requires --no-email: the pilot email is sent by stage 2 (send-emails.ts), which has the advisory lock, the email ledger and its own recipient allowlist."
        );
    }
    return {
        writesEnabled,
        emailsEnabled: writesEnabled && input.noEmail !== true,
    };
}

/**
 * Unrecognised arguments are rejected rather than ignored. Safety now hangs on
 * flags like `--no-email`; a typo (`--no-emial`) that was silently dropped would
 * send real mail.
 */
export function parseApplyArgs(argv: readonly string[]): {
    csvPath: string;
    outDir: string;
    skipDb: boolean;
    apply: boolean;
    dryRun: boolean;
    noEmail: boolean;
    limit: number | null;
    /** Exact recipient allowlist (normalized, de-duplicated). Empty = not supplied = no targeting. */
    onlyEmails: string[];
} {
    const args = {
        csvPath: "orders_export_1.csv",
        outDir: "migration-reports",
        skipDb: false,
        apply: false,
        dryRun: false,
        noEmail: false,
        limit: null as number | null,
    };
    let onlyEmails: string[] | null = null;

    for (const argument of argv) {
        // pnpm forwards a literal "--" separator to the script; it carries no meaning.
        if (argument === "--") continue;
        if (argument === "--skip-db") args.skipDb = true;
        else if (argument === "--apply") args.apply = true;
        else if (argument === "--dry-run") args.dryRun = true;
        else if (argument === "--no-email") args.noEmail = true;
        else if (argument.startsWith("--csv=")) args.csvPath = argument.slice("--csv=".length);
        else if (argument.startsWith("--out=")) args.outDir = argument.slice("--out=".length);
        else if (argument.startsWith("--limit=")) {
            const parsed = Number(argument.slice("--limit=".length));
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error(`Invalid --limit value: ${argument}`);
            }
            args.limit = parsed;
        } else if (argument.startsWith("--only-emails=")) {
            if (onlyEmails !== null) throw new Error("--only-emails was given more than once");
            onlyEmails = parseEmailAllowlist("--only-emails", argument.slice("--only-emails=".length));
        } else {
            throw new Error(
                `Unknown argument: ${argument}. Supported: --apply, --dry-run, --no-email, --skip-db, --csv=, --out=, --limit=, --only-emails=a@x.com,b@y.com`
            );
        }
    }

    if (onlyEmails !== null && args.limit !== null) {
        throw new Error("--only-emails and --limit cannot be combined: the listed addresses ARE the scope.");
    }

    return { ...args, onlyEmails: onlyEmails ?? [] };
}

/**
 * Parses an exact-recipient allowlist such as `--only-emails=a@x.com,B@y.com`.
 *
 * Addresses are trimmed, lower-cased and de-duplicated; nothing else is folded (no
 * plus-alias or dot handling, no wildcards, no domain matching). Anything unusable is
 * an ERROR, never a shrug: an allowlist that silently became empty or smaller must not
 * widen into "everyone". A forgotten comma ("a@x.com b@y.com") is rejected for the same
 * reason.
 */
export function parseEmailAllowlist(flag: string, value: string): string[] {
    const addresses = value
        .split(",")
        .map((entry) => normalizeEmail(entry))
        .filter((entry) => entry.length > 0);

    if (addresses.length === 0) {
        throw new Error(`${flag} needs at least one address, e.g. ${flag}=customer@example.com`);
    }
    for (const address of addresses) {
        if (!isUsableEmail(address)) throw new Error(`${flag} contains an invalid address: ${address}`);
    }
    return [...new Set(addresses)];
}

type AccessShape = Pick<ExistingWorkspace, "status" | "subscription_status" | "expires_at">;

/** `isWorkspaceAccessActive` against an explicit clock, so callers and tests are not tied to "now". */
export function isWorkspaceAccessActiveAt(workspace: AccessShape, nowMs: number): boolean {
    if (workspace.status !== "active") return false;
    if (!["active", "trialing"].includes(workspace.subscription_status)) return false;
    if (!workspace.expires_at) return true;
    return workspace.expires_at.getTime() > nowMs;
}

// Single-argument on purpose: it is passed straight to Array#filter, which would hand
// an optional second parameter the element index.
export function isWorkspaceAccessActive(workspace: AccessShape): boolean {
    return isWorkspaceAccessActiveAt(workspace, Date.now());
}

export function isLegacyMigrationWorkspace(workspace: Pick<ExistingWorkspace, "billing_source">): boolean {
    return workspace.billing_source === GRANT_CONFIG.workspaceBillingSource;
}

export function notesIndicateFreeYearEmailSent(notes: string | null | undefined): boolean {
    return (notes ?? "").includes(APPLY_SCOPE.emailSentMarker);
}

/** The single line the email ledger stores in `workspaces.notes`. One format for both stages. */
export function buildFreeYearEmailSentMarker(sentAt: Date): string {
    return `${APPLY_SCOPE.emailSentMarker} ${sentAt.toISOString()}`;
}

export function appendFreeYearEmailSentMarker(notes: string, sentAt: Date): string {
    const marker = buildFreeYearEmailSentMarker(sentAt);
    if (notesIndicateFreeYearEmailSent(notes)) return notes;
    return notes.trim().length > 0 ? `${notes.trim()}\n${marker}` : marker;
}

export function mapPlanStatusToAction(status: CustomerStatus | string): ApplyAction {
    if (status === "ready_create_workspace") return "CREATE";
    if (status === "skip_existing_active_workspace") return "SKIP_EXISTING";
    if (status === "blocked_missing_email") return "SKIP_MISSING_EMAIL";
    if (status === "skip_no_qualifying_order") return "SKIP_REFUNDED";
    return "SKIP_MANUAL_REVIEW";
}

/**
 * A customer may be created only when the planner marked them ready, they hold at
 * least one in-scope product family, and there is at least one license to grant.
 */
export function isThisPhaseCreateCandidate(customer: PlannedCustomer): boolean {
    if (!(APPLY_SCOPE.createStatuses as readonly string[]).includes(customer.status)) return false;
    if (!APPLY_SCOPE.families.some((family) => customer.families.includes(family))) return false;
    if (customer.licenseQuantity <= 0) return false;
    return true;
}

export function resolveApplyAction(input: {
    customer: PlannedCustomer;
    hasActiveWorkspace: boolean;
    hasLegacyMigrationWorkspace: boolean;
}): ApplyAction {
    if (!isThisPhaseCreateCandidate(input.customer) || input.customer.status !== "ready_create_workspace") {
        const mapped = mapPlanStatusToAction(input.customer.status);
        if (mapped === "CREATE") return "SKIP_MANUAL_REVIEW";
        return mapped;
    }

    if (input.hasActiveWorkspace || input.hasLegacyMigrationWorkspace) {
        return "SKIP_EXISTING";
    }

    return "CREATE";
}

function optionalUrl(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

export function readEmailConfig(env: Record<string, string | undefined> = process.env): EmailConfig {
    return {
        androidUrl: optionalUrl(env.HEALTHAGE_ANDROID_URL) ?? DEFAULT_HEALTHAGE_ANDROID_URL,
        windowsUrl: optionalUrl(env.HEALTHAGE_WINDOWS_URL) ?? DEFAULT_HEALTHAGE_WINDOWS_URL,
        iosUrl: optionalUrl(env.HEALTHAGE_IOS_URL) ?? DEFAULT_HEALTHAGE_IOS_URL,
        macosUrl: optionalUrl(env.HEALTHAGE_MACOS_URL) ?? DEFAULT_HEALTHAGE_MACOS_URL,
        supportEmail: optionalUrl(env.HEALTHAGE_SUPPORT_EMAIL) ?? DEFAULT_HEALTHAGE_SUPPORT_EMAIL,
    };
}

export function emailConfigIssues(config: EmailConfig): readonly string[] {
    const issues: string[] = [];
    if (!config.androidUrl && !config.windowsUrl && !config.iosUrl && !config.macosUrl) {
        issues.push("No HealthAge store URL is configured");
    }
    if (!config.supportEmail) issues.push("HEALTHAGE_SUPPORT_EMAIL is not set");
    // A configured link becomes a button in a customer's inbox, so it must be a plain http(s) URL.
    const links: ReadonlyArray<readonly [string, string | null]> = [
        ["HEALTHAGE_ANDROID_URL", config.androidUrl],
        ["HEALTHAGE_WINDOWS_URL", config.windowsUrl],
        ["HEALTHAGE_IOS_URL", config.iosUrl],
        ["HEALTHAGE_MACOS_URL", config.macosUrl],
    ];
    for (const [name, url] of links) {
        if (url && !isSafeHttpUrl(url)) issues.push(`${name} is not a plain http(s) URL`);
    }
    return issues;
}

export function buildWorkspaceNotes(customer: PlannedCustomer): string {
    const orders = customer.orderNumbers.join(", ");
    return `Legacy Shopify migration — order(s) ${orders}`;
}

export function resolveWorkspaceName(customer: PlannedCustomer): string {
    if (customer.company.trim()) return customer.company.trim();
    if (customer.customerName.trim()) return customer.customerName.trim();
    const localPart = customer.email.split("@")[0] ?? "HealthAge customer";
    return localPart || "HealthAge customer";
}

export function decideCustomer(input: {
    customer: PlannedCustomer;
    runDate: Date;
    user: ExistingUser | undefined;
    workspaces: readonly ExistingWorkspace[];
    dbChecked: boolean;
}): ApplyDecision {
    const notes = [...input.customer.reviewNotes];
    const activeWorkspaces = input.workspaces.filter(isWorkspaceAccessActive);
    const legacyWorkspaces = input.workspaces.filter(isLegacyMigrationWorkspace);
    const expiresAt = resolveGrantExpiry(input.customer, input.runDate);

    const action = resolveApplyAction({
        customer: input.customer,
        hasActiveWorkspace: input.dbChecked && activeWorkspaces.length > 0,
        hasLegacyMigrationWorkspace: input.dbChecked && legacyWorkspaces.length > 0,
    });

    if (input.dbChecked && activeWorkspaces.length > 0) {
        notes.push(
            `Already has ${activeWorkspaces.length} active workspace(s): ${activeWorkspaces
                .map(
                    (workspace) =>
                        `${workspace.name} (${workspace.billing_source}, seats ${workspace.seat_limit}, expires ${workspace.expires_at?.toISOString().slice(0, 10) ?? "never"})`
                )
                .join("; ")}.`
        );
    } else if (input.dbChecked && legacyWorkspaces.length > 0) {
        notes.push(
            `Already has a ${GRANT_CONFIG.workspaceBillingSource} workspace (${legacyWorkspaces.map((workspace) => workspace.id).join(", ")}). Rerun will not create another.`
        );
    }

    // An earlier migration run may have granted fewer seats than the plan now totals
    // (for example a software-only run before venue kits were added). Apply never
    // edits an existing workspace, so surface the difference for a human instead.
    if (input.dbChecked && action === "SKIP_EXISTING") {
        for (const workspace of legacyWorkspaces) {
            if (workspace.seat_limit !== input.customer.licenseQuantity) {
                notes.push(
                    `Existing ${GRANT_CONFIG.workspaceBillingSource} workspace ${workspace.id} has ${workspace.seat_limit} seat(s) but the plan totals ${input.customer.licenseQuantity}. Apply does not change existing workspaces; adjust the seat limit by hand if the difference is intended to be granted.`
                );
            }
        }
    }

    return {
        customer: input.customer,
        action,
        hasUser: input.user !== undefined,
        hasActiveWorkspace: activeWorkspaces.length > 0,
        hasLegacyMigrationWorkspace: legacyWorkspaces.length > 0,
        existingWorkspaceIds: input.workspaces.map((workspace) => workspace.id),
        inThisRun: false,
        reviewNotes: notes,
        startDate: formatGrantDisplayDate(input.runDate),
        expiryDate: formatGrantDisplayDate(expiresAt),
        expiresAt,
    };
}

/**
 * Marks the first `limit` CREATE decisions as inThisRun.
 * Limit applies to eligible migration candidates only, never to skipped rows.
 */
export function applyCreateLimit(decisions: readonly ApplyDecision[], limit: number | null): ApplyDecision[] {
    let remaining = limit;
    return decisions.map((decision) => {
        if (decision.action !== "CREATE") {
            return { ...decision, inThisRun: false };
        }
        if (remaining === null) {
            return { ...decision, inThisRun: true };
        }
        if (remaining > 0) {
            remaining -= 1;
            return { ...decision, inThisRun: true };
        }
        return { ...decision, inThisRun: false };
    });
}

// ---------------------------------------------------------------------------
// Exact recipient targeting (--only-emails)
// ---------------------------------------------------------------------------

export type TargetState =
    /** Will be created by this run. */
    | "eligible"
    /**
     * Already has a workspace, so nothing is created and a re-run is safe. It may be this
     * migration's workspace OR a live one (e.g. from the Shopify webhook): the detail says
     * which, because stage 2 only emails migration workspaces.
     */
    | "has_workspace"
    /** In the plan but held or refused (refund, manual review, ...): cannot be migrated. */
    | "blocked"
    /** Not in the plan at all: no order for this exact address contains an eligible product. */
    | "missing";

export type TargetEntry = { readonly email: string; readonly state: TargetState; readonly detail: string };

export type TargetReport = {
    readonly requested: readonly string[];
    readonly entries: readonly TargetEntry[];
    readonly eligible: readonly TargetEntry[];
    readonly hasWorkspace: readonly TargetEntry[];
    /** Blocked + missing. A write run is refused while this is non-empty. */
    readonly unresolved: readonly TargetEntry[];
};

/**
 * Says, for every requested address, exactly what a run would do with it. Matching is
 * exact on the normalized address: no aliases, no wildcards, no partial matches.
 */
export function buildTargetReport(decisions: readonly ApplyDecision[], onlyEmails: readonly string[]): TargetReport {
    const requested = [...new Set(onlyEmails.map(normalizeEmail))];

    const entries = requested.map((email): TargetEntry => {
        const decision = decisions.find((candidate) => candidate.customer.email !== "" && candidate.customer.email === email);
        if (!decision) {
            return {
                email,
                state: "missing",
                detail: "not in the migration plan: no order for this exact address contains an eligible product (check the spelling and the CSV)",
            };
        }
        if (decision.action === "CREATE") {
            return { email, state: "eligible", detail: `will create a workspace with ${decision.customer.licenseQuantity} licence(s)` };
        }
        if (decision.action === "SKIP_EXISTING") {
            return {
                email,
                state: "has_workspace",
                detail: decision.reviewNotes.find((note) => note.startsWith("Already has")) ?? "already has a workspace; nothing to create",
            };
        }
        return {
            email,
            state: "blocked",
            detail: `${decision.action}${decision.reviewNotes[0] ? `: ${decision.reviewNotes[0]}` : ""}`,
        };
    });

    return {
        requested,
        entries,
        eligible: entries.filter((entry) => entry.state === "eligible"),
        hasWorkspace: entries.filter((entry) => entry.state === "has_workspace"),
        unresolved: entries.filter((entry) => entry.state === "blocked" || entry.state === "missing"),
    };
}

/**
 * A write run must be able to act on, or find already done, EVERY address it was given.
 * One typo or one held customer refuses the whole run before anything is written, so a
 * pilot never half-happens and a mistyped address is never quietly dropped.
 */
export function assertTargetActionable(report: TargetReport): void {
    if (report.unresolved.length === 0) return;
    throw new Error(
        `--only-emails names ${report.unresolved.length} address(es) that cannot be migrated, so NOTHING was written:\n` +
            report.unresolved.map((entry) => `  ${entry.email}  [${entry.state}] ${entry.detail}`).join("\n")
    );
}

/**
 * Marks as `inThisRun` ONLY the CREATE decisions whose address is on the list. Everyone
 * else, including every other eligible customer, is explicitly left out.
 */
export function applyEmailAllowlist(decisions: readonly ApplyDecision[], onlyEmails: readonly string[]): ApplyDecision[] {
    const allowed = new Set(onlyEmails.map(normalizeEmail));
    return decisions.map((decision) => ({
        ...decision,
        inThisRun: decision.action === "CREATE" && decision.customer.email !== "" && allowed.has(normalizeEmail(decision.customer.email)),
    }));
}

/**
 * The single place the apply CLI turns decisions into "what runs now". With an allowlist
 * it NEVER falls back to the limit/all behaviour: it either targets exactly the listed
 * addresses or throws.
 */
export function selectDecisions(input: {
    decided: readonly ApplyDecision[];
    limit: number | null;
    onlyEmails: readonly string[];
    writesEnabled: boolean;
}): { decisions: ApplyDecision[]; targeting: TargetReport | null } {
    if (input.onlyEmails.length === 0) {
        return { decisions: applyCreateLimit(input.decided, input.limit), targeting: null };
    }
    if (input.limit !== null) {
        throw new Error("--only-emails and --limit cannot be combined: the listed addresses ARE the scope.");
    }
    const targeting = buildTargetReport(input.decided, input.onlyEmails);
    if (input.writesEnabled) assertTargetActionable(targeting);
    return { decisions: applyEmailAllowlist(input.decided, input.onlyEmails), targeting };
}

export function summarizeDecisions(decisions: readonly ApplyDecision[]): {
    create: number;
    createThisRun: number;
    skipExisting: number;
    skipMissingEmail: number;
    skipRefunded: number;
    skipManualReview: number;
    /** CREATE decisions whose purchaser bought at least one venue kit. */
    createWithVenueKit: number;
    licensesThisRun: number;
    licensesEligible: number;
} {
    const create = decisions.filter((decision) => decision.action === "CREATE");
    const createThisRun = create.filter((decision) => decision.inThisRun);
    return {
        create: create.length,
        createThisRun: createThisRun.length,
        skipExisting: decisions.filter((decision) => decision.action === "SKIP_EXISTING").length,
        skipMissingEmail: decisions.filter((decision) => decision.action === "SKIP_MISSING_EMAIL").length,
        skipRefunded: decisions.filter((decision) => decision.action === "SKIP_REFUNDED").length,
        skipManualReview: decisions.filter((decision) => decision.action === "SKIP_MANUAL_REVIEW").length,
        createWithVenueKit: create.filter((decision) => decision.customer.families.includes("venue_kit")).length,
        licensesThisRun: createThisRun.reduce((total, decision) => total + decision.customer.licenseQuantity, 0),
        licensesEligible: create.reduce((total, decision) => total + decision.customer.licenseQuantity, 0),
    };
}

export type ApplyExecutor = {
    findWorkspacesByOwnerEmail(email: string): Promise<ExistingWorkspace[]>;
    findUserByEmail(email: string): Promise<ExistingUser | null>;
    findOwnerMembership(workspaceId: string, email: string): Promise<{ id: string } | null>;
    insertWorkspace(values: {
        name: string;
        ownerEmail: string;
        ownerUserId: string | null;
        seatLimit: number;
        expiresAt: Date;
        notes: string;
    }): Promise<{ id: string }>;
    insertOwnerMembership(values: {
        workspaceId: string;
        userId: string | null;
        email: string;
        /** The purchaser's role: the organization owner/admin. Decided here, not in SQL. */
        role: string;
        status: "active" | "invited";
        joinedAt: Date | null;
    }): Promise<void>;
    updateWorkspaceNotes(workspaceId: string, notes: string): Promise<void>;
};

export type TransactionRunner = {
    runInTransaction<T>(fn: (tx: ApplyExecutor) => Promise<T>): Promise<T>;
};

export type CustomerApplyResult = {
    readonly email: string;
    readonly action: ApplyAction;
    readonly wrote: boolean;
    readonly workspaceId: string | null;
    readonly membershipStatus: "active" | "invited" | null;
    readonly emailed: boolean;
    readonly emailError: string | null;
    readonly error: string | null;
};

export async function applyOneCustomer(input: {
    runner: TransactionRunner;
    notesWriter: Pick<ApplyExecutor, "updateWorkspaceNotes" | "findWorkspacesByOwnerEmail">;
    customer: PlannedCustomer;
    decision: ApplyDecision;
    writeMode: ApplyWriteMode;
    emailConfig: EmailConfig;
    /**
     * Exact recipient allowlist (normalized). When given, a customer that is not on it is
     * never written, whatever the decision says: a second lock on top of `selectDecisions`.
     */
    onlyEmails?: ReadonlySet<string>;
    sendEmail: (payload: {
        to: string;
        customerName: string;
        /** The address the purchaser registers and signs in with. */
        accountEmail: string;
        workspaceName: string;
        /** What was bought and how many licenses it is worth, from the plan. */
        purchase: PurchaseSummary;
        startDate: string;
        expiryDate: string;
        androidUrl: string | null;
        windowsUrl: string | null;
        iosUrl: string | null;
        macosUrl: string | null;
        supportEmail: string;
    }) => Promise<void>;
    now?: Date;
}): Promise<CustomerApplyResult> {
    const { customer, decision, writeMode, emailConfig } = input;

    const outsideAllowlist = input.onlyEmails !== undefined && !input.onlyEmails.has(normalizeEmail(customer.email));

    if (decision.action !== "CREATE" || !decision.inThisRun || outsideAllowlist) {
        return {
            email: customer.email,
            action: decision.action,
            wrote: false,
            workspaceId: decision.existingWorkspaceIds[0] ?? null,
            membershipStatus: null,
            emailed: false,
            emailError: null,
            error: null,
        };
    }

    if (!writeMode.writesEnabled) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: false,
            workspaceId: null,
            membershipStatus: customer.email && decision.hasUser ? "active" : "invited",
            emailed: false,
            emailError: null,
            error: null,
        };
    }

    let workspaceId: string | null = null;
    let membershipStatus: "active" | "invited" | null = null;
    let existingNotes: string | null = null;

    try {
        const created = await input.runner.runInTransaction(async (tx) => {
            const workspaces = await tx.findWorkspacesByOwnerEmail(customer.email);
            const skip = resolveApplyAction({
                customer,
                hasActiveWorkspace: workspaces.some(isWorkspaceAccessActive),
                hasLegacyMigrationWorkspace: workspaces.some(isLegacyMigrationWorkspace),
            });
            if (skip !== "CREATE") {
                return {
                    skipped: true as const,
                    action: skip,
                    workspaceId: workspaces[0]?.id ?? null,
                    notes: workspaces.find(isLegacyMigrationWorkspace)?.notes ?? workspaces[0]?.notes ?? null,
                    membershipStatus: null as "active" | "invited" | null,
                };
            }

            const user = await tx.findUserByEmail(customer.email);
            const now = input.now ?? new Date();
            const workspace = await tx.insertWorkspace({
                name: resolveWorkspaceName(customer),
                ownerEmail: customer.email,
                ownerUserId: user?.id ?? null,
                seatLimit: customer.licenseQuantity,
                expiresAt: decision.expiresAt,
                notes: buildWorkspaceNotes(customer),
            });

            const status = user ? ("active" as const) : ("invited" as const);
            const existingMember = await tx.findOwnerMembership(workspace.id, customer.email);
            if (!existingMember) {
                await tx.insertOwnerMembership({
                    workspaceId: workspace.id,
                    userId: user?.id ?? null,
                    email: customer.email,
                    role: GRANT_CONFIG.ownerRole,
                    status,
                    joinedAt: user ? now : null,
                });
            }

            return {
                skipped: false as const,
                action: "CREATE" as const,
                workspaceId: workspace.id,
                notes: buildWorkspaceNotes(customer),
                membershipStatus: status,
            };
        });

        if (created.skipped) {
            return {
                email: customer.email,
                action: created.action,
                wrote: false,
                workspaceId: created.workspaceId,
                membershipStatus: created.membershipStatus,
                emailed: false,
                emailError: null,
                error: null,
            };
        }

        workspaceId = created.workspaceId;
        membershipStatus = created.membershipStatus;
        existingNotes = created.notes;
    } catch (error) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: false,
            workspaceId: null,
            membershipStatus: null,
            emailed: false,
            emailError: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    if (!writeMode.emailsEnabled) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: true,
            workspaceId,
            membershipStatus,
            emailed: false,
            emailError: null,
            error: null,
        };
    }

    if (notesIndicateFreeYearEmailSent(existingNotes)) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: true,
            workspaceId,
            membershipStatus,
            emailed: false,
            emailError: null,
            error: null,
        };
    }

    const configIssues = emailConfigIssues(emailConfig);
    if (configIssues.length > 0) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: true,
            workspaceId,
            membershipStatus,
            emailed: false,
            emailError: configIssues.join("; "),
            error: null,
        };
    }

    const purchase = buildPurchaseSummary(customer);
    if (!purchase) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: true,
            workspaceId,
            membershipStatus,
            emailed: false,
            emailError: "No qualifying purchase to describe in the email",
            error: null,
        };
    }

    try {
        await input.sendEmail({
            to: customer.email,
            customerName: customer.customerName,
            accountEmail: customer.email,
            workspaceName: resolveWorkspaceName(customer),
            purchase,
            startDate: decision.startDate,
            expiryDate: decision.expiryDate,
            androidUrl: emailConfig.androidUrl,
            windowsUrl: emailConfig.windowsUrl,
            iosUrl: emailConfig.iosUrl,
            macosUrl: emailConfig.macosUrl,
            supportEmail: emailConfig.supportEmail!,
        });
        if (workspaceId) {
            await input.notesWriter.updateWorkspaceNotes(
                workspaceId,
                appendFreeYearEmailSentMarker(existingNotes ?? buildWorkspaceNotes(customer), input.now ?? new Date())
            );
        }
        return {
            email: customer.email,
            action: "CREATE",
            wrote: true,
            workspaceId,
            membershipStatus,
            emailed: true,
            emailError: null,
            error: null,
        };
    } catch (error) {
        return {
            email: customer.email,
            action: "CREATE",
            wrote: true,
            workspaceId,
            membershipStatus,
            emailed: false,
            emailError: error instanceof Error ? error.message : String(error),
            error: null,
        };
    }
}
