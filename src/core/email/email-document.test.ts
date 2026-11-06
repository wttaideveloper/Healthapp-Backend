import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    COLOR,
    DETAILS_LAYOUT,
    DISCONTINUATION_NOTICE_MEMBER,
    DISCONTINUATION_NOTICE_PURCHASER,
    DISCONTINUATION_NOTICE_TITLE,
    bold,
    buildStoreLinks,
    count,
    discontinuationNoticeBlock,
    escapeHtml,
    formatEmailDate,
    isMailbox,
    isSafeHttpUrl,
    renderEmailDocument,
    richText,
    type EmailDocument,
} from "./email-document";

const hostile = `<script>alert("x")</script> & O'Brien`;
const escapedHostile = `&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; O&#39;Brien`;

/** A document using every block type, with hostile text in every field. */
function everything(overrides: Partial<EmailDocument> = {}): EmailDocument {
    const links = [
        { label: "Android", url: "https://example.com/android?a=1&b=2" },
        { label: "iOS", url: "https://example.com/ios" },
    ];
    return {
        subject: `Subject ${hostile}`,
        preheader: `Preheader ${hostile}`,
        title: `Title ${hostile}`,
        greeting: `Hello ${hostile},`,
        blocks: [
            { type: "paragraphs", paragraphs: [[`Paragraph ${hostile} `, bold(`Bold ${hostile}`), " ", { link: "https://example.com/p" }, " ", { mail: "help@example.com" }]] },
            { type: "heading", text: `Heading ${hostile}` },
            { type: "bullets", items: [[`Bullet ${hostile}`], ["Second bullet"]] },
            { type: "details", rows: [{ label: `Label ${hostile}`, lines: [`Value ${hostile}`, "second line"] }, { label: "Plain", lines: ["x"] }] },
            { type: "callout", title: `Callout ${hostile}`, paragraphs: [[`Callout body ${hostile}`]] },
            { type: "notice", title: `Notice ${hostile}`, paragraphs: [`Notice body ${hostile}`] },
            {
                type: "steps",
                steps: [
                    { title: `Step ${hostile}`, body: [[`Step body ${hostile}`]], items: [[`Step item ${hostile}`]] },
                    { title: "Step with downloads", body: [], downloads: links },
                ],
            },
            { type: "steps", steps: [{ title: "Restarts at one", body: [["body"]] }] },
            { type: "downloads", intro: [`Download intro ${hostile}`], links },
            { type: "button", label: `Button ${hostile}`, url: "https://example.com/go?x=1&y=2", tone: "gold" },
        ],
        help: [`Help ${hostile} `, { mail: "help@example.com" }],
        closing: [`Closing ${hostile}`],
        signOff: ["Regards,", `Sender ${hostile}`],
        recipientNote: `Note ${hostile}`,
        ...overrides,
    };
}

describe("email design system: HTML", () => {
    const { html } = renderEmailDocument(everything());

    it("escapes hostile text in every field and every block type", () => {
        assert.doesNotMatch(html, /<script/i);
        assert.doesNotMatch(html, /alert\("x"\)/);
        for (const field of ["Subject", "Preheader", "Title", "Hello", "Paragraph", "Bold", "Heading", "Bullet", "Label", "Value", "Callout", "Callout body", "Notice", "Notice body", "Step", "Step body", "Step item", "Download intro", "Button", "Help", "Closing", "Sender", "Note"]) {
            assert.ok(html.includes(`${field} ${escapedHostile}`) || html.includes(`${field} ${escapedHostile},`), `${field} is escaped`);
        }
        assert.ok(escapeHtml(hostile) === escapedHostile);
    });

    it("puts URLs only inside escaped href attributes, with ampersands encoded", () => {
        assert.ok(html.includes('href="https://example.com/android?a=1&amp;b=2"'));
        assert.ok(html.includes('href="https://example.com/go?x=1&amp;y=2"'));
        const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
        assert.ok(hrefs.every((href) => /^https?:\/\/[^\s"<>]+$/.test(href) || /^mailto:[^\s"<>]+$/.test(href)), hrefs.join(" "));
    });

    it("is self-contained, table-based, inline-CSS HTML with no scripts, styles, images or handlers", () => {
        assert.match(html, /^<!DOCTYPE html><html lang="en">/);
        for (const forbidden of [/<script/i, /<style/i, /<link\b/i, /<img\b/i, /@import/i, /url\(/i, /<iframe/i, /<form/i, /\son[a-z]+\s*=/i, /javascript:/i, /\ssrc\s*=/i]) {
            assert.doesNotMatch(html, forbidden, String(forbidden));
        }
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        assert.match(html, /width="600" style="width:100%;max-width:600px;"/);
        assert.match(html, /role="presentation"/);
        assert.match(html, /overflow-wrap:anywhere/);
    });

    it("has the HealthAge header, one h1, section headings, numbered steps and a branded footer", () => {
        assert.match(html, />HealthAge<\/div>/);
        assert.match(html, />Discover Your Health Age<\/div>/);
        assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
        assert.equal([...html.matchAll(/<h2\b/g)].length, 1);
        assert.equal([...html.matchAll(/<h3\b/g)].length, 3);
        assert.match(html, /HealthAge · Discover Your Health Age/);
        for (const color of ["#0B2545", "#C9A227", "#FBF6E6", "#FFFFFF"]) assert.ok(html.includes(color), color);
    });

    it("renders one full-width button per download plus the call-to-action, each its own row", () => {
        // downloads: 2 inside the step, 2 in the downloads block, plus the gold button.
        assert.equal([...html.matchAll(/<table[^>]*max-width:320px[^>]*>/g)].length, 5);
        assert.match(html, />Download for Android<\/a>/);
        assert.match(html, /Or copy this link: <a href="https:\/\/example\.com\/go\?x=1&amp;y=2"/);
    });
});

describe("email design system: plain text", () => {
    const doc = everything({
        subject: "S",
        preheader: "P",
        title: "Title",
        greeting: "Hello,",
        blocks: [
            { type: "heading", text: "Your Free Access" },
            { type: "details", rows: [{ label: "Purchase", lines: ["Kit × 1"] }, { label: "Dates", lines: ["a", "b"] }] },
            { type: "bullets", items: [["one"], ["two ", bold("Label")]] },
            { type: "steps", steps: [{ title: "First", body: [["do ", bold("this")]], items: [["item"]] }, { title: "Second", body: [], downloads: [{ label: "Android", url: "https://example.com/a" }] }] },
            { type: "steps", steps: [{ title: "Again", body: [] }] },
            { type: "callout", title: "Note", paragraphs: [["careful"]] },
            { type: "button", label: "Open it", url: "https://example.com/open", tone: "gold" },
        ],
        help: ["Help ", { mail: "h@example.com" }],
        closing: ["Bye"],
        signOff: ["Regards,", "Me"],
    });
    const { text } = renderEmailDocument(doc);

    it("renders each block as readable text, with headings in capitals and bold labels in quotes", () => {
        assert.match(text, /^Hello,\n\nTitle\n\nYOUR FREE ACCESS\nPurchase: Kit × 1\nDates: a\n       b\n\n/);
        assert.match(text, /- one\n- two “Label”\n/);
        assert.match(text, /1\. First\n   do “this”\n   - item\n\n2\. Second\n   Available on: Android\n   Android: https:\/\/example\.com\/a\n/);
        assert.match(text, /Note\ncareful\n/);
        assert.match(text, /Open it: https:\/\/example\.com\/open\n/);
        assert.match(text, /Help h@example\.com\n\nBye\n\nRegards,\nMe$/);
    });

    it("restarts step numbering at 1 for each steps block", () => {
        assert.match(text, /\n1\. Again\n/);
        assert.deepEqual([...text.matchAll(/^(\d+)\. /gm)].map((match) => match[1]), ["1", "2", "1"]);
    });

    it("contains no markup, and richText shows links and addresses as themselves", () => {
        assert.doesNotMatch(text, /<[a-z][^>]*>|&[a-z]+;/i);
        assert.equal(richText(["a ", bold("b"), " ", { link: "https://x.test/y" }, " ", { mail: "m@x.test" }]), "a “b” https://x.test/y m@x.test");
    });

    it("keeps the same facts in the HTML and the text", () => {
        const both = renderEmailDocument(doc);
        const plain = both.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        for (const fact of ["Your Free Access", "Purchase", "Kit × 1", "First", "Second", "Again", "careful", "Open it", "Bye", "Regards,"]) {
            assert.ok(both.text.toUpperCase().includes(fact.toUpperCase()) && plain.includes(fact), fact);
        }
    });
});

describe("email design system: the details card layout", () => {
    const rows = [
        { label: "Workspace", lines: ["Grace Fellowship Health Ministry"] },
        { label: "Invited email", lines: ["maria.lopez@example.com"] },
        { label: "Role", lines: ["Member"] },
    ];
    const html = renderEmailDocument(everything({ blocks: [{ type: "details", rows }] })).html;
    // The card runs from its own <td> to the help section that follows it (the Outlook comments also contain "</td></tr></table>").
    const cardStart = html.indexOf(`<td bgcolor="${COLOR.goldSoft}"`);
    const card = html.slice(cardStart, html.indexOf(`<div style="border-top:1px solid ${COLOR.line};padding-top:16px;margin-top:4px;">`, cardStart));

    /** Width of the card's content at a viewport width: email table (600 max, 10px page padding each side) minus body and card padding. */
    const cardContent = (viewport: number): number => Math.min(viewport - 20, 600) - 2 * 28 - 4 - 2 * 18;
    const { labelMaxPx, valueMaxPx } = DETAILS_LAYOUT;

    it("is made of fluid boxes: each is full width up to a pixel maximum, with no media query and no fixed table columns", () => {
        assert.doesNotMatch(html, /@media|<style/i);
        assert.equal([...card.matchAll(/display:inline-block;width:100%;max-width:168px;vertical-align:top;/g)].length, rows.length, "a label box per row");
        assert.equal([...card.matchAll(/display:inline-block;width:100%;max-width:330px;vertical-align:top;/g)].length, rows.length, "a value box per row");
        assert.equal([...card.matchAll(/font-size:0;line-height:0;/g)].length, rows.length, "no whitespace gap between the two boxes");
        assert.doesNotMatch(card, /min-width|<td valign/, "nothing that can force the card wider than a small phone");
    });

    it("gives Outlook for Windows a two-column table through balanced conditional comments, and nothing else sees them", () => {
        const opens = card.match(/<!--\[if mso\]>/g) ?? [];
        const closes = card.match(/<!\[endif\]-->/g) ?? [];
        assert.equal(opens.length, rows.length * 3);
        assert.equal(closes.length, opens.length);
        assert.match(card, /<!--\[if mso\]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="34%" valign="top"><!\[endif\]-->/);
        assert.match(card, /<!--\[if mso\]><\/td><td width="66%" valign="top"><!\[endif\]-->/);
        assert.match(card, /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/);
    });

    it("on phones the boxes stack at the card's full width, so nothing overflows and an address is not broken mid-word", () => {
        for (const viewport of [240, 280, 300, 320, 360, 375, 414]) {
            const inner = cardContent(viewport);
            assert.ok(labelMaxPx + valueMaxPx > inner, `${viewport}px: the two boxes do not fit side by side, so they stack`);
            // Each box is width:100% with a max-width, so it never exceeds the card.
            assert.ok(Math.min(valueMaxPx, inner) <= inner);
        }
        assert.equal(cardContent(375), 259);
        assert.equal(cardContent(320), 204);
        assert.ok(cardContent(375) >= 25 * 8, "a 25-character address (about 8px a character, bold) fits on one line at 375px");
    });

    it("on desktop the card keeps its two columns, with the label and value widths of the old layout", () => {
        for (const viewport of [700, 800, 1024, 1440]) {
            const inner = cardContent(viewport);
            assert.equal(inner, 504, `${viewport}px`);
            assert.ok(labelMaxPx + valueMaxPx <= inner, `${viewport}px: side by side`);
        }
        // The old layout gave the label 34% of the card and the value the rest.
        assert.ok(Math.abs(labelMaxPx - 0.34 * 504) <= 4, "label column within 4px of the old width");
        assert.ok(Math.abs(valueMaxPx - (504 - 0.34 * 504)) <= 4, "value column within 4px of the old width");
    });

    it("keeps the separators, the escaping and the bold values", () => {
        assert.equal([...card.matchAll(/border-top:1px solid #E3E7EF;/g)].length, rows.length - 1, "a line between rows, none above the first");
        const hostileRow = renderEmailDocument(everything({ blocks: [{ type: "details", rows: [{ label: `<b>L</b>`, lines: [`a"b<script>`, "second line"] }] }] })).html;
        assert.doesNotMatch(hostileRow, /<b>L|<script/);
        assert.match(hostileRow, /a&quot;b&lt;script&gt;<br>second line/);
        assert.match(card, /font-weight:bold;color:#0B2545;[^"]*">maria\.lopez@example\.com<\/div>/);
    });
});

describe("email design system: the discontinuation notice", () => {
    // A clean document, so the "no markup in the text" check is about the notice and not the other fields' hostile samples.
    const clean = (audience: "purchaser" | "member") =>
        renderEmailDocument(
            everything({
                subject: "Subject",
                preheader: "Preheader",
                title: "Title",
                greeting: "Hello,",
                help: ["Help"],
                closing: ["Bye"],
                signOff: ["Regards,", "Me"],
                recipientNote: "Note",
                blocks: [discontinuationNoticeBlock(audience)],
            })
        );
    const purchaser = clean("purchaser");
    const member = clean("member");

    it("has the approved title and wording, word for word", () => {
        assert.equal(DISCONTINUATION_NOTICE_TITLE, "Important: Discontinuation of the Previous HealthAge Software");
        assert.equal(
            DISCONTINUATION_NOTICE_PURCHASER,
            "We are discontinuing the previous version of HealthAge and transitioning all users to our new and improved HealthAge application. The old software will no longer be supported. Please switch to the new HealthAge application to continue enjoying your HealthAge services. Your existing purchase includes one year of free access to the new version."
        );
    });

    it("the member wording differs from it in exactly one place: the organization made the purchase, not the member", () => {
        assert.equal(DISCONTINUATION_NOTICE_MEMBER, DISCONTINUATION_NOTICE_PURCHASER.replace("Your existing purchase", "Your organization’s existing purchase"));
        assert.notEqual(DISCONTINUATION_NOTICE_MEMBER, DISCONTINUATION_NOTICE_PURCHASER);
    });

    it("gives no date and does not claim the old software is already switched off", () => {
        for (const wording of [DISCONTINUATION_NOTICE_PURCHASER, DISCONTINUATION_NOTICE_MEMBER, DISCONTINUATION_NOTICE_TITLE]) {
            assert.doesNotMatch(wording, /\d/, "no date, year or number is invented");
            assert.doesNotMatch(wording, /\b(january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|by the end|deadline|effective)\b/i);
            assert.doesNotMatch(wording, /already|has been (shut|switched|turned|closed)|shut down|switched off|no longer (available|accessible|work)|is now (closed|offline|unavailable)/i);
        }
        // What it does say is that the old software is being discontinued and will no longer be supported.
        assert.match(DISCONTINUATION_NOTICE_PURCHASER, /We are discontinuing the previous version of HealthAge/);
        assert.match(DISCONTINUATION_NOTICE_PURCHASER, /will no longer be supported/);
    });

    it("is a prominent navy panel with a gold rule and title and ivory text, in the HTML", () => {
        const html = purchaser.html;
        assert.match(html, new RegExp(`<td bgcolor="${COLOR.navy}" style="background-color:${COLOR.navy};border-top:4px solid ${COLOR.gold};`));
        assert.match(html, new RegExp(`color:${COLOR.gold};[^"]*">${DISCONTINUATION_NOTICE_TITLE}</div>`));
        assert.match(html, new RegExp(`color:${COLOR.goldSoft};[^"]*">${DISCONTINUATION_NOTICE_PURCHASER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
        assert.match(html, /role="presentation"/);
        assert.doesNotMatch(html, /<script|<style|<img|url\(/i);
    });

    it("is also in the plain-text version, framed so it stands out, with the same words", () => {
        const text = purchaser.text;
        const rule = "=".repeat(60);
        assert.ok(text.includes(`${rule}\n${DISCONTINUATION_NOTICE_TITLE}\n\n${DISCONTINUATION_NOTICE_PURCHASER}\n${rule}\n`));
        assert.ok(member.text.includes(DISCONTINUATION_NOTICE_MEMBER));
        assert.ok(member.html.includes(escapeHtml(DISCONTINUATION_NOTICE_MEMBER)), "the apostrophe survives escaping and matches in the HTML");
        assert.doesNotMatch(text, /<[a-z][^>]*>|&[a-z]+;/i);
    });
});

describe("email design system: helpers", () => {
    it("buildStoreLinks lists Android, iOS, Windows, macOS in that order, skips unset links and refuses unsafe ones", () => {
        const all = buildStoreLinks({ macos: "https://m.test", windows: "https://w.test", ios: "https://i.test", android: "https://a.test" });
        assert.deepEqual(all.map((link) => link.label), ["Android", "iOS", "Windows", "macOS"]);
        assert.deepEqual(buildStoreLinks({ android: "https://a.test", ios: null, windows: "  ", macos: undefined }).map((link) => link.label), ["Android"]);
        assert.deepEqual(buildStoreLinks({}), []);
        for (const bad of ["javascript:alert(1)", "ftp://x.test", "https://x.test/<b>", 'https://x.test/"a', "//x.test"]) {
            assert.throws(() => buildStoreLinks({ android: bad }), /not a plain http\(s\) URL/, bad);
        }
    });

    it("isSafeHttpUrl and isMailbox accept ordinary values and reject anything that could break out of an attribute", () => {
        assert.equal(isSafeHttpUrl("https://example.com/a?b=1&c=2"), true);
        assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
        assert.equal(isSafeHttpUrl("https://example.com/a b"), false);
        assert.equal(isMailbox("support@example.com"), true);
        assert.equal(isMailbox('x"onclick="alert(1)@example.com'), false);
        assert.equal(isMailbox("not an address"), false);
    });

    it("formatEmailDate and count", () => {
        assert.equal(formatEmailDate("2027-11-05"), "5 November 2027");
        assert.equal(formatEmailDate("2026-01-01 (sample date)"), "2026-01-01 (sample date)");
        assert.equal(formatEmailDate("2026-13-40"), "2026-13-40");
        assert.equal(count(1, "license"), "1 license");
        assert.equal(count(4, "license"), "4 licenses");
        assert.equal(count(3, "additional member"), "3 additional members");
    });
});
