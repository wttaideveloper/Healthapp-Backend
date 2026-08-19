import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { isShopifyManagedLicensingWorkspace } from "../../../src/modules/shopify/shopify.license.ts";
import { GRANT_CONFIG, matchLineItem } from "./product-eligibility.ts";
import { parseOrdersCsvText, readOrdersCsv, toCsvLine } from "./orders-csv.ts";
import { buildMigrationPlan, formatGrantDisplayDate, resolveGrantExpiry } from "./build-plan.ts";
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
    type ExistingWorkspace,
    type TransactionRunner,
} from "./apply-core.ts";
import { configuredStoreLinks, getLegacyFreeYearEmailContent } from "./migration-email.ts";

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

function createMemoryDb(seed?: { users?: { id: string; email: string; name: string }[]; workspaces?: ExistingWorkspace[] }) {
    let workspaceSeq = 1;
    let memberSeq = 1;
    const users = [...(seed?.users ?? [])];
    const workspaces: ExistingWorkspace[] = [...(seed?.workspaces ?? [])];
    const members: Array<{ id: string; workspaceId: string; email: string; status: string }> = [];
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
                email: values.email,
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

    it("venue kit is not migrated", () => {
        const plan = planFrom([
            {
                Name: "#1435",
                Email: "kit@example.com",
                Id: "5",
                "Lineitem name": "Health Expo Screening Kits - English / Large",
                "Lineitem sku": "004-2",
            },
        ]);
        assert.equal(plan.customers[0]?.status, "manual_review_venue_kit");
        assert.equal(
            resolveApplyAction({
                customer: plan.customers[0]!,
                hasActiveWorkspace: false,
                hasLegacyMigrationWorkspace: false,
            }),
            "SKIP_MANUAL_REVIEW"
        );
        assert.equal(plan.customers[0]?.licenseQuantity, 0);
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
        assert.equal(plan.customers[0]?.status, "manual_review_venue_kit");
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
                    expires_at: new Date("2027-01-01T00:00:00.000Z"),
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
        ]);
        const runDate = new Date("2026-08-16T00:00:00.000Z");
        const decided = plan.customers.map((customer) =>
            decideCustomer({ customer, runDate, user: undefined, workspaces: [], dbChecked: false })
        );
        const limited = applyCreateLimit(decided, 1);
        const summary = summarizeDecisions(limited);
        assert.equal(summary.create, 2);
        assert.equal(summary.createThisRun, 1);
        assert.equal(summary.skipMissingEmail, 1);
        assert.equal(summary.skipManualReview, 1);
        assert.equal(summary.skipVenueKit, 1);
        assert.equal(limited.filter((decision) => decision.inThisRun).length, 1);
    });
});

describe("legacy free-year email", () => {
    it("does not reuse live Shopify owner-welcome copy", () => {
        const content = getLegacyFreeYearEmailContent({
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            supportEmail: SUPPORT_EMAIL,
        });
        assert.match(content.subject, /1 year of FREE access/i);
        assert.match(content.text, /Pastor Rodney Bowes/);
        assert.doesNotMatch(content.text, /workspace-admin/);
        assert.doesNotMatch(content.subject, /Workspace Admin/);
    });

    it("includes Android and Windows store links when configured", () => {
        const content = getLegacyFreeYearEmailContent({
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            supportEmail: SUPPORT_EMAIL,
        });
        assert.match(content.text, /Get started here:/);
        assert.match(content.text, /Android:\nhttps:\/\/play\.google\.com\/store\/apps\/details\?id=com\.wtt\.healthAge/);
        assert.match(content.text, /Windows:\nhttps:\/\/apps\.microsoft\.com\/detail\/9P8MFP2CBVL5/);
        assert.match(content.html, /play\.google\.com\/store\/apps\/details\?id=com\.wtt\.healthAge/);
        assert.match(content.html, /apps\.microsoft\.com\/detail\/9P8MFP2CBVL5/);
        assert.match(content.text, /Now available on:\n\nAndroid • Windows/);
    });

    it("omits iOS and macOS links when those URLs are not configured", () => {
        const input = {
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
    });

    it("includes iOS and macOS only when those URLs are configured", () => {
        const content = getLegacyFreeYearEmailContent({
            customerName: "Pat",
            startDate: "2026-08-16",
            expiryDate: "2027-08-16",
            androidUrl: PLAY_STORE_URL,
            windowsUrl: MICROSOFT_STORE_URL,
            iosUrl: "https://apps.apple.com/example-ios",
            macosUrl: "https://apps.apple.com/example-macos",
            supportEmail: SUPPORT_EMAIL,
        });
        assert.match(content.text, /iOS:\nhttps:\/\/apps\.apple\.com\/example-ios/);
        assert.match(content.text, /macOS:\nhttps:\/\/apps\.apple\.com\/example-macos/);
        assert.match(content.text, /Android • Windows • iOS • macOS/);
    });

    it("uses the HealthAge support address and does not use the old Vercel app URL", () => {
        const content = getLegacyFreeYearEmailContent({
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

    it("reads store URLs and support email from env without inventing iOS or macOS listings", () => {
        const config = readEmailConfig({});
        assert.equal(config.androidUrl, PLAY_STORE_URL);
        assert.equal(config.windowsUrl, MICROSOFT_STORE_URL);
        assert.equal(config.iosUrl, null);
        assert.equal(config.macosUrl, null);
        assert.equal(config.supportEmail, SUPPORT_EMAIL);
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
        assert.equal(fromEnv.macosUrl, null);
        assert.equal(fromEnv.iosUrl?.includes("health-age.vercel.app"), false);
    });
});

describe("Shopify live licensing isolation", () => {
    it("legacy_shopify_migration is not Shopify-managed licensing", () => {
        assert.equal(GRANT_CONFIG.workspaceBillingSource, "legacy_shopify_migration");
        assert.equal(GRANT_CONFIG.workspaceBillingSource === "shopify", false);
        assert.equal(isShopifyManagedLicensingWorkspace("shopify"), true);
        assert.equal(isShopifyManagedLicensingWorkspace("legacy_shopify_migration"), false);
        assert.equal(isShopifyManagedLicensingWorkspace("manual"), false);
    });
});
