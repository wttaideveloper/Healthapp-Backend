/**
 * Pure apply-phase decisions for the legacy Shopify customer migration.
 *
 * No database, no SMTP, no clock beyond values passed in. The CLI and the tests
 * share this module so a dry-run report is the same plan the writer would execute.
 */

import { APPLY_SCOPE, GRANT_CONFIG } from "./product-eligibility";
import {
    formatGrantDisplayDate,
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

/** Canonical customer support address. Not EMAIL_FROM. */
export const DEFAULT_HEALTHAGE_SUPPORT_EMAIL = "support@healthexporesources.com";

export function resolveWriteMode(input: { apply: boolean; dryRun: boolean }): ApplyWriteMode {
    const writesEnabled = input.apply === true && input.dryRun !== true;
    return {
        writesEnabled,
        emailsEnabled: writesEnabled,
    };
}

export function parseApplyArgs(argv: readonly string[]): {
    csvPath: string;
    outDir: string;
    skipDb: boolean;
    apply: boolean;
    dryRun: boolean;
    limit: number | null;
} {
    const args = {
        csvPath: "orders_export_1.csv",
        outDir: "migration-reports",
        skipDb: false,
        apply: false,
        dryRun: false,
        limit: null as number | null,
    };

    for (const argument of argv) {
        if (argument === "--skip-db") args.skipDb = true;
        else if (argument === "--apply") args.apply = true;
        else if (argument === "--dry-run") args.dryRun = true;
        else if (argument.startsWith("--csv=")) args.csvPath = argument.slice("--csv=".length);
        else if (argument.startsWith("--out=")) args.outDir = argument.slice("--out=".length);
        else if (argument.startsWith("--limit=")) {
            const parsed = Number(argument.slice("--limit=".length));
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error(`Invalid --limit value: ${argument}`);
            }
            args.limit = parsed;
        }
    }

    return args;
}

export function isWorkspaceAccessActive(workspace: Pick<ExistingWorkspace, "status" | "subscription_status" | "expires_at">): boolean {
    if (workspace.status !== "active") return false;
    if (!["active", "trialing"].includes(workspace.subscription_status)) return false;
    if (!workspace.expires_at) return true;
    return workspace.expires_at.getTime() > Date.now();
}

export function isLegacyMigrationWorkspace(workspace: Pick<ExistingWorkspace, "billing_source">): boolean {
    return workspace.billing_source === GRANT_CONFIG.workspaceBillingSource;
}

export function notesIndicateFreeYearEmailSent(notes: string | null | undefined): boolean {
    return (notes ?? "").includes(APPLY_SCOPE.emailSentMarker);
}

export function appendFreeYearEmailSentMarker(notes: string, sentAt: Date): string {
    const marker = `${APPLY_SCOPE.emailSentMarker} ${sentAt.toISOString()}`;
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

export function isThisPhaseCreateCandidate(customer: PlannedCustomer): boolean {
    if (!(APPLY_SCOPE.createStatuses as readonly string[]).includes(customer.status)) return false;
    if (!APPLY_SCOPE.families.some((family) => customer.families.includes(family))) return false;
    if (customer.families.includes("venue_kit")) return false;
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
        iosUrl: optionalUrl(env.HEALTHAGE_IOS_URL),
        macosUrl: optionalUrl(env.HEALTHAGE_MACOS_URL),
        supportEmail: optionalUrl(env.HEALTHAGE_SUPPORT_EMAIL) ?? DEFAULT_HEALTHAGE_SUPPORT_EMAIL,
    };
}

export function emailConfigIssues(config: EmailConfig): readonly string[] {
    const issues: string[] = [];
    if (!config.androidUrl && !config.windowsUrl && !config.iosUrl && !config.macosUrl) {
        issues.push("No HealthAge store URL is configured");
    }
    if (!config.supportEmail) issues.push("HEALTHAGE_SUPPORT_EMAIL is not set");
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

    if (action === "CREATE" && input.customer.families.includes("venue_kit")) {
        notes.push("This phase does not migrate venue kits.");
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

export function summarizeDecisions(decisions: readonly ApplyDecision[]): {
    create: number;
    createThisRun: number;
    skipExisting: number;
    skipMissingEmail: number;
    skipRefunded: number;
    skipManualReview: number;
    skipVenueKit: number;
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
        skipVenueKit: decisions.filter((decision) => decision.customer.families.includes("venue_kit")).length,
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
    sendEmail: (payload: {
        to: string;
        customerName: string;
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

    if (decision.action !== "CREATE" || !decision.inThisRun) {
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

    try {
        await input.sendEmail({
            to: customer.email,
            customerName: customer.customerName,
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
