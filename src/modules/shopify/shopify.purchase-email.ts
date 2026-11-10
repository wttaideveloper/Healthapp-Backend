/**
 * Product-specific purchase confirmation emails for Shopify orders.
 *
 * One email per paid order, built from the shared HealthAge email design system
 * (`src/core/email/email-document.ts`: navy and gold, table layout, inline CSS, a plain-text twin), so it
 * matches the invitation and onboarding emails. There are four templates:
 *
 *   large_venue_kit            Large Venue Kit only      (4 licenses per kit)
 *   small_venue_kit            Small Venue Kit only      (1 license per kit)
 *   discover_your_health_age   Discover Your Health Age  (1 license per purchase; the backend provisions it)
 *   multiple_products          any mix of the above      (ONE consolidated email, one line per product)
 *
 * Two situations, decided by the backend when the order is processed, not guessed here:
 *
 *   new_workspace       first purchase: the workspace was just created. The email keeps the welcome/set-up
 *                       instructions (Admin Portal, sign in or create an account, invite members, get the app).
 *   existing_workspace  a repeat purchase: the licenses were added to the customer's existing workspace. The
 *                       email confirms the purchase and says how many licenses were added and the new total.
 *
 * Pure on purpose (no environment, database, SMTP or Shopify client): `shopify.service.ts` supplies the facts
 * and the per-environment values (store links, support address). Every number printed here comes from the
 * input; the builder refuses to build an email whose numbers do not add up, because a confirmation that states
 * a wrong license count is worse than no email.
 *
 * Wording follows the Admin Portal and the app as they are today (the same verified instructions as the
 * onboarding emails): "My Workspaces", "Manage Organization Members", "1 of N licenses used", Members ->
 * "Invite a Member". Do not add a step or a button name the product does not have.
 */

import {
    bold,
    buildStoreLinks,
    count,
    formatEmailDate,
    isMailbox,
    isSafeHttpUrl,
    renderEmailDocument,
    type Block,
    type DetailRow,
    type EmailDocument,
    type RenderedEmail,
    type Rich,
    type Segment,
    type Step,
    type StoreLink,
} from "../../core/email/email-document";
import { HEALTHAGE_STORE_URLS, HEALTHAGE_SUPPORT_EMAIL, WORKSPACE_ADMIN_URL } from "../workspace/workspace.links";
import type { ShopifyLicensedProduct } from "./shopify.constants";
import { getShopifyLicensedProduct, type ShopifyOrderLineItem } from "./shopify.license";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShopifyPurchaseProductId = ShopifyLicensedProduct["id"];

/** One supported product in the order: units bought and the licenses they gave. */
export type ShopifyPurchaseLine = {
    readonly productId: ShopifyPurchaseProductId;
    /** Customer-facing product name, e.g. "Large Venue Kit". */
    readonly label: string;
    readonly quantity: number;
    /** Licenses this product contributed (quantity x licenses per unit). */
    readonly licenses: number;
};

export type ShopifyPurchaseScenario = "new_workspace" | "existing_workspace";

export type ShopifyPurchaseTemplate = ShopifyPurchaseProductId | "multiple_products";

export type ShopifyPurchaseEmailContent = {
    /** Who the email is sent to: the purchaser's checkout address. */
    readonly recipientEmail: string;
    readonly customerName: string;
    /** As Shopify shows it ("1042" or "#1042"); null when the order has none. */
    readonly orderNumber: string | null;
    readonly scenario: ShopifyPurchaseScenario;
    readonly workspaceName: string;
    /** The address that signs in to the workspace (may differ from the recipient for a repeat purchase). */
    readonly workspaceOwnerEmail: string;
    /** True when a HealthAge account already exists for `workspaceOwnerEmail`. */
    readonly accountExists: boolean;
    readonly lines: readonly ShopifyPurchaseLine[];
    /** Licenses this order added. Must equal the sum of the lines. */
    readonly licensesAdded: number;
    /** Licenses the workspace has now, this order included. */
    readonly workspaceTotalLicenses: number;
    /** When the order was paid (a Date or an ISO date / date-time). */
    readonly purchasedAt: Date | string | null;
    /** When the workspace's access ends (a Date or an ISO date / date-time). */
    readonly accessExpiresAt: Date | string | null;
    /** The order also contained products that are not HealthAge licenses. */
    readonly hasOtherItems: boolean;
};

/**
 * The email's content plus the ids that tie it to an order, for log correlation (never shown to the customer).
 * Everything in it is JSON-safe once the dates are ISO strings, because this is the snapshot the durable outbox
 * stores with the order (`shopify_orders.purchase_email_payload`) in the same transaction that allocates the licenses.
 */
export type ShopifyPurchaseEmail = ShopifyPurchaseEmailContent & {
    readonly workspaceId: string;
    readonly shopifyOrderId: string;
};

export type ShopifyPurchaseEmailInput = ShopifyPurchaseEmailContent & {
    readonly storeUrls?: Partial<Record<"android" | "ios" | "windows" | "macos", string | null | undefined>>;
    readonly supportEmail?: string;
};

// ---------------------------------------------------------------------------
// Subjects and template selection
// ---------------------------------------------------------------------------

export const SHOPIFY_PURCHASE_EMAIL_SUBJECTS: Readonly<Record<ShopifyPurchaseTemplate, string>> = {
    large_venue_kit: "Your HealthAge Large Venue Kit Purchase Is Confirmed!",
    small_venue_kit: "Your HealthAge Small Venue Kit Purchase Is Confirmed!",
    discover_your_health_age: "Thank You for Purchasing Discover Your Health Age!",
    multiple_products: "Your HealthAge Purchase Is Confirmed!",
};

const TEMPLATE_TITLES: Readonly<Record<ShopifyPurchaseTemplate, string>> = {
    large_venue_kit: "Large Venue Kit Purchase Confirmed",
    small_venue_kit: "Small Venue Kit Purchase Confirmed",
    discover_your_health_age: "Welcome to Discover Your Health Age",
    multiple_products: "Your HealthAge Purchase Is Confirmed",
};

/** The noun used in "4 per kit": venue kits are kits, the software is an app. */
const UNIT_NOUN: Readonly<Record<ShopifyPurchaseProductId, string>> = {
    large_venue_kit: "kit",
    small_venue_kit: "kit",
    discover_your_health_age: "app",
};

/** One supported product gets its own template; two or more get the consolidated one. */
export function selectShopifyPurchaseTemplate(lines: readonly Pick<ShopifyPurchaseLine, "productId">[]): ShopifyPurchaseTemplate {
    const ids = new Set(lines.map((line) => line.productId));
    if (ids.size === 1) return [...ids][0]!;
    return "multiple_products";
}

export function shopifyPurchaseEmailSubject(lines: readonly Pick<ShopifyPurchaseLine, "productId">[]): string {
    return SHOPIFY_PURCHASE_EMAIL_SUBJECTS[selectShopifyPurchaseTemplate(lines)];
}

/**
 * The supported products of an order, one line per product (several line items of the same product, such as
 * two variants, are merged), in the order the customer bought them. Unsupported products and zero-quantity
 * lines are left out: they gave no license, so the email must not list them.
 */
export function summarizeShopifyPurchaseLines(lineItems: readonly ShopifyOrderLineItem[]): {
    lines: ShopifyPurchaseLine[];
    hasOtherItems: boolean;
} {
    const byProduct = new Map<ShopifyPurchaseProductId, { label: string; quantity: number; licenses: number }>();
    let hasOtherItems = false;

    for (const item of lineItems) {
        const product = getShopifyLicensedProduct(item.productId);
        if (!product) {
            hasOtherItems = true;
            continue;
        }
        if (item.seatCount <= 0 || item.quantity <= 0) continue;

        const existing = byProduct.get(product.id);
        if (existing) {
            existing.quantity += item.quantity;
            existing.licenses += item.seatCount;
        } else {
            byProduct.set(product.id, { label: product.label, quantity: item.quantity, licenses: item.seatCount });
        }
    }

    return {
        lines: [...byProduct.entries()].map(([productId, value]) => ({ productId, ...value })),
        hasOtherItems,
    };
}

// ---------------------------------------------------------------------------
// Validation and small formatting helpers
// ---------------------------------------------------------------------------

/** One line of text: strips anything that could break a header or a sentence. */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

function assertValid(input: ShopifyPurchaseEmailContent): void {
    if (!isMailbox(input.recipientEmail)) {
        throw new Error("Refusing to build the purchase email: the recipient is not a valid email address.");
    }
    if (input.lines.length === 0) {
        throw new Error("Refusing to build the purchase email: the order has no HealthAge products.");
    }
    for (const line of input.lines) {
        const perUnit = line.licenses / line.quantity;
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || !Number.isInteger(perUnit) || perUnit < 1) {
            throw new Error(`Refusing to build the purchase email: the ${line.label} line has inconsistent quantity or license numbers.`);
        }
    }
    const sum = input.lines.reduce((total, line) => total + line.licenses, 0);
    if (!Number.isInteger(input.licensesAdded) || input.licensesAdded < 1 || sum !== input.licensesAdded) {
        throw new Error(
            `Refusing to build the purchase email: the product lines add up to ${sum} license(s) but the order allocated ${input.licensesAdded}. The email must never state a wrong number.`
        );
    }
    if (!Number.isInteger(input.workspaceTotalLicenses) || input.workspaceTotalLicenses < input.licensesAdded) {
        throw new Error("Refusing to build the purchase email: the workspace total is smaller than the licenses this order added.");
    }
}

function isoDay(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const text = value instanceof Date ? (Number.isNaN(value.getTime()) ? "" : value.toISOString()) : value;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    return match ? match[1]! : null;
}

/** "1042" and "#1042" both become "#1042". */
function orderLabelOf(orderNumber: string | null): string | null {
    const trimmed = orderNumber ? oneLine(orderNumber) : "";
    if (!trimmed) return null;
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

const productLine = (line: ShopifyPurchaseLine): string => `${line.label} × ${line.quantity}`;

/** "8 licenses (4 per kit × 2)" / "4 licenses (4 per kit)". */
function licenseFormula(line: ShopifyPurchaseLine): string {
    const perUnit = line.licenses / line.quantity;
    return `${count(line.licenses, "license")} (${perUnit} per ${UNIT_NOUN[line.productId]}${line.quantity > 1 ? ` × ${line.quantity}` : ""})`;
}

function storeLinksFor(input: ShopifyPurchaseEmailInput): StoreLink[] {
    const urls = input.storeUrls ?? {};
    return buildStoreLinks({
        android: urls.android?.trim() || HEALTHAGE_STORE_URLS.android,
        ios: urls.ios?.trim() || HEALTHAGE_STORE_URLS.ios,
        windows: urls.windows?.trim() || HEALTHAGE_STORE_URLS.windows,
        macos: urls.macos?.trim() || HEALTHAGE_STORE_URLS.macos,
    });
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

type Context = {
    readonly input: ShopifyPurchaseEmailInput;
    readonly template: ShopifyPurchaseTemplate;
    readonly isNew: boolean;
    readonly orderLabel: string | null;
    /** The licenses this order added / the workspace has now. */
    readonly added: number;
    readonly total: number;
    /** Two or more licenses: the owner manages a team in the Admin Portal. One license: the person just uses the app. */
    readonly teamRoute: boolean;
    readonly account: string;
    readonly support: Segment;
    readonly links: readonly StoreLink[];
};

const forgotPasswordItem = (): Rich => ["Forgot your password? On the sign-in screen select ", bold("Forgot password?"), " and follow the steps to reset it."];

function introParagraphs(ctx: Context): Rich[] {
    const { input, template, isNew } = ctx;
    const only = input.lines.length === 1 ? input.lines[0]! : undefined;
    const subject: Segment = only ? bold(only.label) : "your HealthAge products";

    if (isNew) {
        if (template === "discover_your_health_age" && !ctx.teamRoute) {
            return [["Thank you for purchasing ", subject, "! Your payment has been received and your Pro access is ready to activate."]];
        }
        return [["Thank you for purchasing ", subject, "! Your payment has been received and your HealthAge workspace is ready."]];
    }
    const what: Rich = only ? ["The licenses for your ", bold(only.label)] : ["The licenses for your new products"];
    return [
        ["Thank you for your purchase! Your payment has been received."],
        [...what, " have been added to your existing HealthAge workspace, ", bold(oneLine(input.workspaceName)), ". They are active now, and no further payment is needed."],
    ];
}

function orderDetailRows(ctx: Context): DetailRow[] {
    const { input, orderLabel } = ctx;
    const rows: DetailRow[] = [];
    const purchased = isoDay(input.purchasedAt);
    const expiry = isoDay(input.accessExpiresAt);
    const only = input.lines.length === 1 ? input.lines[0]! : undefined;

    if (orderLabel) rows.push({ label: "Order number", lines: [orderLabel] });
    if (purchased) rows.push({ label: "Order date", lines: [formatEmailDate(purchased)] });

    if (only) {
        rows.push({ label: "Product", lines: [productLine(only)] }, { label: "Licenses", lines: [licenseFormula(only)] });
    } else {
        rows.push({ label: "Products", lines: input.lines.map((line) => `${productLine(line)} — ${count(line.licenses, "license")}`) });
    }

    // A single-license app purchase is a personal purchase: no workspace details to show.
    const showWorkspace = ctx.teamRoute || ctx.template !== "discover_your_health_age" || !ctx.isNew;
    if (showWorkspace) {
        rows.push({ label: "Workspace", lines: [oneLine(input.workspaceName)] });
        rows.push({ label: "Workspace administrator", lines: [ctx.account] });
    } else {
        rows.push({ label: "Registered email", lines: [ctx.account] });
    }
    if (expiry) rows.push({ label: "Access until", lines: [formatEmailDate(expiry)] });
    return rows;
}

function highlightBlock(ctx: Context): Block | null {
    const { template, isNew, added, total } = ctx;
    const show = template !== "discover_your_health_age" || added >= 2 || !isNew;
    if (!show) return null;

    const label = `${added === 1 ? "license" : "licenses"} added to your workspace`;
    let caption: string;
    if (!isNew) {
        caption = `Your workspace now has ${count(total, "license")} in total.`;
    } else if (total >= 2) {
        caption = `Your new workspace includes ${count(total, "license")}: 1 for you as the workspace owner and ${count(total - 1, "license")} for your team.`;
    } else {
        caption = "Your workspace includes 1 license, for your own use.";
    }
    return { type: "highlight", value: String(added), label, caption };
}

// ---- steps ----------------------------------------------------------------

const portalStep = (): Step => ({
    title: "Open the HealthAge Admin Portal",
    body: [["Go to ", { link: WORKSPACE_ADMIN_URL }, ". This is where you manage your workspace and its members."]],
});

function signInStep(ctx: Context): Step {
    const { account, support } = ctx;
    if (ctx.input.accountExists) {
        return {
            title: "Sign in to your account",
            body: [
                ["You already have a HealthAge account. Sign in with ", bold(account), ": your workspace is linked to this email address."],
                ["If your workspace does not appear after you sign in, please contact us at ", support, "."],
            ],
            items: [forgotPasswordItem()],
        };
    }
    return {
        title: "Create your account",
        body: [
            [
                "Your workspace is linked to ",
                bold(account),
                ", so always use this exact address. There is no approval step and nothing to wait for: as soon as your account is created you can sign in.",
            ],
            ["If you see “Account not authorized”, or your workspace does not appear after you sign in, please contact us at ", support, "."],
        ],
        items: [
            ["New to HealthAge? Select ", bold("Sign up"), ", enter your full name, ", bold(account), " as the email and a password of at least 8 characters, then select ", bold("Create account"), "."],
            ["The full-name field accepts letters, numbers and spaces, and must start with a letter."],
            ["Already have a HealthAge account with this address? Just sign in; please do not create a second one."],
        ],
    };
}

function workspaceStep(ctx: Context): Step {
    const { input, total } = ctx;
    return {
        title: ctx.isNew ? "Open your workspace" : "Check your licenses",
        body: [
            ["After signing in, go to ", bold("My Workspaces"), ". Your workspace is named ", bold(oneLine(input.workspaceName)), "."],
            ["Open it and look at ", bold("Manage Organization Members"), ": it shows how many of your ", bold(`${total} ${total === 1 ? "license" : "licenses"}`), " are in use."],
        ],
    };
}

function inviteStep(ctx: Context): Step {
    const extra = ctx.total - 1;
    return {
        title: "Invite your team members",
        body: [["Select ", bold("Members"), " from the menu. Under ", bold("Invite a Member"), ":"]],
        items: [
            ["Enter the member’s email address and keep the role set to ", bold("member"), "."],
            ["Select ", bold("Invite"), `. You can invite up to ${count(extra, "additional member")}: your ${ctx.total} licenses minus the one you use.`],
            ["Active members and pending invitations both use a license."],
            ["Each invited member gets an invitation email, then signs in to the app with that email address."],
        ],
    };
}

function downloadStep(ctx: Context, title = "Download the HealthAge app"): Step {
    return {
        title,
        body: [["Install the app on your device and sign in with ", bold(ctx.account), ": your own license activates automatically."]],
        downloads: ctx.links,
    };
}

/** One license, new customer: no portal, no team. Download, sign in or create an account, start. */
function directSteps(ctx: Context): Step[] {
    const { account, input } = ctx;
    return [
        { title: "Download the HealthAge app", body: [], downloads: ctx.links },
        {
            title: input.accountExists ? "Sign in" : "Create your account or sign in",
            body: [["Open the app, then:"]],
            items: input.accountExists
                ? [["You already have a HealthAge account. Select ", bold("Sign In"), " and use ", bold(account), "."], forgotPasswordItem()]
                : [
                      ["New to HealthAge? Select ", bold("Create Account"), " and register with ", bold(account), "."],
                      ["Already have an account with this address? Select ", bold("Sign In"), " instead; please do not create a second one."],
                  ],
        },
        {
            title: "Start using HealthAge",
            body: [["Your license activates automatically once you sign in with ", bold(account), ". No additional purchase or payment is required."]],
        },
    ];
}

function accessBlocks(ctx: Context): Block[] {
    if (!ctx.teamRoute) {
        return [{ type: "heading", text: "Get Started" }, { type: "steps", steps: directSteps(ctx) }];
    }

    // A team workspace. A new customer, or one who has no account yet, gets the full set-up; a returning customer
    // who already signs in only needs to know where to see and use the new licenses.
    const needsSetup = ctx.isNew || !ctx.input.accountExists;
    const steps: Step[] = [portalStep()];
    if (needsSetup) steps.push(signInStep(ctx));
    steps.push(workspaceStep(ctx), inviteStep(ctx));
    if (needsSetup) steps.push(downloadStep(ctx));

    return [{ type: "heading", text: ctx.isNew ? "Get Started" : "Using Your Licenses" }, { type: "steps", steps }];
}

function buildDocument(input: ShopifyPurchaseEmailInput): EmailDocument {
    assertValid(input);
    if (!isSafeHttpUrl(WORKSPACE_ADMIN_URL)) throw new Error("Refusing to build the purchase email: the Admin Portal URL is not a plain http(s) URL.");

    const template = selectShopifyPurchaseTemplate(input.lines);
    const orderLabel = orderLabelOf(input.orderNumber);
    const supportAddress = input.supportEmail?.trim() || HEALTHAGE_SUPPORT_EMAIL;
    const ctx: Context = {
        input,
        template,
        isNew: input.scenario === "new_workspace",
        orderLabel,
        added: input.licensesAdded,
        total: input.workspaceTotalLicenses,
        teamRoute: input.workspaceTotalLicenses >= 2,
        account: input.workspaceOwnerEmail,
        support: isMailbox(supportAddress) ? { mail: supportAddress } : supportAddress,
        links: storeLinksFor(input),
    };

    const productSummary = input.lines.map(productLine).join(", ");
    const blocks: Block[] = [
        {
            type: "confirmation",
            title: "Payment received. Thank you!",
            subtitle: `${orderLabel ? `Order ${orderLabel} · ` : ""}${productSummary}`,
        },
        { type: "paragraphs", paragraphs: introParagraphs(ctx) },
        { type: "heading", text: "Your Order" },
        { type: "details", rows: orderDetailRows(ctx) },
    ];

    const highlight = highlightBlock(ctx);
    if (highlight) blocks.push(highlight);

    // The primary call to action: the Admin Portal wherever there is a workspace to manage.
    if (ctx.teamRoute) blocks.push({ type: "button", label: "Open Admin Portal", url: WORKSPACE_ADMIN_URL, tone: "gold" });

    blocks.push(...accessBlocks(ctx));

    if (input.hasOtherItems) {
        blocks.push({
            type: "callout",
            title: "Other items in your order",
            paragraphs: [["Your order also included other items. Those are covered by the separate order confirmation email from our online store."]],
        });
    }

    const preheader = ctx.isNew
        ? `Your payment has been received. ${productSummary}${ctx.teamRoute ? ` · ${count(ctx.added, "license")}` : ""}. Here is how to get started.`
        : `${count(ctx.added, "license")} added to your workspace. It now has ${count(ctx.total, "license")} in total.`;

    return {
        subject: SHOPIFY_PURCHASE_EMAIL_SUBJECTS[template],
        preheader,
        title: TEMPLATE_TITLES[template],
        greeting: `Hello ${oneLine(input.customerName) || "there"},`,
        blocks,
        help: ["Questions about your order or your licenses? Contact us at ", ctx.support, orderLabel ? ` and mention order ${orderLabel}.` : "."],
        closing: ["Thank you for choosing HealthAge."],
        signOff: ["Warm regards,", "The HealthAge Team"],
        recipientNote: `This message was sent to ${input.recipientEmail} because of your HealthAge purchase${orderLabel ? ` (order ${orderLabel})` : ""}.`,
    };
}

export function buildShopifyPurchaseEmail(input: ShopifyPurchaseEmailInput): RenderedEmail {
    return renderEmailDocument(buildDocument(input));
}
