/**
 * Onboarding emails for the legacy Shopify customer migration (the free-year grant).
 *
 * This is NOT the live Shopify workspace-owner welcome mail. The copy and subjects are specific to
 * the historical upgrade grant.
 *
 * Three templates, chosen from what the customer actually bought:
 *
 *   existing_customer  Discover Your Health Age (software, SKU 008)
 *   small_venue_kit    Small Venue Kit (SKU 004-1)
 *   large_venue_kit    Large Venue Kit (SKU 004-2)
 *
 * The product kinds come from the migration plan's own SKU-first classification (`ELIGIBLE_PRODUCTS`,
 * via `purchase-summary.ts`); nothing here matches product names. Which STEPS the email shows depends on
 * the real license count, not on the product name:
 *
 *   1 license  -> direct route: download the app, sign in or create an account, done. No Admin Portal,
 *                 no workspace or member instructions.
 *   2+ licenses-> workspace route: the owner opens the Admin Portal, checks the license counter and
 *                 invites the additional members (each uses the app with their own account).
 *
 * A purchase is never reduced to one product: the email lists every line and the total.
 *
 * The email is built as a structured document from the shared design system
 * (`src/core/email/email-document.ts`): one HTML renderer (tables + inline CSS only) and one plain-text
 * renderer, so the two always say the same thing.
 *
 * Every instruction describes something the application actually does (verified against the Admin
 * Portal, the backend routes and the mobile app). Do not add a step, a button name or an approval
 * requirement that the product does not have.
 *
 * Store links are configuration. Unconfigured platforms are omitted rather than shown empty, and any
 * configured link that is not a plain http(s) URL is refused, never emitted.
 */

import {
    bold,
    buildStoreLinks,
    count,
    discontinuationNoticeBlock,
    formatEmailDate,
    isMailbox,
    isSafeHttpUrl,
    renderEmailDocument,
    type Block,
    type EmailDocument,
    type Rich,
    type Segment,
    type Step,
    type StoreLink,
} from "../../../src/core/email/email-document";

export { formatEmailDate, isSafeHttpUrl };

/**
 * The HealthAge Admin / Workspace Admin portal. Scripts do not import application modules that read
 * the environment, so this repeats `WORKSPACE_ADMIN_URL` from `src/modules/workspace/workspace.links.ts`;
 * a test keeps the two identical.
 */
export const ADMIN_PORTAL_URL = "https://healthage.healthexporesources.com/";

/** The three templates and their subjects. */
export const EMAIL_SUBJECTS = {
    existing_customer: "Important: Upgrade to the New Discover Your Health Age App – 1 Year FREE Access",
    small_venue_kit: "Your Small Venue Kit – Upgrade to the New HealthAge App with 1 Year FREE Access",
    large_venue_kit: "Your Large Venue Kit – Upgrade to the New HealthAge App with 1 Year FREE Access",
} as const;

export type EmailTemplateKind = keyof typeof EMAIL_SUBJECTS;

export type PurchaseKind = "dyha" | "small_venue_kit" | "large_venue_kit";

export type PurchaseLine = {
    readonly kind: PurchaseKind;
    /** Customer-facing product name, e.g. "Large Venue Kit". */
    readonly label: string;
    /** Units bought (sum of line-item quantities). */
    readonly units: number;
    /** Licenses this product contributes: the migration's own calculation, never recomputed here. */
    readonly licenses: number;
};

export type PurchaseSummary = {
    /** Total licenses allocated to the workspace. Must equal the sum of the lines. */
    readonly licenses: number;
    readonly lines: readonly PurchaseLine[];
};

export type FreeYearEmailInput = {
    /** Greeting name. */
    readonly customerName: string;
    /** The address the purchaser must register and sign in with (the workspace owner email). */
    readonly accountEmail: string;
    readonly workspaceName: string;
    /** `YYYY-MM-DD` (shown as "4 November 2026"); any other text is shown as given (sample mode). */
    readonly startDate: string;
    readonly expiryDate: string;
    readonly supportEmail: string;
    readonly purchase: PurchaseSummary;
    readonly androidUrl?: string | null;
    readonly windowsUrl?: string | null;
    readonly iosUrl?: string | null;
    readonly macosUrl?: string | null;
};

export type FreeYearEmailContent = {
    readonly subject: string;
    readonly text: string;
    readonly html: string;
};

export function inferMigrationCustomerDisplayName(email: string, explicitName?: string | null): string {
    if (explicitName && explicitName.trim().length > 0) return explicitName.trim();
    const localPart = email.split("@")[0] ?? "there";
    return localPart || "there";
}

/** The configured platform links, in the order customers see them (Android, iOS, Windows, macOS). */
export function configuredStoreLinks(input: Pick<FreeYearEmailInput, "androidUrl" | "windowsUrl" | "iosUrl" | "macosUrl">): StoreLink[] {
    return buildStoreLinks({ android: input.androidUrl, ios: input.iosUrl, windows: input.windowsUrl, macos: input.macosUrl });
}

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------

/**
 * Which template a purchase gets. Decided from the SKU-derived product kinds, in a fixed order:
 * a Large Venue Kit, then a Small Venue Kit, otherwise the software. A mixed purchase therefore gets a
 * deterministic headline, and nothing is lost: the email still lists every product line and the total
 * license count, and shows the workspace route whenever there is more than one license.
 */
export function selectEmailTemplate(purchase: PurchaseSummary): EmailTemplateKind {
    const kinds = new Set(purchase.lines.map((line) => line.kind));
    if (kinds.has("large_venue_kit")) return "large_venue_kit";
    if (kinds.has("small_venue_kit")) return "small_venue_kit";
    return "existing_customer";
}

export function emailSubjectFor(purchase: PurchaseSummary): string {
    return EMAIL_SUBJECTS[selectEmailTemplate(purchase)];
}

function assertValidPurchase(purchase: PurchaseSummary): void {
    const sum = purchase.lines.reduce((total, line) => total + line.licenses, 0);
    if (!Number.isInteger(purchase.licenses) || purchase.licenses < 1) {
        throw new Error(`Refusing to build the email: the license count must be a whole number of at least 1 (got ${purchase.licenses}).`);
    }
    if (purchase.lines.length === 0 || sum !== purchase.licenses) {
        throw new Error(
            `Refusing to build the email: the product lines add up to ${sum} license(s) but the workspace has ${purchase.licenses}. The email must never state a wrong number.`
        );
    }
}

/** "Your Large Venue Kit includes 4 licenses" and its variants, always from the real counts (no trailing punctuation). */
function describePurchase(purchase: PurchaseSummary): string {
    const n = purchase.licenses;
    const only = purchase.lines.length === 1 ? purchase.lines[0] : undefined;
    if (only && only.kind === "small_venue_kit") {
        return only.units === 1 ? `Your Small Venue Kit includes ${count(n, "license")}` : `Your ${only.units} Small Venue Kits include ${count(n, "license")}`;
    }
    if (only && only.kind === "large_venue_kit") {
        return only.units === 1 ? `Your Large Venue Kit includes ${count(n, "license")}` : `Your ${only.units} Large Venue Kits include ${count(n, "license")}`;
    }
    if (only && only.kind === "dyha") return `Your Discover Your Health Age purchase includes ${count(n, "license")}`;
    return `Your purchases include ${count(n, "license")} in total`;
}

/** The purchase as shown in the "Your Free Access" card: every line, never just one product. */
function purchaseRowLines(purchase: PurchaseSummary): string[] {
    if (purchase.lines.length === 1) {
        const line = purchase.lines[0]!;
        return [line.kind === "dyha" ? line.label : `${line.label} × ${line.units}`];
    }
    return purchase.lines.map((line) =>
        line.kind === "dyha" ? `${line.label} — ${count(line.licenses, "license")}` : `${line.label} × ${line.units} — ${count(line.licenses, "license")}`
    );
}

/** "your Small Venue Kit purchase qualifies" / "your purchases qualify": one product reads naturally, several stay accurate. */
function qualifyingPhrase(purchase: PurchaseSummary): string {
    const only = purchase.lines.length === 1 ? purchase.lines[0] : undefined;
    return only ? `your ${only.label} purchase qualifies` : "your purchases qualify";
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

type Context = {
    readonly input: FreeYearEmailInput;
    readonly kind: EmailTemplateKind;
    readonly n: number;
    readonly extra: number;
    readonly account: string;
    readonly support: Segment;
    readonly links: readonly StoreLink[];
};

const PLATFORM_BULLETS: readonly Rich[] = [["Android"], ["iOS (iPhone and iPad)"], ["Windows"], ["macOS"]];

const forgotPasswordItem = (): Rich => ["Forgot your password? On the sign-in screen select ", bold("Forgot password?"), " and follow the steps to reset it."];

function introBlocks(ctx: Context): Block[] {
    const common: Rich[] = [
        ["Thank you for being a Discover Your Health Age customer!"],
        ["We’re excited to introduce the new and improved version of Discover Your Health Age, designed to give you a better experience with support across multiple platforms."],
    ];
    const grant: Rich =
        ctx.kind === "existing_customer"
            ? ["As part of this upgrade, we’re giving you 1 full year of FREE access to the new software."]
            : [`As part of this upgrade, ${qualifyingPhrase(ctx.input.purchase)} you for 1 full year of FREE access to the new software.`];
    // The discontinuation notice sits right after the introduction, above the access details, in every template.
    const blocks: Block[] = [{ type: "paragraphs", paragraphs: [...common, grant] }, discontinuationNoticeBlock("purchaser")];

    if (ctx.kind === "existing_customer") {
        blocks.push(
            { type: "heading", text: "What’s New?" },
            { type: "paragraphs", paragraphs: [["The new Discover Your Health Age experience is now available across:"]] },
            { type: "bullets", items: PLATFORM_BULLETS },
            { type: "paragraphs", paragraphs: [["You can now access your HealthAge experience across these supported platforms."]] }
        );
    }
    return blocks;
}

function accessBlocks(ctx: Context): Block[] {
    const { input, kind, n, extra, account } = ctx;
    const start = formatEmailDate(input.startDate);
    const expiry = formatEmailDate(input.expiryDate);
    const blocks: Block[] = [{ type: "heading", text: "Your Free Access" }];

    if (extra > 0) {
        // Workspace route: the owner manages the licenses.
        blocks.push({
            type: "details",
            rows: [
                { label: "Purchase", lines: purchaseRowLines(input.purchase) },
                { label: "Licenses", lines: [count(n, "license")] },
                { label: "Workspace Owner", lines: [account] },
                { label: "Workspace", lines: [input.workspaceName] },
                { label: "Start Date", lines: [start] },
                { label: "Expiry Date", lines: [expiry] },
            ],
        });
        blocks.push(
            { type: "heading", text: `Your ${n} Licenses` },
            { type: "paragraphs", paragraphs: [[`${describePurchase(input.purchase)}:`]] },
            {
                type: "bullets",
                items: [["1 license for you as the workspace owner."], [`${count(extra, "additional license")} for your team members.`]],
            },
            {
                type: "paragraphs",
                paragraphs: [
                    [`You can invite up to ${count(extra, "additional member")} through the HealthAge Admin Portal.`],
                    [`No additional purchase or payment is required for your ${count(n, "license")}.`],
                ],
            },
            { type: "button", label: "Open Admin Portal", url: ADMIN_PORTAL_URL, tone: "gold" }
        );
        return blocks;
    }

    if (kind === "existing_customer") {
        blocks.push(
            { type: "paragraphs", paragraphs: [["Your existing purchase qualifies you for one full year of free access to the new software."]] },
            {
                type: "details",
                rows: [
                    { label: "Access", lines: ["1 Year FREE"] },
                    { label: "Start Date", lines: [start] },
                    { label: "Expiry Date", lines: [expiry] },
                    { label: "Registered Email", lines: [account] },
                ],
            }
        );
        return blocks;
    }

    // Small Venue Kit, one license.
    blocks.push({
        type: "details",
        rows: [
            { label: "Purchase", lines: purchaseRowLines(input.purchase) },
            { label: "Licenses", lines: [count(n, "license")] },
            { label: "Registered Email", lines: [account] },
            { label: "Access Period", lines: ["1 Year FREE"] },
            { label: "Start Date", lines: [start] },
            { label: "Expiry Date", lines: [expiry] },
        ],
    });
    blocks.push({
        type: "paragraphs",
        paragraphs: [
            ["Your Small Venue Kit includes one license for your personal use."],
            ["You do not need to access the Admin Portal or invite additional members."],
        ],
    });
    return blocks;
}

/** One license: the purchaser uses the app directly. No Admin Portal, workspace or invitation instructions. */
function directSteps(ctx: Context): Block[] {
    const { kind, account, links } = ctx;
    const download: Step = { title: "Download the New HealthAge App", body: [], downloads: links };

    const signIn: Step =
        kind === "existing_customer"
            ? {
                  title: "Sign In to Your HealthAge Account",
                  body: [
                      ["Already have a HealthAge account? You do not need to create a new one. Open the new app and sign in using your existing HealthAge email address and password."],
                      ["Important: please use the same email address associated with your original purchase (", bold(account), "). Your free access is linked to this email address."],
                  ],
                  items: [
                      forgotPasswordItem(),
                      ["New to the HealthAge app? Select ", bold("Create Account"), " and register using that same email address."],
                      ["If you already have an account, please do not create a second one."],
                  ],
              }
            : {
                  title: "Open the App and Sign In",
                  body: [],
                  items: [
                      ["Already have a HealthAge account? Sign in using your existing email address and password."],
                      ["New to HealthAge? Select ", bold("Create Account"), " and register using the same email address associated with your purchase (", bold(account), ")."],
                      forgotPasswordItem(),
                  ],
              };

    const start: Step =
        kind === "existing_customer"
            ? {
                  title: "Start Using the New HealthAge App",
                  body: [["Once you sign in, your one-year free access will be activated automatically."], ["No additional purchase or payment is required."]],
              }
            : {
                  title: "Start Using HealthAge",
                  body: [
                      ["Your one-year free access will activate automatically once you sign in with your eligible purchase email."],
                      ["No additional purchase or payment is required."],
                  ],
              };

    return [{ type: "heading", text: "How to Switch to the New Version" }, { type: "steps", steps: [download, signIn, start] }];
}

/** Two or more licenses: the owner manages the workspace in the Admin Portal; members use the app. */
function workspaceSteps(ctx: Context): Block[] {
    const { input, n, extra, account, support, links } = ctx;

    const steps: Step[] = [
        {
            title: "Open the HealthAge Admin Portal",
            body: [["Go to ", { link: ADMIN_PORTAL_URL }, ". This is the official HealthAge Admin Portal, where you manage your workspace."]],
        },
        {
            title: "Sign In to Your Account",
            body: [
                [
                    `Your workspace and ${count(n, "license")} are linked to your purchase email address, so always use `,
                    bold(account),
                    ". There is no approval step and nothing to wait for: as an eligible purchaser you can sign in as soon as your account is created.",
                ],
                ["If you see “Account not authorized”, or your workspace does not appear after you sign in, please contact us at ", support, "."],
            ],
            items: [
                ["Already have a HealthAge account? Sign in using your existing email address and password."],
                [
                    "New to HealthAge? Select ",
                    bold("Sign up"),
                    ", enter your full name, ",
                    bold(account),
                    " as the email and a password of at least 8 characters, then select ",
                    bold("Create account"),
                    ".",
                ],
                ["The full-name field accepts letters, numbers and spaces, and must start with a letter."],
            ],
        },
        {
            title: "Open Your Workspace",
            body: [
                ["After signing in, go to ", bold("My Workspaces"), ". Your workspace is named ", bold(input.workspaceName), "."],
                ["If more than one organization is listed, choose yours in the ", bold("Organization"), " list. Open your workspace to manage your licenses and team members."],
            ],
        },
        {
            title: "Check Your Licenses",
            body: [
                ["Open the ", bold("Manage Organization Members"), " section. At the start it reads ", bold(`1 of ${n} ${n === 1 ? "license" : "licenses"} used`), "."],
                [`Your owner account uses one license, leaving ${count(extra, "license")} available for your team.`],
            ],
        },
        {
            title: "Invite Your Team Members",
            body: [["Select ", bold("Members"), " from the menu. Under ", bold("Invite a Member"), ":"]],
            items: [
                ["Enter the member’s email address."],
                ["Keep the role set to ", bold("member"), "."],
                ["Select ", bold("Invite"), "."],
                [`You can invite up to ${count(extra, "additional member")}: your ${n} licenses minus the one you use.`],
                ["Active members and pending invitations both use a license, so the counter goes up as soon as you send an invitation."],
                ["Each invited member receives an invitation email from HealthAge."],
            ],
        },
        {
            title: "Your Team Members Can Get Started",
            body: [["Each invited member should:"]],
            items: [
                ["Open the invitation email from HealthAge. The invitation is tied to their email address, so there is nothing separate to accept."],
                ["Download the new HealthAge app (links below)."],
                ["Select ", bold("Create Account"), " in the app and register with the invited email address, or select ", bold("Sign In"), " if they already have an account."],
                ["Their allocated license activates automatically. No additional purchase is required."],
            ],
        },
    ];

    return [
        { type: "heading", text: "How to Switch to the New Version" },
        { type: "steps", steps },
        { type: "heading", text: "Download the New HealthAge App" },
        {
            type: "downloads",
            intro: ["Install the app on your device and sign in with ", bold(account), ": your own license activates automatically."],
            links,
        },
    ];
}

function helpLine(ctx: Context): Rich {
    const lead =
        ctx.extra > 0
            ? "If you have any difficulty accessing your workspace or licenses, contact us at "
            : ctx.kind === "existing_customer"
              ? "If you have any difficulty accessing your free entitlement or signing in, contact us at "
              : "If you need assistance, contact us at ";
    return [lead, ctx.support, "."];
}

function buildDocument(input: FreeYearEmailInput): EmailDocument {
    assertValidPurchase(input.purchase);

    const links = configuredStoreLinks(input);
    if (!isSafeHttpUrl(ADMIN_PORTAL_URL)) throw new Error("Refusing to build the email: the Admin Portal URL is not a plain http(s) URL.");

    const n = input.purchase.licenses;
    const ctx: Context = {
        input,
        kind: selectEmailTemplate(input.purchase),
        n,
        extra: n - 1,
        account: input.accountEmail,
        support: isMailbox(input.supportEmail) ? { mail: input.supportEmail } : input.supportEmail,
        links,
    };

    const blocks: Block[] = [...introBlocks(ctx), ...accessBlocks(ctx), ...(ctx.extra > 0 ? workspaceSteps(ctx) : directSteps(ctx))];

    return {
        subject: EMAIL_SUBJECTS[ctx.kind],
        preheader: `1 full year of FREE access to the new Discover Your Health Age app. ${describePurchase(input.purchase)}. Here is how to switch.`,
        title: "Your New HealthAge Experience Is Ready!",
        greeting: `Hi ${input.customerName},`,
        blocks,
        help: helpLine(ctx),
        closing: [
            "Thank you for being part of the Discover Your Health Age community.",
            ctx.extra > 0 ? "We’re excited for you and your team to experience the new HealthAge!" : "We’re excited for you to experience the new HealthAge!",
        ],
        signOff: ["Warm regards,", "Pastor Rodney Bowes", "HealthAge Support Team", "Discover Your Health Age"],
        recipientNote: `This message was sent to ${input.accountEmail} because of your Discover Your Health Age purchase.`,
    };
}

// ---------------------------------------------------------------------------

export function getLegacyFreeYearEmailContent(input: FreeYearEmailInput): FreeYearEmailContent {
    return renderEmailDocument(buildDocument(input));
}
