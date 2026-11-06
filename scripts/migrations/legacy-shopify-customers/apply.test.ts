import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import { isShopifyManagedLicensingWorkspace } from "../../../src/modules/shopify/shopify.license.ts";
import { hasAvailableWorkspaceSeat } from "../../../src/modules/workspace/workspace.seats.ts";
import { GRANT_CONFIG, matchLineItem } from "./product-eligibility.ts";
import { parseOrdersCsvText, readOrdersCsv, toCsvLine } from "./orders-csv.ts";
import {
    buildMigrationPlan,
    formatGrantDisplayDate,
    isPartiallyRefunded,
    resolveGrantExpiry,
    summarizeLicensesByProduct,
} from "./build-plan.ts";
import {
    applyCreateLimit,
    applyOneCustomer,
    decideCustomer,
    emailConfigIssues,
    mapPlanStatusToAction,
    notesIndicateFreeYearEmailSent,
    parseApplyArgs,
    readEmailConfig,
    resolveApplyAction,
    resolveWriteMode,
    summarizeDecisions,
    type ApplyExecutor,
    type ApplyWriteMode,
    type ExistingUser,
    type ExistingWorkspace,
    type TransactionRunner,
} from "./apply-core.ts";
import { configuredStoreLinks, getLegacyFreeYearEmailContent, type PurchaseSummary } from "./migration-email.ts";

const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.wtt.healthAge";
const MICROSOFT_STORE_URL = "https://apps.microsoft.com/detail/9P8MFP2CBVL5";
const SUPPORT_EMAIL = "support@healthexporesources.com";
const TEST_EMAIL_CONFIG = {
    androidUrl: PLAY_STORE_URL,
    windowsUrl: MICROSOFT_STORE_URL,
    iosUrl: null as string | null,
    macosUrl: null as string | null,
    supportEmail: SUPPORT_EMAIL,
};

const HEADER = [
    "Name",
    "Email",
    "Financial Status",
    "Created at",
    "Lineitem name",
    "Lineitem quantity",
    "Id",
    "Lineitem sku",
    "Cancelled at",
    "Billing Name",
    "Refunded Amount",
    "Paid at",
    "Billing Company",
];

type FixtureRow = Partial<Record<(typeof HEADER)[number], string>>;

function csvFrom(rows: FixtureRow[]): string {
    const lines = [toCsvLine(HEADER)];
    for (const row of rows) {
        lines.push(
            toCsvLine(
                HEADER.map((column) => {
                    if (column === "Lineitem sku") return row[column] ?? "008";
                    if (column === "Created at") return row[column] ?? "2026-06-01 12:00:00 -0700";
                    if (column === "Paid at") return row[column] ?? "2026-06-01 12:00:01 -0700";
                    if (column === "Financial Status") return row[column] ?? "paid";
                    if (column === "Lineitem quantity") return row[column] ?? "1";
                    if (column === "Refunded Amount") return row[column] ?? "0.00";
                    if (column === "Cancelled at") return row[column] ?? "";
                    return row[column] ?? "";
                })
            )
        );
    }
    return lines.join("\n");
}

function planFrom(rows: FixtureRow[]) {
    return buildMigrationPlan(parseOrdersCsvText(csvFrom(rows)));
}

/** Line items, as the Shopify export writes them (title + SKU). */
const dyha = (variant: number, quantity = 1): FixtureRow => ({
    "Lineitem name": `Discover Your Health Age - ${variant}`,
    "Lineitem sku": "008",
    "Lineitem quantity": String(quantity),
});
const smallKit = (quantity = 1): FixtureRow => ({
    "Lineitem name": "Health Expo Screening Kits - English / Small",
    "Lineitem sku": "004-1",
    "Lineitem quantity": String(quantity),
});
const largeKit = (quantity = 1): FixtureRow => ({
    "Lineitem name": "Health Expo Screening Kits - English / Large",
    "Lineitem sku": "004-2",
    "Lineitem quantity": String(quantity),
});
const unrelated = (name: string, sku = ""): FixtureRow => ({ "Lineitem name": name, "Lineitem sku": sku });

/**
 * One order as the export writes it: order-level columns on the first row only,
 * continuation rows carry just the order name and their own line item.
 */
function order(input: {
    name: string;
    email: string;
    id: string;
    lines: FixtureRow[];
    status?: string;
    refunded?: string;
    cancelledAt?: string;
    billingName?: string;
    company?: string;
}): FixtureRow[] {
    return input.lines.map((line, index) => ({
        ...line,
        Name: input.name,
        ...(index === 0
            ? {
                  Email: input.email,
                  Id: input.id,
                  "Financial Status": input.status ?? "paid",
                  "Refunded Amount": input.refunded ?? "0.00",
                  "Cancelled at": input.cancelledAt ?? "",
                  "Billing Name": input.billingName ?? "",
                  "Billing Company": input.company ?? "",
              }
            : {}),
    }));
}

const NO_EMAIL_MODE: ApplyWriteMode = { writesEnabled: true, emailsEnabled: false };
const APPLY_MODE: ApplyWriteMode = { writesEnabled: true, emailsEnabled: true };

/**
 * Mirrors the CLI: decisions are taken from a snapshot of the database at the start
 * of the run, then each customer is applied. `emails` records every send attempt.
 */
async function runApply(input: {
    db: ReturnType<typeof createMemoryDb>;
    plan: ReturnType<typeof planFrom>;
    runDate: Date;
    writeMode: ApplyWriteMode;
    users?: ExistingUser[];
    limit?: number | null;
}) {
    const emails: string[] = [];
    const decisions = applyCreateLimit(
        input.plan.customers.map((customer) =>
            decideCustomer({
                customer,
                runDate: input.runDate,
                user: input.users?.find((user) => user.email === customer.email),
                workspaces: customer.email ? input.db.workspaces.filter((workspace) => workspace.owner_email === customer.email) : [],
                dbChecked: true,
            })
        ),
        input.limit ?? null
    );
    const results = [];
    for (const decision of decisions) {
        results.push(
            await applyOneCustomer({
                runner: input.db.runner,
                notesWriter: input.db.executor,
                customer: decision.customer,
                decision,
                writeMode: input.writeMode,
                emailConfig: TEST_EMAIL_CONFIG,
                sendEmail: async (payload) => {
                    emails.push(payload.to);
                },
                now: input.runDate,
            })
        );
    }
    return { decisions, results, emails };
}

function createMemoryDb(seed?: { users?: { id: string; email: string; name: string }[]; workspaces?: ExistingWorkspace[] }) {
    let workspaceSeq = 1;
    let memberSeq = 1;
    const users = [...(seed?.users ?? [])];
    const workspaces: ExistingWorkspace[] = [...(seed?.workspaces ?? [])];
    const members: Array<{ id: string; workspaceId: string; userId: string | null; email: string; role: string; status: string }> = [];
    let writeCount = 0;

    const clone = <T>(value: T): T => structuredClone(value);

    const executor: ApplyExecutor = {
        async findWorkspacesByOwnerEmail(email) {
            return workspaces.filter((workspace) => workspace.owner_email === email);
        },
        async findUserByEmail(email) {
            return users.find((user) => user.email === email) ?? null;
        },
        async findOwnerMembership(workspaceId, email) {
            return members.find((member) => member.workspaceId === workspaceId && member.email === email) ?? null;
        },
        async insertWorkspace(values) {
            writeCount += 1;
            const row: ExistingWorkspace = {
                id: `ws-${workspaceSeq++}`,
                name: values.name,
                owner_email: values.ownerEmail,
                status: "active",
                subscription_status: "active",
                plan: "organization",
                seat_limit: values.seatLimit,
                expires_at: values.expiresAt,
                billing_source: GRANT_CONFIG.workspaceBillingSource,
                notes: values.notes,
            };
            workspaces.push(row);
            return { id: row.id };
        },
        async insertOwnerMembership(values) {
            writeCount += 1;
            members.push({
                id: `mem-${memberSeq++}`,
                workspaceId: values.workspaceId,
                userId: values.userId,
                email: values.email,
                role: values.role,
                status: values.status,
            });
        },
        async updateWorkspaceNotes(workspaceId, notes) {
            writeCount += 1;
            const workspace = workspaces.find((row) => row.id === workspaceId);
            if (workspace) {
                (workspace as { notes: string }).notes = notes;
            }
        },
    };

    const runner: TransactionRunner = {
        async runInTransaction(fn) {
            const workspaceSnapshot = clone(workspaces);
            const memberSnapshot = clone(members);
            try {
                return await fn(executor);
            } catch (error) {
                workspaces.splice(0, workspaces.length, ...workspaceSnapshot);
                members.splice(0, members.length, ...memberSnapshot);
                throw error;
            }
        },
    };

    return {
        executor,
        runner,
        workspaces,
        members,
        writes: () => writeCount,
    };
}

describe("legacy Shopify DYHA license calculation", () => {
    it("Discover Your Health Age - 1 × 1 → 1 license", () => {
        const match = matchLineItem({ lineItemName: "Discover Your Health Age - 1", sku: "008", quantity: 1 });
        assert.equal(match.outcome, "eligible");
        if (match.outcome === "eligible") assert.equal(match.licenses, 1);
    });

    it("Discover Your Health Age - 4 × 2 → 8 licenses", () => {
        const match = matchLineItem({ lineItemName: "Discover Your Health Age - 4", sku: "008", quantity: 2 });
        assert.equal(match.outcome, "eligible");
        if (match.outcome === "eligible") assert.equal(match.licenses, 8);
    });
});

describe("legacy Shopify customer grouping and skips", () => {
    it("multiple eligible orders for the same email become one customer", () => {
        const plan = planFrom([
            {
                Name: "#100",
                Email: "Pat@Example.com",
                Id: "1",
                "Lineitem name": "Discover Your Health Age - 1",
                "Billing Name": "Pat",
            },
            {
                Name: "#101",
                Email: "pat@example.com",
                Id: "2",
                "Lineitem name": "Discover Your Health Age - 4",
                "Lineitem quantity": "2",
            },
        ]);
        assert.equal(plan.customers.length, 1);
        assert.equal(plan.customers[0]?.email, "pat@example.com");
        assert.equal(plan.customers[0]?.licenseQuantity, 9);
        assert.equal(plan.customers[0]?.qualifyingOrderCount, 2);
        assert.equal(plan.customers[0]?.status, "ready_create_workspace");
    });

    it("missing email is skipped", () => {
        const plan = planFrom([
            {
                Name: "#1394",
                Email: "",
                Id: "3",
                "Lineitem name": "Discover Your Health Age - 1",
                "Billing Name": "Sheri Yohe",
            },
        ]);
        assert.equal(plan.customers[0]?.status, "blocked_missing_email");
        assert.equal(mapPlanStatusToAction(plan.customers[0]!.status), "SKIP_MISSING_EMAIL");
        assert.equal(
            resolveApplyAction({
                customer: plan.customers[0]!,
                hasActiveWorkspace: false,
                hasLegacyMigrationWorkspace: false,
            }),
            "SKIP_MISSING_EMAIL"
        );
    });

    it("fully refunded order is skipped", () => {
        const plan = planFrom([
            {
                Name: "#1418",
                Email: "refunded@example.com",
                "Financial Status": "refunded",
                Id: "4",
                "Lineitem name": "Discover Your Health Age - 1",
                "Refunded Amount": "90.20",
            },
        ]);
        assert.equal(plan.customers[0]?.status, "skip_no_qualifying_order");
        assert.equal(mapPlanStatusToAction(plan.customers[0]!.status), "SKIP_REFUNDED");
    });

    it("a paid venue kit order is migrated with its fixed license count", () => {
        const plan = planFrom([
            {
                Name: "#1435",
                Email: "kit@example.com",
                Id: "5",
                "Lineitem name": "Health Expo Screening Kits - English / Large",
                "Lineitem sku": "004-2",
            },
        ]);
        assert.equal(plan.customers[0]?.status, "ready_create_workspace");
        assert.equal(
            resolveApplyAction({
                customer: plan.customers[0]!,
                hasActiveWorkspace: false,
                hasLegacyMigrationWorkspace: false,
            }),
            "CREATE"
        );
        assert.equal(plan.customers[0]?.licenseQuantity, 4);
    });

    it("partial refund mixed order is skipped for manual review", () => {
        const plan = planFrom([
            {
                Name: "#1425",
                Email: "mixed@example.com",
                "Financial Status": "partially_refunded",
                Id: "6",
                "Lineitem name": "Health Expo Screening Kits - English / Small",
                "Lineitem sku": "004-1",
                "Refunded Amount": "292.50",
            },
            {
                Name: "#1425",
                Email: "mixed@example.com",
                Id: "6",
                "Lineitem name": "Discover Your Health Age - 1",
                "Lineitem sku": "008",
            },
        ]);
        assert.equal(plan.customers[0]?.status, "manual_review_partial_refund");
        assert.equal(
            resolveApplyAction({
                customer: plan.customers[0]!,
                hasActiveWorkspace: false,
                hasLegacyMigrationWorkspace: false,
            }),
            "SKIP_MANUAL_REVIEW"
        );
    });

    it("unrelated catalogue products are skipped", () => {
        const plan = planFrom([
            {
                Name: "#1439",
                Email: "banner@example.com",
                Id: "7",
                "Lineitem name": "Adult Health Banners - Premium (Indoor) / English",
                "Lineitem sku": "",
            },
        ]);
        assert.equal(plan.customers.length, 0);
        assert.equal(plan.skippedProducts.length, 1);
    });

    it("eligible CREATE counts are calculated from the CSV, not hardcoded", () => {
        const csvPath = resolve(process.cwd(), "orders_export_1.csv");
        const plan = buildMigrationPlan(readOrdersCsv(csvPath));
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decided = applyCreateLimit(
            plan.customers.map((customer) =>
                decideCustomer({ customer, runDate, user: undefined, workspaces: [], dbChecked: false })
            ),
            null
        );
        const summary = summarizeDecisions(decided);
        const licensesFromCreate = decided
            .filter((decision) => decision.action === "CREATE")
            .reduce((total, decision) => total + decision.customer.licenseQuantity, 0);
        assert.equal(summary.licensesEligible, licensesFromCreate);
        assert.equal(summary.createThisRun, summary.create);
        assert.ok(summary.create > 0, "export should contain at least one eligible DYHA customer");
        assert.ok(summary.skipMissingEmail >= 0);
        assert.ok(summary.skipRefunded >= 0);
        assert.ok(summary.skipManualReview >= 0);
    });
});

describe("legacy Shopify apply decisions", () => {
    it("existing active workspace does not create a duplicate", () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "owner@example.com",
                Id: "8",
                "Lineitem name": "Discover Your Health Age - 2",
            },
        ]);
        const decision = decideCustomer({
            customer: plan.customers[0]!,
            runDate: new Date("2026-08-16T00:00:00.000Z"),
            user: undefined,
            workspaces: [
                {
                    id: "existing",
                    name: "Already here",
                    owner_email: "owner@example.com",
                    status: "active",
                    subscription_status: "active",
                    plan: "organization",
                    seat_limit: 4,
                    // Far future: "active" is judged against the real clock.
                    expires_at: new Date("2099-01-01T00:00:00.000Z"),
                    billing_source: "shopify",
                    notes: null,
                },
            ],
            dbChecked: true,
        });
        assert.equal(decision.action, "SKIP_EXISTING");
    });

    it("running apply twice does not create a second workspace or membership", async () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "once@example.com",
                Id: "9",
                "Lineitem name": "Discover Your Health Age - 1",
                "Billing Name": "Once",
            },
        ]);
        const db = createMemoryDb();
        const runDate = new Date("2026-08-16T12:00:00.000Z");
        const decision = decideCustomer({
            customer: plan.customers[0]!,
            runDate,
            user: undefined,
            workspaces: [],
            dbChecked: true,
        });
        const limited = applyCreateLimit([decision], null);
        const emails: string[] = [];

        const first = await applyOneCustomer({
            runner: db.runner,
            notesWriter: db.executor,
            customer: plan.customers[0]!,
            decision: limited[0]!,
            writeMode: { writesEnabled: true, emailsEnabled: true },
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async (payload) => {
                emails.push(payload.to);
            },
            now: runDate,
        });
        assert.equal(first.wrote, true);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.members.length, 1);
        assert.equal(emails.length, 1);

        const secondDecision = decideCustomer({
            customer: plan.customers[0]!,
            runDate,
            user: undefined,
            workspaces: db.workspaces,
            dbChecked: true,
        });
        assert.equal(secondDecision.action, "SKIP_EXISTING");
        const secondLimited = applyCreateLimit([secondDecision], null);
        const second = await applyOneCustomer({
            runner: db.runner,
            notesWriter: db.executor,
            customer: plan.customers[0]!,
            decision: secondLimited[0]!,
            writeMode: { writesEnabled: true, emailsEnabled: true },
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async (payload) => {
                emails.push(payload.to);
            },
            now: runDate,
        });
        assert.equal(second.wrote, false);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.members.length, 1);
        assert.equal(emails.length, 1);
        assert.equal(notesIndicateFreeYearEmailSent(db.workspaces[0]?.notes), true);
    });

    it("expiry is start date + 365 days", () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "dates@example.com",
                Id: "10",
                "Lineitem name": "Discover Your Health Age - 1",
            },
        ]);
        const runDate = new Date("2026-08-16T15:04:05.000Z");
        const expiry = resolveGrantExpiry(plan.customers[0]!, runDate);
        assert.equal(formatGrantDisplayDate(runDate), "2026-08-16");
        assert.equal(formatGrantDisplayDate(expiry), "2027-08-16");
        assert.equal(expiry.getTime(), new Date("2027-08-16T15:04:05.000Z").getTime());
    });

    it("dry-run performs zero database writes and sends no email", async () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "dry@example.com",
                Id: "11",
                "Lineitem name": "Discover Your Health Age - 1",
            },
        ]);
        const db = createMemoryDb();
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decision = applyCreateLimit(
            [
                decideCustomer({
                    customer: plan.customers[0]!,
                    runDate,
                    user: undefined,
                    workspaces: [],
                    dbChecked: false,
                }),
            ],
            null
        )[0]!;
        let emailed = 0;
        const result = await applyOneCustomer({
            runner: db.runner,
            notesWriter: db.executor,
            customer: plan.customers[0]!,
            decision,
            writeMode: resolveWriteMode({ apply: false, dryRun: true }),
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async () => {
                emailed += 1;
            },
            now: runDate,
        });
        assert.equal(result.wrote, false);
        assert.equal(result.emailed, false);
        assert.equal(emailed, 0);
        assert.equal(db.writes(), 0);
        assert.equal(db.workspaces.length, 0);
    });

    it("apply without --apply performs zero database writes", () => {
        const mode = resolveWriteMode(parseApplyArgs(["--limit=5"]));
        assert.equal(mode.writesEnabled, false);
        assert.equal(mode.emailsEnabled, false);
    });

    it("email is only sent after a successful commit", async () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "commit@example.com",
                Id: "12",
                "Lineitem name": "Discover Your Health Age - 1",
            },
        ]);
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decision = applyCreateLimit(
            [
                decideCustomer({
                    customer: plan.customers[0]!,
                    runDate,
                    user: undefined,
                    workspaces: [],
                    dbChecked: true,
                }),
            ],
            null
        )[0]!;

        const failingDb = createMemoryDb();
        const originalInsert = failingDb.executor.insertWorkspace;
        failingDb.executor.insertWorkspace = async () => {
            throw new Error("insert failed");
        };
        let emailed = 0;
        const failed = await applyOneCustomer({
            runner: failingDb.runner,
            notesWriter: failingDb.executor,
            customer: plan.customers[0]!,
            decision,
            writeMode: { writesEnabled: true, emailsEnabled: true },
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async () => {
                emailed += 1;
            },
            now: runDate,
        });
        assert.equal(failed.wrote, false);
        assert.equal(failed.emailed, false);
        assert.equal(failed.error, "insert failed");
        assert.equal(emailed, 0);
        assert.equal(failingDb.workspaces.length, 0);

        failingDb.executor.insertWorkspace = originalInsert;
        const succeeded = await applyOneCustomer({
            runner: failingDb.runner,
            notesWriter: failingDb.executor,
            customer: plan.customers[0]!,
            decision,
            writeMode: { writesEnabled: true, emailsEnabled: true },
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async () => {
                emailed += 1;
            },
            now: runDate,
        });
        assert.equal(succeeded.wrote, true);
        assert.equal(succeeded.emailed, true);
        assert.equal(emailed, 1);
        assert.equal(failingDb.workspaces.length, 1);
        assert.equal(failingDb.members.length, 1);
        assert.equal(succeeded.membershipStatus, "invited");
    });

    it("email failure after commit does not roll back the workspace", async () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "mailfail@example.com",
                Id: "13",
                "Lineitem name": "Discover Your Health Age - 1",
            },
        ]);
        const db = createMemoryDb();
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decision = applyCreateLimit(
            [
                decideCustomer({
                    customer: plan.customers[0]!,
                    runDate,
                    user: undefined,
                    workspaces: [],
                    dbChecked: true,
                }),
            ],
            null
        )[0]!;
        const result = await applyOneCustomer({
            runner: db.runner,
            notesWriter: db.executor,
            customer: plan.customers[0]!,
            decision,
            writeMode: { writesEnabled: true, emailsEnabled: true },
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async () => {
                throw new Error("smtp down");
            },
            now: runDate,
        });
        assert.equal(result.wrote, true);
        assert.equal(result.emailed, false);
        assert.equal(result.emailError, "smtp down");
        assert.equal(db.workspaces.length, 1);
        assert.equal(notesIndicateFreeYearEmailSent(db.workspaces[0]?.notes), false);
    });

    it("existing user gets an active owner membership; missing user is invited", async () => {
        const plan = planFrom([
            {
                Name: "#1",
                Email: "known@example.com",
                Id: "14",
                "Lineitem name": "Discover Your Health Age - 1",
            },
        ]);
        const db = createMemoryDb({
            users: [{ id: "user-1", email: "known@example.com", name: "Known" }],
        });
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decision = applyCreateLimit(
            [
                decideCustomer({
                    customer: plan.customers[0]!,
                    runDate,
                    user: { id: "user-1", email: "known@example.com", name: "Known" },
                    workspaces: [],
                    dbChecked: true,
                }),
            ],
            null
        )[0]!;
        const result = await applyOneCustomer({
            runner: db.runner,
            notesWriter: db.executor,
            customer: plan.customers[0]!,
            decision,
            writeMode: { writesEnabled: true, emailsEnabled: false },
            emailConfig: {
                androidUrl: null,
                windowsUrl: null,
                iosUrl: null,
                macosUrl: null,
                supportEmail: null,
            },
            sendEmail: async () => {
                throw new Error("should not send");
            },
            now: runDate,
        });
        assert.equal(result.membershipStatus, "active");
        assert.equal(db.members[0]?.status, "active");
        assert.equal(db.workspaces[0]?.billing_source, "legacy_shopify_migration");
    });

    it("--limit applies only to CREATE candidates", () => {
        const plan = planFrom([
            { Name: "#1", Email: "a@example.com", Id: "15", "Lineitem name": "Discover Your Health Age - 1" },
            { Name: "#2", Email: "b@example.com", Id: "16", "Lineitem name": "Discover Your Health Age - 1" },
            {
                Name: "#3",
                Email: "",
                Id: "17",
                "Lineitem name": "Discover Your Health Age - 1",
                "Billing Name": "No Email",
            },
            {
                Name: "#4",
                Email: "kit@example.com",
                Id: "18",
                "Lineitem name": "Health Expo Screening Kits - English / Small",
                "Lineitem sku": "004-1",
            },
            {
                Name: "#5",
                Email: "partial@example.com",
                Id: "19",
                "Financial Status": "partially_refunded",
                "Refunded Amount": "10.00",
                "Lineitem name": "Discover Your Health Age - 1",
            },
        ]);
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decided = plan.customers.map((customer) =>
            decideCustomer({ customer, runDate, user: undefined, workspaces: [], dbChecked: false })
        );
        const limited = applyCreateLimit(decided, 1);
        const summary = summarizeDecisions(limited);
        assert.equal(summary.create, 3);
        assert.equal(summary.createThisRun, 1);
        assert.equal(summary.skipMissingEmail, 1);
        assert.equal(summary.skipManualReview, 1);
        assert.equal(summary.createWithVenueKit, 1);
        assert.equal(limited.filter((decision) => decision.inThisRun).length, 1);
    });
});

/** What the onboarding email needs besides the store links: who signs in, which workspace, what was bought. */
const ONBOARDING = {
    accountEmail: "pat@example.com",
    workspaceName: "Pat Workspace",
    purchase: {
        licenses: 1,
        lines: [{ kind: "dyha", label: "Discover Your Health Age", units: 1, licenses: 1 }],
    } satisfies PurchaseSummary,
} as const;

describe("legacy free-year email", () => {
    it("does not reuse live Shopify owner-welcome copy", () => {
        const content = getLegacyFreeYearEmailContent({
            ...ONBOARDING,
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            supportEmail: SUPPORT_EMAIL,
        });
        assert.equal(content.subject, "Important: Upgrade to the New Discover Your Health Age App – 1 Year FREE Access");
        assert.match(content.text, /Pastor Rodney Bowes/);
        assert.doesNotMatch(content.text, /workspace-admin/);
        assert.doesNotMatch(content.subject, /Workspace Admin/);

        // A single-license purchase uses the app directly, so it does not link the Admin Portal at all.
        // What must never come back is the live owner-welcome copy and its retired address.
        for (const body of [content.text, content.html]) {
            assert.doesNotMatch(body, /Visit:/);
            assert.doesNotMatch(body, /Pro account|Your Pro access will automatically/);
            assert.doesNotMatch(body, /vercel\.app/);
        }
        assert.doesNotMatch(content.subject, /Added as Workspace Admin|Complete registration/);
    });

    it("includes Android and Windows store links when configured", () => {
        const content = getLegacyFreeYearEmailContent({
            ...ONBOARDING,
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            supportEmail: SUPPORT_EMAIL,
        });
        assert.match(content.text, /Android: https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.wtt\.healthAge/);
        assert.match(content.text, /Windows: https:\/\/apps\.microsoft\.com\/detail\/9P8MFP2CBVL5/);
        assert.match(content.html, /play\.google\.com\/store\/apps\/details\?id=com\.wtt\.healthAge/);
        assert.match(content.html, /apps\.microsoft\.com\/detail\/9P8MFP2CBVL5/);
        assert.match(content.text, /Available on: Android • Windows/);
        assert.match(content.html, /Download for Android/);
        assert.match(content.html, /Download for Windows/);
    });

    it("omits iOS and macOS links when those URLs are not configured", () => {
        const input = {
            ...ONBOARDING,
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            iosUrl: null,
            macosUrl: null,
            supportEmail: SUPPORT_EMAIL,
        };
        const content = getLegacyFreeYearEmailContent(input);
        assert.deepEqual(
            configuredStoreLinks(input).map((store) => store.label),
            ["Android", "Windows"]
        );
        assert.doesNotMatch(content.text, /\biOS:/);
        assert.doesNotMatch(content.text, /\bmacOS:/);
        assert.doesNotMatch(content.html, /iOS:/);
        assert.doesNotMatch(content.html, /macOS:/);
        assert.doesNotMatch(content.text, /apps\.apple\.com/);
        assert.doesNotMatch(content.html, /apps\.apple\.com/);
        assert.doesNotMatch(content.html, /Download for (iOS|macOS)/);
    });

    it("includes iOS and macOS only when those URLs are configured", () => {
        const content = getLegacyFreeYearEmailContent({
            ...ONBOARDING,
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            iosUrl: "https://apps.apple.com/example-ios",
            macosUrl: "https://apps.apple.com/example-macos",
            supportEmail: SUPPORT_EMAIL,
        });
        assert.match(content.text, /iOS: https:\/\/apps\.apple\.com\/example-ios/);
        assert.match(content.text, /macOS: https:\/\/apps\.apple\.com\/example-macos/);
        assert.match(content.text, /Android • iOS • Windows • macOS/);
        assert.match(content.html, /Download for iOS/);
        assert.match(content.html, /Download for macOS/);
    });

    it("uses the HealthAge support address and does not use the old Vercel app URL", () => {
        const content = getLegacyFreeYearEmailContent({
            ...ONBOARDING,
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            supportEmail: SUPPORT_EMAIL,
        });
        assert.match(content.text, /support@healthexporesources\.com/);
        assert.match(content.html, /mailto:support@healthexporesources\.com/);
        assert.doesNotMatch(content.text, /health-age\.vercel\.app/);
        assert.doesNotMatch(content.html, /health-age\.vercel\.app/);
        assert.doesNotMatch(content.text, /HEALTHAGE_APP_URL/);
    });

    it("reads store URLs and support email from env, falling back to the published listings for all four platforms", () => {
        const config = readEmailConfig({});
        assert.equal(config.androidUrl, PLAY_STORE_URL);
        assert.equal(config.windowsUrl, MICROSOFT_STORE_URL);
        assert.equal(config.iosUrl, "https://apps.apple.com/in/app/health-age/id6744716742");
        assert.equal(config.macosUrl, "https://healthage.healthexporesources.com/download/");
        assert.equal(config.supportEmail, SUPPORT_EMAIL);
        // A blank variable is the same as an unset one: the default applies.
        assert.equal(readEmailConfig({ HEALTHAGE_IOS_URL: "   ", HEALTHAGE_MACOS_URL: "" }).iosUrl, config.iosUrl);
        assert.equal(readEmailConfig({ HEALTHAGE_IOS_URL: "   ", HEALTHAGE_MACOS_URL: "" }).macosUrl, config.macosUrl);
        assert.deepEqual(emailConfigIssues(config), []);
        assert.ok(
            emailConfigIssues({
                androidUrl: null,
                windowsUrl: null,
                iosUrl: null,
                macosUrl: null,
                supportEmail: null,
            }).length >= 2
        );

        const fromEnv = readEmailConfig({
            HEALTHAGE_ANDROID_URL: "https://play.google.com/store/apps/details?id=com.wtt.healthAge",
            HEALTHAGE_WINDOWS_URL: "https://apps.microsoft.com/detail/9P8MFP2CBVL5",
            HEALTHAGE_SUPPORT_EMAIL: "help@healthage.example",
            HEALTHAGE_IOS_URL: "https://apps.apple.com/configured-ios",
        });
        assert.equal(fromEnv.androidUrl, PLAY_STORE_URL);
        assert.equal(fromEnv.windowsUrl, MICROSOFT_STORE_URL);
        assert.equal(fromEnv.supportEmail, "help@healthage.example");
        assert.equal(fromEnv.iosUrl, "https://apps.apple.com/configured-ios");
        assert.equal(fromEnv.macosUrl, "https://healthage.healthexporesources.com/download/");
        assert.equal(fromEnv.iosUrl?.includes("health-age.vercel.app"), false);
    });
});

describe("Shopify live licensing isolation", () => {
    it("legacy_shopify_migration is not Shopify-managed licensing", () => {
        assert.equal(GRANT_CONFIG.workspaceBillingSource, "legacy_shopify_migration");
        assert.equal((GRANT_CONFIG.workspaceBillingSource as string) === "shopify", false);
        assert.equal(isShopifyManagedLicensingWorkspace("shopify"), true);
        assert.equal(isShopifyManagedLicensingWorkspace("legacy_shopify_migration"), false);
        assert.equal(isShopifyManagedLicensingWorkspace("manual"), false);
    });

    const migrationDir = resolve(process.cwd(), "scripts/migrations/legacy-shopify-customers");
    const sourceFiles = readdirSync(migrationDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const importsOf = (file: string): string[] =>
        [...readFileSync(join(migrationDir, file), "utf8").matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]!);

    it("migration scripts import nothing from the application src/ tree (except the pure email design module), so the webhook flow is never on their path", () => {
        assert.ok(sourceFiles.length >= 10, "expected the migration source files to be found");
        // The ONE allowed exception: the shared email layout, which has no imports of its own (checked below),
        // so it can reach neither the environment, the database, SMTP nor the Shopify webhook flow.
        const PURE_EMAIL_DESIGN = "../../../src/core/email/email-document";
        for (const file of sourceFiles) {
            for (const specifier of importsOf(file)) {
                if (specifier === PURE_EMAIL_DESIGN) {
                    assert.equal(file, "migration-email.ts", `only the email builder may use the shared design module (${file})`);
                    continue;
                }
                assert.doesNotMatch(specifier, /(^|\/)src\//, `${file} imports ${specifier}`);
                assert.doesNotMatch(specifier, /^@(modules|db|core|plugins|config)\//, `${file} imports ${specifier}`);
                assert.doesNotMatch(specifier, /shopify\.(service|route|admin)/, `${file} imports ${specifier}`);
            }
        }
    });

    it("the shared email design module the scripts may import is a pure leaf: no imports, no environment, no SMTP", () => {
        const source = readFileSync(resolve(process.cwd(), "src/core/email/email-document.ts"), "utf8");
        assert.equal(/^\s*import\s/m.test(source), false, "it imports nothing, so it cannot reach the webhook flow, the database or the environment");
        assert.doesNotMatch(source, /process\.env|require\(|nodemailer|from\s+["']/);
    });

    it("planning and apply-decision modules are pure: no database driver and no mail transport", () => {
        for (const file of [
            "product-eligibility.ts",
            "orders-csv.ts",
            "build-plan.ts",
            "apply-core.ts",
            "migration-email.ts",
            "send-emails-core.ts",
            "email-transport.ts",
        ]) {
            for (const specifier of importsOf(file)) {
                assert.notEqual(specifier, "pg", `${file} must not import pg`);
                assert.notEqual(specifier, "nodemailer", `${file} must not import nodemailer`);
            }
        }
    });
});

describe("venue kit license calculation (line-item quantity × licenses per unit)", () => {
    const licensesFor = (name: string, sku: string, quantity: number): number => {
        const match = matchLineItem({ lineItemName: name, sku, quantity });
        assert.equal(match.outcome, "eligible", `${name} x${quantity} should be eligible`);
        return match.outcome === "eligible" ? match.licenses : -1;
    };

    it("Discover Your Health Age (SKU 008): variant licenses × quantity", () => {
        assert.equal(licensesFor("Discover Your Health Age - 1", "008", 1), 1);
        assert.equal(licensesFor("Discover Your Health Age - 1", "008", 3), 3);
        assert.equal(licensesFor("Discover Your Health Age - 2", "008", 3), 6);
        assert.equal(licensesFor("Discover Your Health Age - 4", "008", 2), 8);
    });

    it("Small Venue Kit (SKU 004-1): 1 license × quantity", () => {
        const name = "Health Expo Screening Kits - English / Small";
        assert.equal(licensesFor(name, "004-1", 1), 1);
        assert.equal(licensesFor(name, "004-1", 3), 3);
        assert.equal(licensesFor(name, "004-1", 10), 10);
    });

    it("Large Venue Kit (SKU 004-2): 4 licenses × quantity", () => {
        const name = "Health Expo Screening Kits - English / Large";
        assert.equal(licensesFor(name, "004-2", 1), 4);
        assert.equal(licensesFor(name, "004-2", 2), 8);
        assert.equal(licensesFor(name, "004-2", 3), 12);
    });

    it("multiple Large Kits in one order: Large Venue Kit × 2 = 8 licenses for one customer", () => {
        const plan = planFrom(order({ name: "#2100", email: "venue@example.com", id: "2100", lines: [largeKit(2)] }));
        assert.equal(plan.customers.length, 1);
        assert.equal(plan.customers[0]?.licenseQuantity, 8);
        assert.equal(plan.customers[0]?.status, "ready_create_workspace");
    });

    it("multiple Large Kits across separate orders by the same purchaser combine into one customer", () => {
        const plan = planFrom([
            ...order({ name: "#2101", email: "Venue@Example.com", id: "2101", lines: [largeKit(1)] }),
            ...order({ name: "#2102", email: "venue@example.com ", id: "2102", lines: [largeKit(1)] }),
        ]);
        assert.equal(plan.customers.length, 1);
        assert.equal(plan.customers[0]?.email, "venue@example.com");
        assert.equal(plan.customers[0]?.licenseQuantity, 8);
        assert.equal(plan.customers[0]?.qualifyingOrderCount, 2);
        assert.deepEqual(plan.customers[0]?.orderNumbers, ["#2101", "#2102"]);
    });

    it("mixed purchase: unrelated products in the same order add no licenses", () => {
        const plan = planFrom(
            order({
                name: "#2103",
                email: "mixed@example.com",
                id: "2103",
                lines: [
                    unrelated("Hydrotherapy", "115"),
                    largeKit(1),
                    unrelated("Adult Health Banners - Premium (Indoor) / English"),
                    unrelated("Mini-Wright Peak Flow Meter", "010"),
                ],
            })
        );
        assert.equal(plan.customers[0]?.licenseQuantity, 4);
        assert.equal(plan.customers[0]?.status, "ready_create_workspace");
        assert.equal(plan.skippedProducts.length, 3);
    });

    it("mixed purchase: software and kits in one order are summed", () => {
        const plan = planFrom(
            order({ name: "#2104", email: "both@example.com", id: "2104", lines: [dyha(2), smallKit(2), unrelated("Tip")] })
        );
        assert.equal(plan.customers[0]?.licenseQuantity, 2 + 2);
        assert.deepEqual([...(plan.customers[0]?.families ?? [])].sort(), ["healthage_software", "venue_kit"]);
    });

    it("a quantity that cannot be read is ambiguous and never guessed", () => {
        for (const quantity of [0, -1, 1.5, Number.NaN]) {
            const kit = matchLineItem({ lineItemName: "Health Expo Screening Kits - English / Large", sku: "004-2", quantity });
            assert.equal(kit.outcome, "ambiguous", `Large Kit x${quantity}`);
        }
        assert.equal(matchLineItem({ lineItemName: "Discover Your Health Age - 1", sku: "008", quantity: 0 }).outcome, "ambiguous");

        const plan = planFrom(order({ name: "#2105", email: "qty@example.com", id: "2105", lines: [largeKit(0)] }));
        assert.equal(plan.ambiguousRows.length, 1);
        assert.equal(plan.customers[0]?.status, "blocked_ambiguous_data");
        assert.equal(
            resolveApplyAction({ customer: plan.customers[0]!, hasActiveWorkspace: false, hasLegacyMigrationWorkspace: false }),
            "SKIP_MANUAL_REVIEW"
        );
    });
});

describe("SKU-first product identification", () => {
    it("a known eligible SKU with a title that disagrees is ambiguous, not silently dropped or accepted", () => {
        const match = matchLineItem({ lineItemName: "Health Expo Screening Kits - Spanish / Large", sku: "004-2", quantity: 1 });
        assert.equal(match.outcome, "ambiguous");
        if (match.outcome === "ambiguous") {
            assert.equal(match.rule.id, "health_expo_screening_kit_large");
            assert.match(match.reason, /004-2/);
        }
    });

    it("an eligible-looking title carrying another eligible product's SKU is ambiguous (the SKU wins, the title is flagged)", () => {
        const largeTitleSmallSku = matchLineItem({ lineItemName: "Health Expo Screening Kits - English / Large", sku: "004-1", quantity: 1 });
        assert.equal(largeTitleSmallSku.outcome, "ambiguous");
        if (largeTitleSmallSku.outcome === "ambiguous") {
            assert.equal(largeTitleSmallSku.rule.id, "health_expo_screening_kit_small");
            assert.match(largeTitleSmallSku.reason, /SKU "004-1" identifies .*Small Venue Kit.* does not match the expected title/);
        }

        assert.equal(matchLineItem({ lineItemName: "Discover Your Health Age - 2", sku: "004-2", quantity: 1 }).outcome, "ambiguous");
        assert.equal(matchLineItem({ lineItemName: "Health Expo Screening Kits - English / Small", sku: "008", quantity: 1 }).outcome, "ambiguous");
    });

    it("an eligible-looking title carrying a SKU we do not know is ambiguous (catalogue drift)", () => {
        const drifted = matchLineItem({ lineItemName: "Health Expo Screening Kits - English / Large", sku: "004-9", quantity: 1 });
        assert.equal(drifted.outcome, "ambiguous");
        if (drifted.outcome === "ambiguous") {
            assert.equal(drifted.rule.id, "health_expo_screening_kit_large");
            assert.match(drifted.reason, /SKU "004-9" does not match the expected SKU\(s\) 004-2/);
        }
        assert.equal(matchLineItem({ lineItemName: "Discover Your Health Age - 3", sku: "999", quantity: 1 }).outcome, "ambiguous");
    });

    it("the title decides only when the SKU is blank", () => {
        const large = matchLineItem({ lineItemName: "Health Expo Screening Kits - English / Large", sku: "", quantity: 1 });
        assert.equal(large.outcome, "eligible");
        if (large.outcome === "eligible") assert.equal(large.licenses, 4);
        const software = matchLineItem({ lineItemName: "Discover Your Health Age - 2", sku: "  ", quantity: 1 });
        assert.equal(software.outcome, "eligible");
        if (software.outcome === "eligible") assert.equal(software.licenses, 2);
    });

    it("an unrelated title with an unrelated SKU is skipped", () => {
        assert.equal(matchLineItem({ lineItemName: "Charcoal", sku: "108", quantity: 1 }).outcome, "skipped");
        assert.equal(matchLineItem({ lineItemName: "Health Expo Manual (Download) - English", sku: "003-1", quantity: 1 }).outcome, "skipped");
    });

    it("a SKU/title conflict blocks the whole order so nothing is created for it", () => {
        const plan = planFrom(
            order({
                name: "#2200",
                email: "conflict@example.com",
                id: "2200",
                lines: [{ "Lineitem name": "Health Expo Screening Kits - Spanish / Large", "Lineitem sku": "004-2" }],
            })
        );
        assert.equal(plan.ambiguousRows.length, 1);
        assert.equal(plan.customers[0]?.status, "blocked_ambiguous_data");
        assert.equal(
            resolveApplyAction({ customer: plan.customers[0]!, hasActiveWorkspace: false, hasLegacyMigrationWorkspace: false }),
            "SKIP_MANUAL_REVIEW"
        );
    });
});

describe("purchaser grouping and organization creation", () => {
    const comboPlan = () =>
        planFrom([
            ...order({ name: "#2301", email: "Boss@Venue.org", id: "2301", lines: [dyha(2)], billingName: "Pat Boss", company: "Venue Church" }),
            ...order({ name: "#2302", email: " boss@venue.org ", id: "2302", lines: [smallKit(2)] }),
            ...order({ name: "#2303", email: "BOSS@VENUE.ORG", id: "2303", lines: [largeKit(1), unrelated("Tip")] }),
        ]);

    it("one purchaser buying several eligible products becomes one customer with combined licenses", () => {
        const plan = comboPlan();
        assert.equal(plan.customers.length, 1);
        const customer = plan.customers[0]!;
        assert.equal(customer.email, "boss@venue.org");
        assert.equal(customer.licenseQuantity, 2 + 2 + 4);
        assert.equal(customer.qualifyingOrderCount, 3);
        assert.deepEqual(customer.orderNumbers, ["#2301", "#2302", "#2303"]);
        assert.deepEqual([...customer.families].sort(), ["healthage_software", "venue_kit"]);
        assert.equal(customer.status, "ready_create_workspace");
    });

    it("creates exactly one organization with the combined seat count and one owner membership", async () => {
        const db = createMemoryDb();
        const { results } = await runApply({ db, plan: comboPlan(), runDate: new Date("2026-11-04T00:00:00.000Z"), writeMode: NO_EMAIL_MODE });
        assert.equal(results[0]?.wrote, true);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.workspaces[0]?.seat_limit, 8);
        assert.equal(db.members.length, 1);
        assert.equal(db.workspaces[0]?.name, "Venue Church");
        assert.match(db.workspaces[0]?.notes ?? "", /#2301, #2302, #2303/);
    });

    it("the purchaser becomes the organization owner/admin, and Large Kit × 2 leaves 7 seats to assign", async () => {
        const plan = planFrom(order({ name: "#2310", email: "Venue@Example.com", id: "2310", lines: [largeKit(2)] }));
        const db = createMemoryDb();
        await runApply({ db, plan, runDate: new Date("2026-11-04T00:00:00.000Z"), writeMode: NO_EMAIL_MODE });

        const workspace = db.workspaces[0]!;
        const member = db.members[0]!;
        assert.equal(workspace.owner_email, "venue@example.com");
        assert.equal(workspace.seat_limit, 8);
        assert.equal(member.workspaceId, workspace.id);
        assert.equal(member.email, workspace.owner_email);
        assert.equal(member.role, GRANT_CONFIG.ownerRole);
        assert.equal(member.role, "owner");

        // The live seat rule counts the owner's membership as a seat, so 7 of the 8 remain.
        assert.equal(hasAvailableWorkspaceSeat(db.members.length, workspace.seat_limit), true);
        for (let assigned = 1; assigned < workspace.seat_limit; assigned++) {
            assert.equal(hasAvailableWorkspaceSeat(assigned, workspace.seat_limit), true);
        }
        assert.equal(hasAvailableWorkspaceSeat(workspace.seat_limit, workspace.seat_limit), false);
    });

    it("a purchaser without an account is invited in the exact shape the login hook claims", async () => {
        const plan = planFrom(order({ name: "#2311", email: "New.Buyer@Example.com", id: "2311", lines: [smallKit(1)] }));
        const db = createMemoryDb();
        await runApply({ db, plan, runDate: new Date("2026-11-04T00:00:00.000Z"), writeMode: NO_EMAIL_MODE });
        const member = db.members[0]!;
        // linkWorkspaceMembershipsForUser claims rows where email = user.email, user_id IS NULL, status = 'invited'.
        assert.equal(member.status, "invited");
        assert.equal(member.userId, null);
        assert.equal(member.email, member.email.toLowerCase());
        assert.equal(member.email, "new.buyer@example.com");
    });

    it("a purchaser who already has an account gets an active owner membership linked to it", async () => {
        const plan = planFrom(order({ name: "#2312", email: "known@example.com", id: "2312", lines: [largeKit(1)] }));
        const users = [{ id: "user-9", email: "known@example.com", name: "Known" }];
        const db = createMemoryDb({ users });
        await runApply({ db, plan, runDate: new Date("2026-11-04T00:00:00.000Z"), writeMode: NO_EMAIL_MODE, users });
        assert.equal(db.members[0]?.status, "active");
        assert.equal(db.members[0]?.userId, "user-9");
        assert.equal(db.members[0]?.role, "owner");
    });

    it("each purchaser in a run gets their own organization with their own seat total", async () => {
        const plan = planFrom([
            ...order({ name: "#2320", email: "one@example.com", id: "2320", lines: [largeKit(2)] }),
            ...order({ name: "#2321", email: "two@example.com", id: "2321", lines: [smallKit(1)] }),
            ...order({ name: "#2322", email: "ONE@example.com", id: "2322", lines: [dyha(3)] }),
        ]);
        const db = createMemoryDb();
        await runApply({ db, plan, runDate: new Date("2026-11-04T00:00:00.000Z"), writeMode: NO_EMAIL_MODE });
        assert.equal(db.workspaces.length, 2);
        assert.equal(db.members.length, 2);
        const seats = Object.fromEntries(db.workspaces.map((workspace) => [workspace.owner_email, workspace.seat_limit]));
        assert.deepEqual(seats, { "one@example.com": 8 + 3, "two@example.com": 1 });
    });

    it("per-product totals add up to the combined seat total", () => {
        const plan = comboPlan();
        const byProduct = summarizeLicensesByProduct(plan.customers);
        const licenses = Object.fromEntries(byProduct.map((product) => [product.ruleId, product.licenses]));
        assert.deepEqual(licenses, {
            discover_your_health_age: 2,
            health_expo_screening_kit_small: 2,
            health_expo_screening_kit_large: 4,
        });
        assert.equal(
            byProduct.reduce((total, product) => total + product.licenses, 0),
            plan.customers[0]?.licenseQuantity
        );
        assert.ok(byProduct.every((product) => product.customers <= 1));
    });
});

describe("refunds, cancellations, missing emails and manual review", () => {
    const createdNothing = async (plan: ReturnType<typeof planFrom>) => {
        const db = createMemoryDb();
        const { results, decisions } = await runApply({
            db,
            plan,
            runDate: new Date("2026-11-04T00:00:00.000Z"),
            writeMode: APPLY_MODE,
        });
        assert.equal(db.workspaces.length, 0);
        assert.equal(db.members.length, 0);
        assert.equal(db.writes(), 0);
        assert.ok(results.every((result) => !result.wrote && !result.emailed));
        return decisions;
    };

    it("a fully refunded venue kit order is excluded and nothing is written", async () => {
        const plan = planFrom(
            order({ name: "#2400", email: "refunded@example.com", id: "2400", lines: [largeKit(1)], status: "refunded", refunded: "1100.00" })
        );
        assert.equal(plan.customers[0]?.status, "skip_no_qualifying_order");
        assert.equal(plan.excludedOrders.length, 1);
        const decisions = await createdNothing(plan);
        assert.equal(decisions[0]?.action, "SKIP_REFUNDED");
    });

    it("a cancelled order is excluded even though its financial status is paid", async () => {
        const plan = planFrom(
            order({
                name: "#2401",
                email: "cancelled@example.com",
                id: "2401",
                lines: [smallKit(1)],
                cancelledAt: "2026-06-02 10:00:00 -0700",
            })
        );
        assert.equal(plan.customers[0]?.status, "skip_no_qualifying_order");
        assert.match(plan.excludedOrders[0]?.reason ?? "", /cancelled/i);
        const decisions = await createdNothing(plan);
        assert.equal(decisions[0]?.action, "SKIP_REFUNDED");
    });

    it("missing or unusable emails are blocked, never merged with each other, and never written", async () => {
        const plan = planFrom([
            ...order({ name: "#2402", email: "", id: "2402", lines: [largeKit(1)], billingName: "No Email One" }),
            ...order({ name: "#2403", email: "not-an-email", id: "2403", lines: [smallKit(1)], billingName: "No Email Two" }),
            ...order({ name: "#2404", email: "", id: "2404", lines: [dyha(1)], billingName: "No Email Three" }),
        ]);
        assert.equal(plan.customers.length, 3);
        assert.ok(plan.customers.every((customer) => customer.status === "blocked_missing_email" && customer.email === ""));
        const decisions = await createdNothing(plan);
        assert.ok(decisions.every((decision) => decision.action === "SKIP_MISSING_EMAIL"));
    });

    it("order #1425 shape (partially refunded kit + software + other products) is held for manual review", async () => {
        const plan = planFrom(
            order({
                name: "#1425",
                email: "munthaliw101@gmail.com",
                id: "1425",
                status: "partially_refunded",
                refunded: "292.50",
                lines: [
                    smallKit(1),
                    unrelated("Omron Body Fat Monitor", "016"),
                    unrelated("Adult Health Expo Booklets - English / 100"),
                    dyha(1),
                    unrelated("Adult Health Banners - Premium (Indoor) / English"),
                    unrelated("Health Expo Manual (Download) - English", "003-1"),
                ],
            })
        );
        assert.equal(plan.customers[0]?.status, "manual_review_partial_refund");
        assert.match(plan.customers[0]?.reviewNotes.join(" ") ?? "", /refund allocation/);
        const decisions = await createdNothing(plan);
        assert.equal(decisions[0]?.action, "SKIP_MANUAL_REVIEW");
    });

    it("a paid order that still carries a Refunded Amount is treated as partially refunded", async () => {
        assert.equal(isPartiallyRefunded({ financialStatus: "paid", refundedAmount: 0 }), false);
        assert.equal(isPartiallyRefunded({ financialStatus: "paid", refundedAmount: 25 }), true);
        assert.equal(isPartiallyRefunded({ financialStatus: "partially_refunded", refundedAmount: 0 }), true);

        const plan = planFrom(
            order({ name: "#2410", email: "stale@example.com", id: "2410", lines: [largeKit(1)], status: "paid", refunded: "25.00" })
        );
        assert.equal(plan.customers[0]?.status, "manual_review_partial_refund");
        const decisions = await createdNothing(plan);
        assert.equal(decisions[0]?.action, "SKIP_MANUAL_REVIEW");
    });

    it("a clean order does not rescue a purchaser who also has a partially refunded order", async () => {
        const plan = planFrom([
            ...order({ name: "#2420", email: "split@example.com", id: "2420", lines: [largeKit(1)] }),
            ...order({ name: "#2421", email: "split@example.com", id: "2421", lines: [dyha(1)], status: "partially_refunded", refunded: "10.00" }),
        ]);
        assert.equal(plan.customers.length, 1);
        assert.equal(plan.customers[0]?.status, "manual_review_partial_refund");
        const decisions = await createdNothing(plan);
        assert.equal(decisions[0]?.action, "SKIP_MANUAL_REVIEW");
    });

    it("a purchaser with one clean order and one fully refunded order is migrated for the clean order only", () => {
        const plan = planFrom([
            ...order({ name: "#2430", email: "partly@example.com", id: "2430", lines: [largeKit(1)] }),
            ...order({ name: "#2431", email: "partly@example.com", id: "2431", lines: [largeKit(1)], status: "refunded", refunded: "1100.00" }),
        ]);
        assert.equal(plan.customers.length, 1);
        assert.equal(plan.customers[0]?.status, "ready_create_workspace");
        assert.equal(plan.customers[0]?.licenseQuantity, 4);
        assert.deepEqual(plan.customers[0]?.orderNumbers, ["#2430"]);
    });
});

describe("idempotency and transaction safety", () => {
    const comboPlan = () =>
        planFrom([
            ...order({ name: "#2501", email: "boss@venue.org", id: "2501", lines: [dyha(2)] }),
            ...order({ name: "#2502", email: "boss@venue.org", id: "2502", lines: [largeKit(1)] }),
        ]);
    const runDate = new Date("2026-11-04T09:00:00.000Z");

    it("a duplicate run creates no second workspace or membership and does not double the seats", async () => {
        const db = createMemoryDb();
        const plan = comboPlan();

        const first = await runApply({ db, plan, runDate, writeMode: APPLY_MODE });
        assert.equal(first.decisions[0]?.action, "CREATE");
        assert.equal(first.results[0]?.wrote, true);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.members.length, 1);
        assert.equal(db.workspaces[0]?.seat_limit, 6);
        assert.deepEqual(first.emails, ["boss@venue.org"]);

        const second = await runApply({ db, plan, runDate, writeMode: APPLY_MODE });
        assert.equal(second.decisions[0]?.action, "SKIP_EXISTING");
        assert.equal(second.results[0]?.wrote, false);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.members.length, 1);
        assert.equal(db.workspaces[0]?.seat_limit, 6);
        assert.deepEqual(second.emails, []);
    });

    it("a second run still skips even if the first decision snapshot was stale (checked again inside the transaction)", async () => {
        const db = createMemoryDb();
        const plan = comboPlan();
        const staleDecision = applyCreateLimit(
            [decideCustomer({ customer: plan.customers[0]!, runDate, user: undefined, workspaces: [], dbChecked: true })],
            null
        )[0]!;

        await runApply({ db, plan, runDate, writeMode: NO_EMAIL_MODE });
        assert.equal(db.workspaces.length, 1);

        const stale = await applyOneCustomer({
            runner: db.runner,
            notesWriter: db.executor,
            customer: plan.customers[0]!,
            decision: staleDecision,
            writeMode: NO_EMAIL_MODE,
            emailConfig: TEST_EMAIL_CONFIG,
            sendEmail: async () => {
                throw new Error("must not send");
            },
            now: runDate,
        });
        assert.equal(stale.wrote, false);
        assert.equal(stale.action, "SKIP_EXISTING");
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.members.length, 1);
    });

    it("if the owner membership insert fails, the workspace is rolled back; a retry creates exactly one of each", async () => {
        const db = createMemoryDb();
        const plan = comboPlan();
        const original = db.executor.insertOwnerMembership;
        db.executor.insertOwnerMembership = async () => {
            throw new Error("membership insert failed");
        };

        const failed = await runApply({ db, plan, runDate, writeMode: APPLY_MODE });
        assert.equal(failed.results[0]?.error, "membership insert failed");
        assert.equal(failed.results[0]?.wrote, false);
        assert.equal(db.workspaces.length, 0, "no orphan workspace without its owner");
        assert.equal(db.members.length, 0);
        assert.deepEqual(failed.emails, []);

        db.executor.insertOwnerMembership = original;
        const retried = await runApply({ db, plan, runDate, writeMode: APPLY_MODE });
        assert.equal(retried.results[0]?.wrote, true);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.members.length, 1);
    });

    it("an existing legacy workspace is reused as-is; a seat difference is surfaced, not silently edited", async () => {
        const existing: ExistingWorkspace = {
            id: "legacy-1",
            name: "Boss",
            owner_email: "boss@venue.org",
            status: "active",
            subscription_status: "active",
            plan: "organization",
            seat_limit: 2,
            expires_at: new Date("2099-01-01T00:00:00.000Z"),
            billing_source: GRANT_CONFIG.workspaceBillingSource,
            notes: "Legacy Shopify migration — order(s) #2501",
        };
        const db = createMemoryDb({ workspaces: [existing] });
        const { decisions, results } = await runApply({ db, plan: comboPlan(), runDate, writeMode: APPLY_MODE });
        assert.equal(decisions[0]?.action, "SKIP_EXISTING");
        assert.match(decisions[0]?.reviewNotes.join(" ") ?? "", /has 2 seat\(s\) but the plan totals 6/);
        assert.equal(results[0]?.wrote, false);
        assert.equal(db.writes(), 0);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.workspaces[0]?.seat_limit, 2);
    });

    it("an active Shopify-managed workspace for the purchaser is never touched", async () => {
        const live: ExistingWorkspace = {
            id: "live-1",
            name: "Live org",
            owner_email: "boss@venue.org",
            status: "active",
            subscription_status: "active",
            plan: "organization",
            seat_limit: 10,
            expires_at: new Date("2099-01-01T00:00:00.000Z"),
            billing_source: "shopify",
            notes: null,
        };
        const db = createMemoryDb({ workspaces: [live] });
        const { decisions, emails } = await runApply({ db, plan: comboPlan(), runDate, writeMode: APPLY_MODE });
        assert.equal(decisions[0]?.action, "SKIP_EXISTING");
        assert.equal(db.writes(), 0);
        assert.equal(db.workspaces[0]?.seat_limit, 10);
        assert.deepEqual(emails, []);
    });
});

describe("one-year free access window", () => {
    it("expiry is exactly run date + 365 days for venue kit customers, whenever they bought", async () => {
        // 2027-03-01 + 365 days crosses 29 Feb 2028, so this fails if "1 year" were used instead of 365 days.
        const runDate = new Date("2027-03-01T10:00:00.000Z");
        const plan = planFrom([
            ...order({ name: "#2600", email: "early@example.com", id: "2600", lines: [smallKit(1)] }),
            {
                ...order({ name: "#2601", email: "late@example.com", id: "2601", lines: [largeKit(1)] })[0]!,
                "Created at": "2026-07-22 16:22:04 -0700",
            },
        ]);
        const db = createMemoryDb();
        const { decisions } = await runApply({ db, plan, runDate, writeMode: NO_EMAIL_MODE });

        assert.equal(db.workspaces.length, 2);
        for (const workspace of db.workspaces) {
            assert.equal(workspace.expires_at?.toISOString(), "2028-02-29T10:00:00.000Z");
            assert.equal(workspace.expires_at!.getTime() - runDate.getTime(), 365 * 24 * 60 * 60 * 1000);
        }
        for (const decision of decisions) {
            assert.equal(decision.startDate, "2027-03-01");
            assert.equal(decision.expiryDate, "2028-02-29");
        }
    });

    it("the grant starts on the migration run date, not the purchase date", () => {
        assert.equal(GRANT_CONFIG.grantStartsFrom, "migration_run_date");
        assert.equal(GRANT_CONFIG.accessDurationDays, 365);
        assert.equal(GRANT_CONFIG.workspaceBillingSource, "legacy_shopify_migration");

        const plan = planFrom(order({ name: "#2610", email: "old@example.com", id: "2610", lines: [largeKit(1)] }));
        const runDate = new Date("2026-11-04T08:30:00.000Z");
        const customer = { ...plan.customers[0]!, lastPurchaseDate: "2026-03-20" };
        assert.equal(formatGrantDisplayDate(resolveGrantExpiry(customer, runDate)), "2027-11-04");
    });
});

describe("email safety", () => {
    const runDate = new Date("2026-11-04T09:00:00.000Z");
    const kitPlan = () =>
        planFrom([
            ...order({ name: "#2700", email: "kit.one@example.com", id: "2700", lines: [largeKit(2)] }),
            ...order({ name: "#2701", email: "kit.two@example.com", id: "2701", lines: [smallKit(1), dyha(1)] }),
        ]);

    it("--dry-run sends no email and writes nothing, even when --apply is also passed", async () => {
        const mode = resolveWriteMode(parseApplyArgs(["--apply", "--dry-run"]));
        assert.deepEqual(mode, { writesEnabled: false, emailsEnabled: false });

        const db = createMemoryDb();
        const { results, emails } = await runApply({ db, plan: kitPlan(), runDate, writeMode: mode });
        assert.deepEqual(emails, []);
        assert.equal(db.writes(), 0);
        assert.equal(db.workspaces.length, 0);
        assert.ok(results.every((result) => !result.wrote && !result.emailed));
    });

    it("without --apply nothing is written or emailed", async () => {
        const mode = resolveWriteMode(parseApplyArgs(["--no-email"]));
        assert.deepEqual(mode, { writesEnabled: false, emailsEnabled: false });
        const db = createMemoryDb();
        const { emails } = await runApply({ db, plan: kitPlan(), runDate, writeMode: mode });
        assert.deepEqual(emails, []);
        assert.equal(db.writes(), 0);
    });

    it("--apply --no-email creates the organizations but never calls the email sender", async () => {
        const mode = resolveWriteMode(parseApplyArgs(["--apply", "--no-email"]));
        assert.deepEqual(mode, { writesEnabled: true, emailsEnabled: false });

        const db = createMemoryDb();
        const { results, emails } = await runApply({ db, plan: kitPlan(), runDate, writeMode: mode });
        assert.equal(db.workspaces.length, 2);
        assert.equal(db.members.length, 2);
        assert.deepEqual(emails, []);
        assert.ok(results.every((result) => result.wrote && !result.emailed && result.emailError === null));
        assert.ok(db.workspaces.every((workspace) => !notesIndicateFreeYearEmailSent(workspace.notes)));
    });

    it("--apply without --no-email keeps the existing behaviour: one email per created organization, after commit", async () => {
        const mode = resolveWriteMode(parseApplyArgs(["--apply"]));
        assert.deepEqual(mode, { writesEnabled: true, emailsEnabled: true });

        const db = createMemoryDb();
        const { emails } = await runApply({ db, plan: kitPlan(), runDate, writeMode: mode });
        assert.deepEqual([...emails].sort(), ["kit.one@example.com", "kit.two@example.com"]);
        assert.ok(db.workspaces.every((workspace) => notesIndicateFreeYearEmailSent(workspace.notes)));
    });

    it("a mistyped safety flag is rejected instead of silently being ignored", () => {
        assert.throws(() => parseApplyArgs(["--apply", "--no-emial"]), /Unknown argument: --no-emial/);
        assert.throws(() => parseApplyArgs(["--dryrun"]), /Unknown argument/);
        assert.throws(() => parseApplyArgs(["--limit=0"]), /Invalid --limit/);
    });

    it("the pnpm '--' separator and every documented flag are still accepted", () => {
        const args = parseApplyArgs(["--", "--dry-run", "--skip-db", "--csv=x.csv", "--out=reports", "--limit=3", "--no-email"]);
        assert.deepEqual(args, {
            csvPath: "x.csv",
            outDir: "reports",
            skipDb: true,
            apply: false,
            dryRun: true,
            noEmail: true,
            limit: 3,
            onlyEmails: [],
        });
    });

    it("the approved subject and sign-off are unchanged; dates are shown in full and the body is personalised", () => {
        const content = getLegacyFreeYearEmailContent({
            ...ONBOARDING,
            customerName: "Pat",
            startDate: "2026-11-04",
            expiryDate: "2027-11-04",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            supportEmail: SUPPORT_EMAIL,
        });
        assert.equal(content.subject, "Important: Upgrade to the New Discover Your Health Age App – 1 Year FREE Access");
        assert.match(content.text, /Start Date: 4 November 2026\nExpiry Date: 4 November 2027/);
        assert.match(content.text, /Warm regards,\nPastor Rodney Bowes\nHealthAge Support Team\nDiscover Your Health Age$/);
        assert.doesNotMatch(content.text, /\biOS:|\bmacOS:/);
    });
});

describe("real export (orders_export_1.csv) with venue kits included", () => {
    const load = () => {
        const plan = buildMigrationPlan(readOrdersCsv(resolve(process.cwd(), "orders_export_1.csv")));
        const decisions = applyCreateLimit(
            plan.customers.map((customer) =>
                decideCustomer({ customer, runDate: new Date("2026-11-04T00:00:00.000Z"), user: undefined, workspaces: [], dbChecked: false })
            ),
            null
        );
        const byOrder = (orderNumber: string) => {
            const decision = decisions.find((candidate) => candidate.customer.orderNumbers.includes(orderNumber));
            assert.ok(decision, `${orderNumber} should belong to a planned customer`);
            return decision;
        };
        return { plan, decisions, byOrder };
    };

    it("order #1425 (partially refunded, mixed) is held for manual review and not created", () => {
        const { byOrder } = load();
        const decision = byOrder("#1425");
        assert.equal(decision.customer.status, "manual_review_partial_refund");
        assert.equal(decision.action, "SKIP_MANUAL_REVIEW");
        assert.equal(decision.inThisRun, false);
    });

    it("paid kit orders are created at 4 licenses per Large Kit and 1 per Small Kit", () => {
        const { byOrder } = load();
        for (const orderNumber of ["#1436", "#1435", "#1423", "#1389", "#1386"]) {
            assert.equal(byOrder(orderNumber).action, "CREATE", orderNumber);
            assert.equal(byOrder(orderNumber).customer.licenseQuantity, 4, orderNumber);
        }
        for (const orderNumber of ["#1426", "#1380"]) {
            assert.equal(byOrder(orderNumber).action, "CREATE", orderNumber);
            assert.equal(byOrder(orderNumber).customer.licenseQuantity, 1, orderNumber);
        }
    });

    it("fully refunded orders and missing-email orders stay excluded", () => {
        const { byOrder } = load();
        assert.equal(byOrder("#1417").action, "SKIP_REFUNDED");
        assert.equal(byOrder("#1418").action, "SKIP_REFUNDED");
        assert.equal(byOrder("#1385").action, "SKIP_MISSING_EMAIL");
        assert.equal(byOrder("#1394").action, "SKIP_MISSING_EMAIL");
    });

    it("per-product totals reconcile with the seats that would be written; one organization per email", () => {
        const { decisions } = load();
        const created = decisions.filter((decision) => decision.action === "CREATE").map((decision) => decision.customer);
        const byProduct = summarizeLicensesByProduct(created);
        const seats = created.reduce((total, customer) => total + customer.licenseQuantity, 0);
        assert.equal(
            byProduct.reduce((total, product) => total + product.licenses, 0),
            seats
        );

        const large = byProduct.find((product) => product.ruleId === "health_expo_screening_kit_large")!;
        const small = byProduct.find((product) => product.ruleId === "health_expo_screening_kit_small")!;
        assert.equal(large.licenses, large.units * 4);
        assert.equal(small.licenses, small.units * 1);

        const emails = created.map((customer) => customer.email);
        assert.equal(new Set(emails).size, emails.length);
        assert.ok(emails.every((email) => email === email.trim().toLowerCase() && email.length > 0));
    });
});
