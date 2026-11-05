/**
 * Free-year grant email for the legacy Shopify customer migration.
 *
 * This is NOT the live Shopify workspace-owner welcome mail. The copy, subject, and
 * placeholders are specific to the historical 2026 upgrade grant.
 *
 * The email is personalised from the customer's actual migration result: their name and
 * sign-in address, workspace name, product(s) and license count, and the real start and
 * expiry dates. It is built from ONE structured model that two renderers consume (a
 * responsive HTML email with inline CSS only, and a complete plain-text version), so the
 * two always say the same thing.
 *
 * Every instruction in the onboarding steps describes something the existing application
 * actually does (verified against the Admin Portal, the backend routes and the mobile
 * app). Do not add a step, a button name or an approval requirement that the product does
 * not have.
 *
 * Store links are configuration, not a single obsolete web URL. Unconfigured platforms
 * are omitted rather than shown empty. Any configured link that is not a plain http(s)
 * URL is refused, never emitted.
 */

/** The approved subject. Unchanged from the plain-text email. */
export const FREE_YEAR_EMAIL_SUBJECT = "Your 1 year of FREE access to the new Discover Your Health Age App";

/**
 * The HealthAge Admin / Workspace Admin portal. Scripts must not import application code,
 * so this repeats `WORKSPACE_ADMIN_URL` from `src/modules/workspace/workspace.links.ts`;
 * a test keeps the two identical.
 */
export const ADMIN_PORTAL_URL = "https://healthage.healthexporesources.com/";

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

type StoreLink = { readonly label: string; readonly url: string };

export function inferMigrationCustomerDisplayName(email: string, explicitName?: string | null): string {
    if (explicitName && explicitName.trim().length > 0) return explicitName.trim();
    const localPart = email.split("@")[0] ?? "there";
    return localPart || "there";
}

export function configuredStoreLinks(input: Pick<FreeYearEmailInput, "androidUrl" | "windowsUrl" | "iosUrl" | "macosUrl">): StoreLink[] {
    const links: StoreLink[] = [];
    if (input.androidUrl?.trim()) links.push({ label: "Android", url: input.androidUrl.trim() });
    if (input.windowsUrl?.trim()) links.push({ label: "Windows", url: input.windowsUrl.trim() });
    if (input.iosUrl?.trim()) links.push({ label: "iOS", url: input.iosUrl.trim() });
    if (input.macosUrl?.trim()) links.push({ label: "macOS", url: input.macosUrl.trim() });
    return links;
}

/** Only plain http(s) URLs may become links. Anything else (javascript:, data:, spaces, quotes) is refused. */
export function isSafeHttpUrl(value: string): boolean {
    return /^https?:\/\/[^\s"'<>`\\]+$/i.test(value);
}

function isMailbox(value: string): boolean {
    return /^[^\s<>"'@]+@[^\s<>"'@]+\.[^\s<>"'@]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-11-04` -> `4 November 2026`. Anything that is not an ISO date (e.g. a sample label) is returned unchanged. */
export function formatEmailDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return value;
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return value;
    return `${day} ${MONTHS[month - 1]} ${match[1]}`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// The structured model
// ---------------------------------------------------------------------------

/** Inline content: plain text, a bold UI label, or a link. Rendered as text or HTML, never concatenated unescaped. */
type Segment = string | { readonly b: string } | { readonly link: string } | { readonly mail: string };
type Rich = readonly Segment[];
const bold = (value: string): Segment => ({ b: value });

type Step = {
    readonly title: string;
    readonly body: readonly Rich[];
    readonly items?: readonly Rich[];
    /** Render the platform download buttons inside this step. */
    readonly downloads?: boolean;
};

type Model = {
    readonly subject: string;
    readonly preheader: string;
    readonly greeting: string;
    readonly intro: readonly string[];
    readonly headline: string;
    readonly summary: ReadonlyArray<{ readonly label: string; readonly lines: readonly string[] }>;
    readonly notice: { readonly title: string; readonly body: readonly string[] };
    readonly portalUrl: string;
    readonly steps: readonly Step[];
    readonly downloads: readonly StoreLink[];
    readonly availableOn: string;
    readonly help: Rich;
    readonly closing: readonly string[];
    readonly signOff: string;
    readonly recipientNote: string;
};

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

/** "Your Large Venue Kit includes 4 licenses." and its variants, always from the real counts. */
function describePurchase(purchase: PurchaseSummary): { headline: string; productLines: string[] } {
    const n = purchase.licenses;
    const only = purchase.lines.length === 1 ? purchase.lines[0] : undefined;

    let headline: string;
    if (only && only.kind === "small_venue_kit") {
        headline =
            only.units === 1
                ? `Your Small Venue Kit includes ${count(n, "license")}.`
                : `Your ${only.units} Small Venue Kits include ${count(n, "license")}.`;
    } else if (only && only.kind === "large_venue_kit") {
        headline =
            only.units === 1
                ? `Your Large Venue Kit includes ${count(n, "license")}.`
                : `Your ${only.units} Large Venue Kits include ${count(n, "license")}.`;
    } else if (only && only.kind === "dyha") {
        headline = `Your Discover Your Health Age purchase includes ${count(n, "license")}.`;
    } else {
        headline = `Your purchases include ${count(n, "license")} in total.`;
    }

    const productLines = purchase.lines.map((line) =>
        line.kind === "dyha"
            ? `${line.label} — ${count(line.licenses, "license")}`
            : `${line.label} × ${line.units} — ${count(line.licenses, "license")}`
    );
    return { headline, productLines };
}

function buildModel(input: FreeYearEmailInput): Model {
    assertValidPurchase(input.purchase);

    const links = configuredStoreLinks(input);
    for (const link of links) {
        if (!isSafeHttpUrl(link.url)) throw new Error(`Refusing to build the email: the ${link.label} link is not a plain http(s) URL.`);
    }
    if (!isSafeHttpUrl(ADMIN_PORTAL_URL)) throw new Error("Refusing to build the email: the Admin Portal URL is not a plain http(s) URL.");

    const n = input.purchase.licenses;
    const extra = n - 1;
    const { headline, productLines } = describePurchase(input.purchase);
    const account = input.accountEmail;
    const support: Segment = isMailbox(input.supportEmail) ? { mail: input.supportEmail } : input.supportEmail;

    const notice =
        extra === 0
            ? {
                  title: "One license, and it’s yours",
                  body: [
                      "As the purchaser you are the workspace owner and you use this license yourself.",
                      "No additional member seats are included with this purchase.",
                  ],
              }
            : {
                  title: `${count(n, "license")}: 1 for you and ${extra} for your team`,
                  body: [
                      `As the purchaser you are the workspace owner, and you use 1 of the ${n} licenses.`,
                      `The other ${count(extra, "license")} can go to up to ${count(extra, "additional member")} you invite from the “Members” section of the Admin Portal. Each additional member signs in to the app with their own account.`,
                  ],
              };

    const steps: Step[] = [
        {
            title: "Open the HealthAge Admin Portal",
            body: [["Go to ", { link: ADMIN_PORTAL_URL }, ". This is the official HealthAge Admin Portal, where you manage your workspace."]],
        },
        {
            title: "Create your account (first time only)",
            body: [
                [
                    "On the sign-in page, choose ",
                    bold("Sign up"),
                    ". Enter your full name, ",
                    bold(account),
                    " as the email, and a password of at least 8 characters, then select ",
                    bold("Create account"),
                    ".",
                ],
            ],
            items: [
                ["Use exactly ", bold(account), ", the email address used for your purchase. Your workspace and licenses are linked to it."],
                ["The full-name field accepts letters, numbers and spaces, and must start with a letter."],
                ["Already have a HealthAge account with this email? Skip this step and sign in."],
            ],
        },
        {
            title: "Sign in",
            body: [
                ["Back on the sign-in page, sign in with ", bold(account), " and your password."],
                [
                    "After you create the account the page may say it “requires admin approval”. For your purchase no extra approval step is needed: your workspace is already set up for this email address, so you should be able to sign in straight away. If you see “Account not authorized”, please contact us at ",
                    support,
                    ".",
                ],
            ],
        },
        {
            title: "Open your workspace",
            body: [
                ["After signing in you land on ", bold("My Workspaces"), ". Your workspace is called ", bold(input.workspaceName), "."],
                ["If more than one organization is listed, choose yours in the ", bold("Organization"), " list."],
            ],
        },
        {
            title: "Check your licenses",
            body: [
                [
                    "The ",
                    bold("Manage Organization Members"),
                    " panel shows how many licenses are in use. At the start it reads ",
                    bold(`1 of ${n} ${n === 1 ? "license" : "licenses"} used`),
                    ": the one in use is yours.",
                ],
            ],
        },
    ];

    if (extra > 0) {
        steps.push(
            {
                title: "Invite your additional members",
                body: [
                    [
                        "Select ",
                        bold("Members"),
                        " in the menu. Under ",
                        bold("Invite a Member"),
                        ", enter the person’s email address, leave ",
                        bold("Role"),
                        " set to ",
                        bold("member"),
                        ", and select ",
                        bold("Invite"),
                        ".",
                    ],
                ],
                items: [
                    [`You can invite up to ${count(extra, "additional member")}: your ${n} licenses minus the one you use.`],
                    ["Active members and pending invitations both use a license, so the counter goes up as soon as you send an invitation."],
                    ["Each person you invite receives an invitation email from HealthAge."],
                ],
            },
            {
                title: "What each additional member does",
                body: [["Each invited person installs the HealthAge app and signs in with their own account, using the email address you invited."]],
                items: [
                    ["New to HealthAge? On the sign-in screen choose ", bold("Create account"), " and register with the invited email address."],
                    ["Already have an account? Just sign in with that email address."],
                    ["Their license activates automatically. No purchase is needed in the app."],
                ],
            }
        );
    }

    steps.push(
        {
            title: "Download HealthAge",
            body: [["Install the app on your device using the buttons below."]],
            downloads: true,
        },
        {
            title: "Sign in to the app and start",
            body: [
                ["Open HealthAge and sign in with ", bold(account), " and the password you created."],
                ["Your license applies automatically. No purchase or checkout is needed in the app."],
            ],
        }
    );

    const summary: Model["summary"] = [
        { label: "Purchase", lines: productLines },
        {
            label: "Licenses",
            lines: [extra === 0 ? "1 in total, used by you as the workspace owner" : `${n} in total (1 for you as the workspace owner, ${extra} for additional members)`],
        },
        { label: "Workspace owner", lines: [account] },
        { label: "Workspace", lines: [input.workspaceName] },
        { label: "Start Date", lines: [formatEmailDate(input.startDate)] },
        { label: "Expires", lines: [formatEmailDate(input.expiryDate)] },
    ];

    return {
        subject: FREE_YEAR_EMAIL_SUBJECT,
        preheader: `${headline} Here is how to get started.`,
        greeting: `Hi ${input.customerName},`,
        intro: [
            "Great news — the new Discover Your Health Age App is ready!",
            "Thank you for purchasing the app in 2026. We’ve been working hard to make the Discover Your Health Age experience even better.",
            "As part of the upgrade, you’re receiving 1 full year of FREE access to the new app.",
        ],
        headline,
        summary,
        notice,
        portalUrl: ADMIN_PORTAL_URL,
        steps,
        downloads: links,
        availableOn: links.map((link) => link.label).join(" • "),
        help: ["Need help? Contact us at ", support, "."],
        closing: [
            "Thank you for being part of the Discover Your Health Age community.",
            "We’re excited for you to experience the new app!",
        ],
        signOff: "- Pastor Rodney Bowes",
        recipientNote: `This message was sent to ${account} because of your 2026 Discover Your Health Age purchase.`,
    };
}

// ---------------------------------------------------------------------------
// Plain-text renderer
// ---------------------------------------------------------------------------

function richText(rich: Rich): string {
    return rich
        .map((segment) => {
            if (typeof segment === "string") return segment;
            if ("b" in segment) return `“${segment.b}”`;
            if ("link" in segment) return segment.link;
            return segment.mail;
        })
        .join("");
}

function renderText(model: Model): string {
    const lines: string[] = [];
    const blank = () => lines.push("");

    lines.push(model.greeting, "");
    for (const paragraph of model.intro) lines.push(paragraph, "");
    lines.push(model.headline, "");

    lines.push("YOUR ACCESS");
    for (const row of model.summary) {
        const [first = "", ...rest] = row.lines;
        lines.push(`${row.label}: ${first}`);
        for (const extraLine of rest) lines.push(`${" ".repeat(row.label.length + 2)}${extraLine}`);
    }
    blank();

    lines.push(model.notice.title);
    for (const paragraph of model.notice.body) lines.push(paragraph);
    blank();

    lines.push("HOW TO GET STARTED", `Open the HealthAge Admin Portal: ${model.portalUrl}`, "");
    model.steps.forEach((step, index) => {
        const number = `${index + 1}. `;
        const pad = " ".repeat(number.length);
        lines.push(`${number}${step.title}`);
        for (const paragraph of step.body) lines.push(`${pad}${richText(paragraph)}`);
        for (const item of step.items ?? []) lines.push(`${pad}- ${richText(item)}`);
        if (step.downloads) {
            if (model.availableOn) lines.push(`${pad}Available on: ${model.availableOn}`);
            for (const link of model.downloads) lines.push(`${pad}${link.label}: ${link.url}`);
        }
        blank();
    });

    lines.push(richText(model.help), "");
    for (const paragraph of model.closing) lines.push(paragraph);
    blank();
    lines.push(model.signOff);
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML renderer: tables + inline CSS only. No <style>, no scripts, no images, no external files.
// ---------------------------------------------------------------------------

const COLOR = {
    navy: "#0B2545",
    navySoft: "#13315C",
    gold: "#C9A227",
    goldSoft: "#FBF6E6",
    ink: "#1F2A44",
    muted: "#5B6577",
    line: "#E3E7EF",
    page: "#F3F5F9",
    white: "#FFFFFF",
} as const;

const SANS = "Arial, Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";
/** Lets long URLs and e-mail addresses wrap on a narrow phone instead of forcing the layout wider. */
const WRAP = "word-break:break-word;overflow-wrap:anywhere;";

function esc(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function richHtml(rich: Rich): string {
    return rich
        .map((segment) => {
            if (typeof segment === "string") return esc(segment);
            if ("b" in segment) return `<strong style="color:${COLOR.navy};">${esc(segment.b)}</strong>`;
            if ("link" in segment) {
                return `<a href="${esc(segment.link)}" target="_blank" rel="noopener" style="color:${COLOR.navySoft};text-decoration:underline;${WRAP}">${esc(segment.link)}</a>`;
            }
            return `<a href="mailto:${esc(segment.mail)}" style="color:${COLOR.navySoft};text-decoration:underline;${WRAP}">${esc(segment.mail)}</a>`;
        })
        .join("");
}

const paragraphHtml = (inner: string, extraStyle = ""): string =>
    `<p style="margin:0 0 12px 0;font-family:${SANS};font-size:15px;line-height:23px;color:${COLOR.ink};${WRAP}${extraStyle}">${inner}</p>`;

function buttonHtml(label: string, url: string, tone: "gold" | "navy"): string {
    const background = tone === "gold" ? COLOR.gold : COLOR.navy;
    const foreground = tone === "gold" ? COLOR.navy : COLOR.white;
    return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%" style="width:100%;max-width:320px;margin:0 auto;">` +
        `<tr><td align="center" bgcolor="${background}" style="background-color:${background};border-radius:6px;padding:14px 20px;">` +
        `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:block;font-family:${SANS};font-size:16px;line-height:20px;font-weight:bold;color:${foreground};text-decoration:none;">${esc(label)}</a>` +
        `</td></tr></table>`
    );
}

function stepHtml(step: Step, number: number, downloads: readonly StoreLink[], availableOn: string): string {
    const body = step.body.map((paragraph) => paragraphHtml(richHtml(paragraph), "margin-bottom:8px;")).join("");
    const items = step.items?.length
        ? `<ul style="margin:0 0 8px 0;padding:0 0 0 20px;">${step.items
              .map((item) => `<li style="font-family:${SANS};font-size:14px;line-height:21px;color:${COLOR.muted};margin:0 0 4px 0;${WRAP}">${richHtml(item)}</li>`)
              .join("")}</ul>`
        : "";
    const buttons = step.downloads
        ? `<p style="margin:4px 0 12px 0;font-family:${SANS};font-size:13px;line-height:19px;color:${COLOR.muted};">${availableOn ? `Available on: ${esc(availableOn)}` : ""}</p>` +
          downloads
              .map((link) => `<div style="padding:0 0 10px 0;">${buttonHtml(`Download for ${link.label}`, link.url, "navy")}</div>`)
              .join("")
        : "";

    return (
        `<tr><td style="padding:0 0 18px 0;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>` +
        `<td width="44" valign="top" style="width:44px;min-width:44px;padding:0;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" bgcolor="${COLOR.gold}" style="background-color:${COLOR.gold};border-radius:15px;width:30px;height:30px;font-family:${SANS};font-size:15px;line-height:30px;font-weight:bold;color:${COLOR.navy};">${number}</td></tr></table>` +
        `</td>` +
        `<td valign="top" style="padding:0;">` +
        `<h3 style="margin:2px 0 8px 0;font-family:${SANS};font-size:16px;line-height:22px;color:${COLOR.navy};">${esc(step.title)}</h3>` +
        body +
        items +
        buttons +
        `</td></tr></table></td></tr>`
    );
}

function renderHtml(model: Model): string {
    const summaryRows = model.summary
        .map(
            (row, index) =>
                `<tr><td valign="top" style="padding:9px 12px 9px 0;${index > 0 ? `border-top:1px solid ${COLOR.line};` : ""}font-family:${SANS};font-size:13px;line-height:19px;color:${COLOR.muted};width:34%;">${esc(row.label)}</td>` +
                `<td valign="top" style="padding:9px 0;${index > 0 ? `border-top:1px solid ${COLOR.line};` : ""}font-family:${SANS};font-size:14px;line-height:20px;font-weight:bold;color:${COLOR.navy};${WRAP}">${row.lines.map(esc).join("<br>")}</td></tr>`
        )
        .join("");

    const steps = model.steps.map((step, index) => stepHtml(step, index + 1, model.downloads, model.availableOn)).join("");

    return (
        `<!DOCTYPE html>` +
        `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">` +
        `<title>${esc(model.subject)}</title></head>` +
        `<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
        `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${COLOR.page};">${esc(model.preheader)}</div>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${COLOR.page}" style="background-color:${COLOR.page};"><tr><td align="center" style="padding:20px 10px;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;">` +
        // ---- header band
        `<tr><td bgcolor="${COLOR.navy}" style="background-color:${COLOR.navy};padding:22px 28px 18px 28px;border-radius:10px 10px 0 0;">` +
        `<div style="font-family:${SERIF};font-size:26px;line-height:30px;font-weight:bold;letter-spacing:0.5px;color:${COLOR.white};">HealthAge</div>` +
        `<div style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:${COLOR.gold};padding-top:2px;">Discover Your Health Age</div>` +
        `</td></tr>` +
        `<tr><td height="4" bgcolor="${COLOR.gold}" style="background-color:${COLOR.gold};height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>` +
        // ---- body
        `<tr><td bgcolor="${COLOR.white}" style="background-color:${COLOR.white};padding:30px 28px 8px 28px;">` +
        `<h1 style="margin:0 0 14px 0;font-family:${SERIF};font-size:27px;line-height:33px;color:${COLOR.navy};">Welcome to the new Discover Your Health Age App</h1>` +
        paragraphHtml(esc(model.greeting), "font-size:16px;") +
        model.intro.map((paragraph) => paragraphHtml(esc(paragraph))).join("") +
        // ---- personalised summary
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0 6px 0;"><tr>` +
        `<td bgcolor="${COLOR.goldSoft}" style="background-color:${COLOR.goldSoft};border-left:4px solid ${COLOR.gold};border-radius:6px;padding:16px 18px;">` +
        `<div style="font-family:${SERIF};font-size:19px;line-height:25px;color:${COLOR.navy};padding-bottom:4px;">${esc(model.headline)}</div>` +
        `<div style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;color:${COLOR.muted};padding:6px 0 4px 0;">Your access</div>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${summaryRows}</table>` +
        `</td></tr></table>` +
        // ---- license note (single license / owner + team)
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 6px 0;"><tr>` +
        `<td style="border:1px solid ${COLOR.line};border-radius:6px;padding:14px 18px;">` +
        `<div style="font-family:${SANS};font-size:15px;line-height:21px;font-weight:bold;color:${COLOR.navy};padding-bottom:6px;">${esc(model.notice.title)}</div>` +
        model.notice.body.map((paragraph) => paragraphHtml(esc(paragraph), "margin-bottom:6px;font-size:14px;line-height:21px;")).join("") +
        `</td></tr></table>` +
        // ---- primary call to action
        `<div style="padding:22px 0 6px 0;text-align:center;">${buttonHtml("Open Admin Portal", model.portalUrl, "gold")}` +
        `<p style="margin:10px 0 0 0;font-family:${SANS};font-size:12px;line-height:18px;color:${COLOR.muted};">Or copy this link: ${richHtml([{ link: model.portalUrl }])}</p></div>` +
        // ---- steps
        `<h2 style="margin:22px 0 14px 0;padding-top:18px;border-top:1px solid ${COLOR.line};font-family:${SERIF};font-size:21px;line-height:27px;color:${COLOR.navy};">How to get started</h2>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${steps}</table>` +
        // ---- help + sign-off
        `<div style="border-top:1px solid ${COLOR.line};padding-top:16px;margin-top:4px;">` +
        paragraphHtml(richHtml(model.help)) +
        model.closing.map((paragraph) => paragraphHtml(esc(paragraph))).join("") +
        paragraphHtml(esc(model.signOff), "margin-top:14px;font-style:italic;color:" + COLOR.navy + ";") +
        `</div></td></tr>` +
        // ---- footer
        `<tr><td bgcolor="${COLOR.navy}" style="background-color:${COLOR.navy};padding:18px 28px;border-radius:0 0 10px 10px;">` +
        `<div style="font-family:${SANS};font-size:12px;line-height:18px;color:#C9D3E3;">${esc(model.recipientNote)}</div>` +
        `<div style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;color:${COLOR.gold};padding-top:8px;">HealthAge · Discover Your Health Age</div>` +
        `</td></tr>` +
        `</table></td></tr></table></body></html>`
    );
}

// ---------------------------------------------------------------------------

export function getLegacyFreeYearEmailContent(input: FreeYearEmailInput): FreeYearEmailContent {
    const model = buildModel(input);
    return { subject: model.subject, text: renderText(model), html: renderHtml(model) };
}
