/**
 * HealthAge email design system: one structured document, two renderers.
 *
 * Every customer email (the legacy-customer onboarding emails and the workspace invitation
 * emails) is described as an `EmailDocument` made of a few block types. `renderEmailDocument`
 * turns it into a responsive HTML email (tables and inline CSS only: no <style>, no scripts, no
 * remote images, no fonts to load) and a complete plain-text version, from the same data, so the
 * two always say the same thing.
 *
 * This module is a PURE LEAF on purpose: it has no imports, so it can be used by the API and by
 * the one-off migration scripts without pulling in environment validation, the database or an SMTP
 * client. A test keeps it that way.
 *
 * Every dynamic value is escaped in HTML. A URL only becomes a link if it is a plain http(s) URL.
 */

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

/** Inline content: plain text, a bold UI label, a link or a mailto link. Never concatenated unescaped. */
export type Segment = string | { readonly b: string } | { readonly link: string } | { readonly mail: string };
export type Rich = readonly Segment[];

export const bold = (value: string): Segment => ({ b: value });

export type StoreLink = { readonly label: string; readonly url: string };

export type DetailRow = { readonly label: string; readonly lines: readonly string[] };

export type Step = {
    readonly title: string;
    readonly body: readonly Rich[];
    readonly items?: readonly Rich[];
    /** Render the platform download buttons inside this step. */
    readonly downloads?: readonly StoreLink[];
};

export type Block =
    /** Body text. */
    | { readonly type: "paragraphs"; readonly paragraphs: readonly Rich[] }
    /** A section heading (an <h2>; upper-case in the text version). */
    | { readonly type: "heading"; readonly text: string }
    | { readonly type: "bullets"; readonly items: readonly Rich[] }
    /** A highlighted card of "Label: value" rows (purchase, licenses, dates). */
    | { readonly type: "details"; readonly rows: readonly DetailRow[] }
    /** A bordered note with a bold title. */
    | { readonly type: "callout"; readonly title: string; readonly paragraphs: readonly Rich[] }
    /**
     * A prominent announcement: a navy panel with a gold rule and title and ivory text. Plain text only
     * (no bold or links), because those are coloured for a light background and would vanish on navy.
     */
    | { readonly type: "notice"; readonly title: string; readonly paragraphs: readonly string[] }
    /**
     * A confirmation strip: a gold check mark, a bold line and a muted line underneath
     * (e.g. "Payment received" / "Order #1042"). Plain text only.
     */
    | { readonly type: "confirmation"; readonly title: string; readonly subtitle: string }
    /**
     * One key figure in a navy panel with a gold rule: a big value, a small label and an optional sentence
     * (e.g. "4" / "licenses added to your workspace"). Plain text only (it sits on navy, like `notice`).
     */
    | { readonly type: "highlight"; readonly value: string; readonly label: string; readonly caption?: string }
    /** Numbered steps (numbering restarts at 1 for each steps block). */
    | { readonly type: "steps"; readonly steps: readonly Step[] }
    /** A line of text followed by one download button per platform. */
    | { readonly type: "downloads"; readonly intro: Rich; readonly links: readonly StoreLink[] }
    /** A primary call-to-action button with its link repeated as text underneath. */
    | { readonly type: "button"; readonly label: string; readonly url: string; readonly tone: "gold" | "navy" };

export type EmailDocument = {
    readonly subject: string;
    /** Hidden inbox preview text. */
    readonly preheader: string;
    /** The big heading. */
    readonly title: string;
    readonly greeting: string;
    readonly blocks: readonly Block[];
    readonly help: Rich;
    readonly closing: readonly string[];
    /** One line each, e.g. "Warm regards,", "Pastor Rodney Bowes", ... */
    readonly signOff: readonly string[];
    readonly recipientNote: string;
};

export type RenderedEmail = {
    readonly subject: string;
    readonly text: string;
    readonly html: string;
};

// ---------------------------------------------------------------------------
// Small helpers shared by the email builders
// ---------------------------------------------------------------------------

/** Only plain http(s) URLs may become links. Anything else (javascript:, data:, spaces, quotes) is refused. */
export function isSafeHttpUrl(value: string): boolean {
    return /^https?:\/\/[^\s"'<>`\\]+$/i.test(value);
}

export function isMailbox(value: string): boolean {
    return /^[^\s<>"'@]+@[^\s<>"'@]+\.[^\s<>"'@]+$/.test(value);
}

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

export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The platforms, in the order customers see them. */
export const STORE_PLATFORM_ORDER = ["Android", "iOS", "Windows", "macOS"] as const;

/** Builds the platform links in the standard order, skipping unset ones and refusing unsafe ones. */
export function buildStoreLinks(urls: {
    readonly android?: string | null;
    readonly ios?: string | null;
    readonly windows?: string | null;
    readonly macos?: string | null;
}): StoreLink[] {
    const byLabel: Record<(typeof STORE_PLATFORM_ORDER)[number], string | null | undefined> = {
        Android: urls.android,
        iOS: urls.ios,
        Windows: urls.windows,
        macOS: urls.macos,
    };
    const links: StoreLink[] = [];
    for (const label of STORE_PLATFORM_ORDER) {
        const url = byLabel[label]?.trim();
        if (!url) continue;
        if (!isSafeHttpUrl(url)) throw new Error(`Refusing to build the email: the ${label} link is not a plain http(s) URL.`);
        links.push({ label, url });
    }
    return links;
}

// ---------------------------------------------------------------------------
// The discontinuation notice (shared copy, so every email says exactly the same thing)
// ---------------------------------------------------------------------------

export const DISCONTINUATION_NOTICE_TITLE = "Important: Discontinuation of the Previous HealthAge Software";

const DISCONTINUATION_NOTICE_LEAD =
    "We are discontinuing the previous version of HealthAge and transitioning all users to our new and improved HealthAge application. The old software will no longer be supported. Please switch to the new HealthAge application to continue enjoying your HealthAge services.";

/** For someone whose own purchase includes the free year (the onboarding emails). */
export const DISCONTINUATION_NOTICE_PURCHASER = `${DISCONTINUATION_NOTICE_LEAD} Your existing purchase includes one year of free access to the new version.`;

/** For an invited member, whose organization made the purchase (the workspace invitation email). */
export const DISCONTINUATION_NOTICE_MEMBER = `${DISCONTINUATION_NOTICE_LEAD} Your organization’s existing purchase includes one year of free access to the new version.`;

/**
 * The announcement that the previous HealthAge software is being discontinued. It gives no date and does not
 * say the old software is already switched off: it says it is being discontinued and will no longer be supported.
 */
export function discontinuationNoticeBlock(audience: "purchaser" | "member" = "purchaser"): Block {
    return {
        type: "notice",
        title: DISCONTINUATION_NOTICE_TITLE,
        paragraphs: [audience === "member" ? DISCONTINUATION_NOTICE_MEMBER : DISCONTINUATION_NOTICE_PURCHASER],
    };
}

// ---------------------------------------------------------------------------
// Plain-text renderer
// ---------------------------------------------------------------------------

/** Frames a notice in the plain-text version so it stands out the way the navy panel does in HTML. */
const NOTICE_RULE = "=".repeat(60);

export function richText(rich: Rich): string {
    return rich
        .map((segment) => {
            if (typeof segment === "string") return segment;
            if ("b" in segment) return `“${segment.b}”`;
            if ("link" in segment) return segment.link;
            return segment.mail;
        })
        .join("");
}

const availableOn = (links: readonly StoreLink[]): string => links.map((link) => link.label).join(" • ");

function renderText(doc: EmailDocument): string {
    const lines: string[] = [];
    const blank = () => lines.push("");

    lines.push(doc.greeting, "", doc.title, "");

    for (const block of doc.blocks) {
        switch (block.type) {
            case "paragraphs":
                for (const paragraph of block.paragraphs) lines.push(richText(paragraph), "");
                break;
            case "heading":
                lines.push(block.text.toUpperCase());
                break;
            case "bullets":
                for (const item of block.items) lines.push(`- ${richText(item)}`);
                blank();
                break;
            case "details":
                for (const row of block.rows) {
                    const [first = "", ...rest] = row.lines;
                    lines.push(`${row.label}: ${first}`);
                    for (const more of rest) lines.push(`${" ".repeat(row.label.length + 2)}${more}`);
                }
                blank();
                break;
            case "callout":
                lines.push(block.title);
                for (const paragraph of block.paragraphs) lines.push(richText(paragraph));
                blank();
                break;
            case "notice":
                lines.push(NOTICE_RULE, block.title, "");
                for (const paragraph of block.paragraphs) lines.push(paragraph);
                lines.push(NOTICE_RULE, "");
                break;
            case "confirmation":
                lines.push(block.title, block.subtitle, "");
                break;
            case "highlight":
                lines.push(NOTICE_RULE, `${block.value} ${block.label.toUpperCase()}`);
                if (block.caption) lines.push(block.caption);
                lines.push(NOTICE_RULE, "");
                break;
            case "steps":
                block.steps.forEach((step, index) => {
                    const number = `${index + 1}. `;
                    const pad = " ".repeat(number.length);
                    lines.push(`${number}${step.title}`);
                    for (const paragraph of step.body) lines.push(`${pad}${richText(paragraph)}`);
                    for (const item of step.items ?? []) lines.push(`${pad}- ${richText(item)}`);
                    if (step.downloads) {
                        if (step.downloads.length > 0) lines.push(`${pad}Available on: ${availableOn(step.downloads)}`);
                        for (const link of step.downloads) lines.push(`${pad}${link.label}: ${link.url}`);
                    }
                    blank();
                });
                break;
            case "downloads":
                lines.push(richText(block.intro));
                for (const link of block.links) lines.push(`${link.label}: ${link.url}`);
                blank();
                break;
            case "button":
                lines.push(`${block.label}: ${block.url}`, "");
                break;
        }
    }

    lines.push(richText(doc.help), "");
    for (const paragraph of doc.closing) lines.push(paragraph);
    blank();
    for (const line of doc.signOff) lines.push(line);
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML renderer: tables + inline CSS only.
// ---------------------------------------------------------------------------

export const COLOR = {
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

export function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const esc = escapeHtml;

export function richHtml(rich: Rich): string {
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

/**
 * Widths for a row of the details card (a label and its value). Both are `width:100%` with a pixel `max-width`:
 * with room (labelMaxPx + valueMaxPx = 498px, a card 504px wide at the 600px email width) they sit side by side; in
 * anything narrower (a phone's card is 259px wide at 375px, 204px at 320px) each takes the full width and the value
 * stacks under its label. Because they only ever shrink to the card's width, nothing overflows at any screen size.
 * `labelPercentMso` is the label column for Outlook for Windows, which gets a table instead. A test keeps this
 * arithmetic true.
 */
export const DETAILS_LAYOUT = { labelMaxPx: 168, valueMaxPx: 330, labelPercentMso: 34 } as const;

const downloadButtons = (links: readonly StoreLink[]): string =>
    links.map((link) => `<div style="padding:0 0 10px 0;">${buttonHtml(`Download for ${link.label}`, link.url, "navy")}</div>`).join("");

function stepHtml(step: Step, number: number): string {
    const body = step.body.map((paragraph) => paragraphHtml(richHtml(paragraph), "margin-bottom:8px;")).join("");
    const items = step.items?.length
        ? `<ul style="margin:0 0 8px 0;padding:0 0 0 20px;">${step.items
              .map((item) => `<li style="font-family:${SANS};font-size:14px;line-height:21px;color:${COLOR.muted};margin:0 0 4px 0;${WRAP}">${richHtml(item)}</li>`)
              .join("")}</ul>`
        : "";
    const buttons = step.downloads
        ? `<p style="margin:4px 0 12px 0;font-family:${SANS};font-size:13px;line-height:19px;color:${COLOR.muted};">${
              step.downloads.length > 0 ? `Available on: ${esc(availableOn(step.downloads))}` : ""
          }</p>` + downloadButtons(step.downloads)
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

function blockHtml(block: Block): string {
    switch (block.type) {
        case "paragraphs":
            return block.paragraphs.map((paragraph) => paragraphHtml(richHtml(paragraph))).join("");
        case "heading":
            return `<h2 style="margin:22px 0 14px 0;padding-top:18px;border-top:1px solid ${COLOR.line};font-family:${SERIF};font-size:21px;line-height:27px;color:${COLOR.navy};">${esc(block.text)}</h2>`;
        case "bullets":
            return `<ul style="margin:0 0 12px 0;padding:0 0 0 22px;">${block.items
                .map((item) => `<li style="font-family:${SANS};font-size:15px;line-height:23px;color:${COLOR.ink};margin:0 0 4px 0;${WRAP}">${richHtml(item)}</li>`)
                .join("")}</ul>`;
        case "details": {
            // A fluid hybrid row: label and value are inline-blocks that are `width:100%` with a pixel `max-width`. When the
            // card is wide enough they sit side by side at those maximums (the desktop layout); when it is narrower, each one
            // takes the full width and the value drops below its label, so nothing can overflow and a long address is not
            // broken mid-word. No media query is used (many mail clients strip them). The conditional comments give Outlook
            // for Windows, which ignores inline-block, a two-column table instead; every other client sees only comments.
            const { labelMaxPx, valueMaxPx, labelPercentMso } = DETAILS_LAYOUT;
            const rows = block.rows
                .map(
                    (row, index) =>
                        `<div style="${index > 0 ? `border-top:1px solid ${COLOR.line};` : ""}padding:9px 0;font-size:0;line-height:0;">` +
                        `<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="${labelPercentMso}%" valign="top"><![endif]-->` +
                        `<div style="display:inline-block;width:100%;max-width:${labelMaxPx}px;vertical-align:top;">` +
                        `<div style="padding:0 12px 2px 0;font-family:${SANS};font-size:13px;line-height:19px;color:${COLOR.muted};">${esc(row.label)}</div></div>` +
                        `<!--[if mso]></td><td width="${100 - labelPercentMso}%" valign="top"><![endif]-->` +
                        `<div style="display:inline-block;width:100%;max-width:${valueMaxPx}px;vertical-align:top;">` +
                        `<div style="font-family:${SANS};font-size:14px;line-height:20px;font-weight:bold;color:${COLOR.navy};${WRAP}">${row.lines.map(esc).join("<br>")}</div></div>` +
                        `<!--[if mso]></td></tr></table><![endif]-->` +
                        `</div>`
                )
                .join("");
            return (
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 14px 0;"><tr>` +
                `<td bgcolor="${COLOR.goldSoft}" style="background-color:${COLOR.goldSoft};border-left:4px solid ${COLOR.gold};border-radius:6px;padding:10px 18px;">${rows}</td>` +
                `</tr></table>`
            );
        }
        case "callout":
            return (
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 10px 0;"><tr>` +
                `<td style="border:1px solid ${COLOR.line};border-radius:6px;padding:14px 18px;">` +
                `<div style="font-family:${SANS};font-size:15px;line-height:21px;font-weight:bold;color:${COLOR.navy};padding-bottom:6px;">${esc(block.title)}</div>` +
                block.paragraphs.map((paragraph) => paragraphHtml(richHtml(paragraph), "margin-bottom:6px;font-size:14px;line-height:21px;")).join("") +
                `</td></tr></table>`
            );
        case "notice":
            // Navy panel, gold rule and title, ivory text: the strongest element in the email, in the brand colours.
            return (
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0 12px 0;"><tr>` +
                `<td bgcolor="${COLOR.navy}" style="background-color:${COLOR.navy};border-top:4px solid ${COLOR.gold};border-radius:6px;padding:20px 22px;">` +
                `<div style="font-family:${SERIF};font-size:20px;line-height:26px;font-weight:bold;color:${COLOR.gold};padding-bottom:10px;${WRAP}">${esc(block.title)}</div>` +
                block.paragraphs
                    .map((paragraph) => `<p style="margin:0 0 6px 0;font-family:${SANS};font-size:15px;line-height:24px;color:${COLOR.goldSoft};${WRAP}">${esc(paragraph)}</p>`)
                    .join("") +
                `</td></tr></table>`
            );
        case "confirmation":
            // A soft gold-tinted strip: a gold check disc beside a bold line and a muted line. Two cells, no fixed widths
            // beyond the 44px disc column, so it holds together on a phone.
            return (
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 18px 0;"><tr>` +
                `<td bgcolor="${COLOR.goldSoft}" style="background-color:${COLOR.goldSoft};border:1px solid ${COLOR.gold};border-radius:8px;padding:14px 16px;">` +
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>` +
                `<td width="48" valign="middle" style="width:48px;min-width:48px;padding:0;">` +
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" bgcolor="${COLOR.gold}" style="background-color:${COLOR.gold};border-radius:18px;width:36px;height:36px;font-family:${SANS};font-size:19px;line-height:36px;font-weight:bold;color:${COLOR.navy};">&#10003;</td></tr></table>` +
                `</td>` +
                `<td valign="middle" style="padding:0;">` +
                `<div style="font-family:${SANS};font-size:16px;line-height:22px;font-weight:bold;color:${COLOR.navy};${WRAP}">${esc(block.title)}</div>` +
                `<div style="font-family:${SANS};font-size:14px;line-height:21px;color:${COLOR.muted};${WRAP}">${esc(block.subtitle)}</div>` +
                `</td></tr></table></td></tr></table>`
            );
        case "highlight":
            // The key figure: big gold number on navy, a small spaced label in white, an optional sentence in ivory.
            return (
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 18px 0;"><tr>` +
                `<td align="center" bgcolor="${COLOR.navy}" style="background-color:${COLOR.navy};border-top:4px solid ${COLOR.gold};border-radius:6px;padding:22px 22px 20px 22px;">` +
                `<div style="font-family:${SERIF};font-size:52px;line-height:56px;font-weight:bold;color:${COLOR.gold};">${esc(block.value)}</div>` +
                `<div style="font-family:${SANS};font-size:13px;line-height:19px;letter-spacing:2px;text-transform:uppercase;color:${COLOR.white};padding-top:4px;${WRAP}">${esc(block.label)}</div>` +
                (block.caption
                    ? `<p style="margin:12px 0 0 0;font-family:${SANS};font-size:15px;line-height:23px;color:${COLOR.goldSoft};${WRAP}">${esc(block.caption)}</p>`
                    : "") +
                `</td></tr></table>`
            );
        case "steps":
            return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${block.steps.map((step, index) => stepHtml(step, index + 1)).join("")}</table>`;
        case "downloads":
            return paragraphHtml(richHtml(block.intro)) + `<div style="padding:4px 0 0 0;">${downloadButtons(block.links)}</div>`;
        case "button":
            return (
                `<div style="padding:18px 0 6px 0;text-align:center;">${buttonHtml(block.label, block.url, block.tone)}` +
                `<p style="margin:10px 0 0 0;font-family:${SANS};font-size:12px;line-height:18px;color:${COLOR.muted};${WRAP}">Or copy this link: ${richHtml([{ link: block.url }])}</p></div>`
            );
    }
}

function renderHtml(doc: EmailDocument): string {
    return (
        `<!DOCTYPE html>` +
        `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">` +
        `<title>${esc(doc.subject)}</title></head>` +
        `<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
        `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${COLOR.page};">${esc(doc.preheader)}</div>` +
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
        paragraphHtml(esc(doc.greeting), "font-size:16px;") +
        `<h1 style="margin:0 0 14px 0;font-family:${SERIF};font-size:27px;line-height:33px;color:${COLOR.navy};">${esc(doc.title)}</h1>` +
        doc.blocks.map(blockHtml).join("") +
        // ---- help + sign-off
        `<div style="border-top:1px solid ${COLOR.line};padding-top:16px;margin-top:4px;">` +
        paragraphHtml(richHtml(doc.help)) +
        doc.closing.map((paragraph) => paragraphHtml(esc(paragraph))).join("") +
        paragraphHtml(doc.signOff.map(esc).join("<br>"), `margin-top:14px;font-style:italic;color:${COLOR.navy};`) +
        `</div></td></tr>` +
        // ---- footer
        `<tr><td bgcolor="${COLOR.navy}" style="background-color:${COLOR.navy};padding:18px 28px;border-radius:0 0 10px 10px;">` +
        `<div style="font-family:${SANS};font-size:12px;line-height:18px;color:#C9D3E3;">${esc(doc.recipientNote)}</div>` +
        `<div style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;color:${COLOR.gold};padding-top:8px;">HealthAge · Discover Your Health Age</div>` +
        `</td></tr>` +
        `</table></td></tr></table></body></html>`
    );
}

// ---------------------------------------------------------------------------

export function renderEmailDocument(doc: EmailDocument): RenderedEmail {
    return { subject: doc.subject, text: renderText(doc), html: renderHtml(doc) };
}
