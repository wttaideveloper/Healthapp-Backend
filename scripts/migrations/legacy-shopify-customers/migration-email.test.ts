/**
 * The personalised onboarding email: content per product and license count, instructions
 * that match what the application really does, link handling, HTML safety, and text/HTML parity.
 *
 * Pure: nothing here reaches a database, a mail server or the network. Some tests read the
 * source of the Admin Portal, the backend and the mobile app to prove that every label and
 * behaviour the email describes exists ("drift guards"); the ones that need the sibling
 * projects skip themselves when those folders are not checked out next to this one.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { emailConfigIssues, readEmailConfig } from "./apply-core.ts";
import { buildMigrationPlan, summarizeLicensesByProduct } from "./build-plan.ts";
import {
    ADMIN_PORTAL_URL,
    FREE_YEAR_EMAIL_SUBJECT,
    formatEmailDate,
    getLegacyFreeYearEmailContent,
    isSafeHttpUrl,
    type FreeYearEmailInput,
    type PurchaseSummary,
} from "./migration-email.ts";
import { readOrdersCsv } from "./orders-csv.ts";
import { ELIGIBLE_PRODUCTS } from "./product-eligibility.ts";
import { buildPurchaseIndex, buildPurchaseSummary, purchaseLine } from "./purchase-summary.ts";

// ---------------------------------------------------------------------------
// Fixtures: fictional customers only
// ---------------------------------------------------------------------------

const LINKS = {
    androidUrl: "https://play.google.com/store/apps/details?id=com.example.android",
    windowsUrl: "https://apps.microsoft.com/detail/EXAMPLEWIN",
    iosUrl: "https://apps.apple.com/app/example-ios",
    macosUrl: "https://apps.apple.com/app/example-macos",
};

function emailInput(purchase: PurchaseSummary, overrides: Partial<FreeYearEmailInput> = {}): FreeYearEmailInput {
    return {
        customerName: "Jordan Lee",
        accountEmail: "jordan.lee@example.com",
        workspaceName: "Lee Community Health",
        startDate: "2026-11-04",
        expiryDate: "2027-11-04",
        supportEmail: "support@healthexporesources.com",
        purchase,
        ...LINKS,
        ...overrides,
    };
}

/** Licenses per unit come from the real product rules, so a test can never disagree with the migration. */
function perUnit(ruleId: string): number {
    const rule = ELIGIBLE_PRODUCTS.find((candidate) => candidate.id === ruleId);
    assert.ok(rule && rule.licenseQuantity.type === "fixed_per_unit", `${ruleId} is a fixed-per-unit rule`);
    return rule.licenseQuantity.seatsPerUnit;
}

const smallKit = (units: number): PurchaseSummary => {
    const licenses = units * perUnit("health_expo_screening_kit_small");
    return { licenses, lines: [purchaseLine("health_expo_screening_kit_small", units, licenses)] };
};
const largeKit = (units: number): PurchaseSummary => {
    const licenses = units * perUnit("health_expo_screening_kit_large");
    return { licenses, lines: [purchaseLine("health_expo_screening_kit_large", units, licenses)] };
};
const dyha = (licenses: number): PurchaseSummary => ({ licenses, lines: [purchaseLine("discover_your_health_age", 1, licenses)] });

const render = (purchase: PurchaseSummary, overrides: Partial<FreeYearEmailInput> = {}) =>
    getLegacyFreeYearEmailContent(emailInput(purchase, overrides));

/** Step titles in order, from the plain-text version and from the HTML version. */
const textSteps = (text: string): string[] => [...text.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]!);
const htmlSteps = (html: string): string[] => [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]!);
const htmlToText = (html: string): string =>
    html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");

const read = (...parts: string[]) => readFileSync(resolve(process.cwd(), ...parts), "utf8");

// ---------------------------------------------------------------------------
// One email per product and license count
// ---------------------------------------------------------------------------

describe("onboarding email: Small Venue Kit (1 license)", () => {
    const { text, html, subject } = render(smallKit(1));

    it("says the kit includes exactly 1 license, used by the purchaser, with no additional member seats", () => {
        assert.equal(subject, FREE_YEAR_EMAIL_SUBJECT);
        for (const body of [text, htmlToText(html)]) {
            assert.match(body, /Your Small Venue Kit includes 1 license\./);
            assert.match(body, /One license, and it.s yours/);
            assert.match(body, /you are the workspace owner and you use this license yourself/i);
            assert.match(body, /No additional member seats are included with this purchase/);
        }
        assert.doesNotMatch(text, /\b1 licenses\b/, "never pluralises a single license");
    });

    it("has no member-invitation steps, and tells the owner the counter reads 1 of 1 license used", () => {
        assert.deepEqual(textSteps(text), [
            "Open the HealthAge Admin Portal",
            "Create your account (first time only)",
            "Sign in",
            "Open your workspace",
            "Check your licenses",
            "Download HealthAge",
            "Sign in to the app and start",
        ]);
        assert.doesNotMatch(text, /Invite a Member|Invite your additional members|What each additional member does/);
        assert.match(text, /“1 of 1 license used”/);
    });
});

describe("onboarding email: Large Venue Kit (4 licenses)", () => {
    const large = largeKit(1);
    const { text, html } = render(large);

    it("uses the migration's real license count (4 comes from the product rules, not from the email)", () => {
        assert.equal(large.licenses, perUnit("health_expo_screening_kit_large"));
        assert.equal(large.licenses, 4);
        assert.match(text, /Your Large Venue Kit includes 4 licenses\./);
        assert.match(htmlToText(html), /Your Large Venue Kit includes 4 licenses\./);
        assert.match(text, /Large Venue Kit × 1 — 4 licenses/);
    });

    it("explains that the owner uses one license and can invite up to 3 additional members", () => {
        for (const body of [text, htmlToText(html)]) {
            assert.match(body, /4 licenses: 1 for you and 3 for your team/);
            assert.match(body, /you are the workspace owner, and you use 1 of the 4 licenses/);
            assert.match(body, /up to 3 additional members/);
            assert.match(body, /Each additional member signs in to the app with their own account/);
            assert.match(body, /4 in total \(1 for you as the workspace owner, 3 for additional members\)/);
        }
    });

    it("walks the owner through Members and what each invited member does", () => {
        assert.deepEqual(textSteps(text), [
            "Open the HealthAge Admin Portal",
            "Create your account (first time only)",
            "Sign in",
            "Open your workspace",
            "Check your licenses",
            "Invite your additional members",
            "What each additional member does",
            "Download HealthAge",
            "Sign in to the app and start",
        ]);
        assert.match(text, /Select “Members” in the menu\. Under “Invite a Member”, enter the person’s email address, leave “Role” set to “member”, and select “Invite”\./);
        assert.match(text, /You can invite up to 3 additional members: your 4 licenses minus the one you use\./);
        assert.match(text, /Active members and pending invitations both use a license/);
        assert.match(text, /“1 of 4 licenses used”/);
        assert.match(text, /choose “Create account” and register with the invited email address/);
        assert.match(text, /No purchase is needed in the app/);
    });
});

describe("onboarding email: Discover Your Health Age (N licenses)", () => {
    it("states the real number of licenses, whatever it is", () => {
        for (let n = 1; n <= 12; n += 1) {
            const { text, html } = render(dyha(n));
            const plain = htmlToText(html);
            const expectedHeadline = `Your Discover Your Health Age purchase includes ${n} ${n === 1 ? "license" : "licenses"}.`;
            assert.ok(text.includes(expectedHeadline), `n=${n}: ${expectedHeadline}`);
            assert.ok(plain.includes(expectedHeadline), `n=${n} (html)`);
            assert.ok(text.includes(`“1 of ${n} ${n === 1 ? "license" : "licenses"} used”`), `n=${n}: counter`);
            if (n === 1) {
                assert.doesNotMatch(text, /Invite a Member|Invite your additional members|up to \d+ additional member/);
                assert.match(text, /No additional member seats are included/);
            } else {
                const extra = n - 1;
                assert.ok(text.includes(`up to ${extra} additional member${extra === 1 ? "" : "s"}`), `n=${n}: invites ${extra}`);
                assert.ok(text.includes(`${n} licenses: 1 for you and ${extra} for your team`), `n=${n}: notice`);
            }
        }
    });

    it("tells the purchaser they are the workspace owner and how to manage members within the limit (4 licenses)", () => {
        const { text } = render(dyha(4));
        assert.match(text, /you are the workspace owner/);
        assert.match(text, /Select “Members” in the menu/);
        assert.match(text, /up to 3 additional members/);
        assert.match(text, /Discover Your Health Age — 4 licenses/);
    });

    it("keeps the venue-kit and software wording apart", () => {
        assert.doesNotMatch(render(dyha(3)).text, /Venue Kit/);
        assert.doesNotMatch(render(largeKit(1)).text, /Discover Your Health Age purchase includes/);
    });
});

describe("onboarding email: other combinations always follow the real counts", () => {
    it("several kits of one kind", () => {
        const two = render(smallKit(2));
        assert.match(two.text, /Your 2 Small Venue Kits include 2 licenses\./);
        assert.match(two.text, /up to 1 additional member\b/);
        const three = render(largeKit(2));
        assert.match(three.text, /Your 2 Large Venue Kits include 8 licenses\./);
        assert.match(three.text, /up to 7 additional members/);
        assert.match(three.text, /Large Venue Kit × 2 — 8 licenses/);
    });

    it("a mixed purchase lists every product and the combined total", () => {
        const mixed: PurchaseSummary = {
            licenses: 8 + 3,
            lines: [purchaseLine("health_expo_screening_kit_large", 2, 8), purchaseLine("discover_your_health_age", 1, 3)],
        };
        const { text, html } = render(mixed);
        for (const body of [text, htmlToText(html)]) {
            assert.match(body, /Your purchases include 11 licenses in total\./);
            assert.match(body, /Large Venue Kit × 2 — 8 licenses/);
            assert.match(body, /Discover Your Health Age — 3 licenses/);
            assert.match(body, /up to 10 additional members/);
        }
    });

    it("refuses to describe a purchase whose numbers do not add up, rather than state a wrong count", () => {
        const bad: Array<[string, PurchaseSummary]> = [
            ["zero licenses", { licenses: 0, lines: [] }],
            ["no lines", { licenses: 4, lines: [] }],
            ["lines add up to less", { licenses: 5, lines: [purchaseLine("health_expo_screening_kit_large", 1, 4)] }],
            ["lines add up to more", { licenses: 3, lines: [purchaseLine("health_expo_screening_kit_large", 1, 4)] }],
            ["fractional", { licenses: 1.5, lines: [purchaseLine("discover_your_health_age", 1, 1.5)] }],
        ];
        for (const [label, purchase] of bad) {
            assert.throws(() => render(purchase), /Refusing to build the email/, label);
        }
    });
});

// ---------------------------------------------------------------------------
// Dynamic data
// ---------------------------------------------------------------------------

describe("onboarding email: dynamic information", () => {
    it("carries the customer's own name, sign-in address, workspace, product, licenses, dates, portal, links and support address", () => {
        const { text, html } = render(largeKit(1));
        const plain = htmlToText(html);
        for (const [label, value] of [
            ["name", "Hi Jordan Lee,"],
            ["account email", "jordan.lee@example.com"],
            ["workspace", "Lee Community Health"],
            ["start date", "Start Date: 4 November 2026"],
            ["expiry date", "Expires: 4 November 2027"],
            ["portal", ADMIN_PORTAL_URL],
            ["support", "support@healthexporesources.com"],
            ["licenses", "4 licenses"],
        ] as const) {
            assert.ok(text.includes(value), `text: ${label}`);
            assert.ok(plain.includes(value.replace("Start Date: ", "").replace("Expires: ", "")), `html: ${label}`);
        }
        for (const url of Object.values(LINKS)) {
            assert.ok(text.includes(url), `text link ${url}`);
            assert.ok(html.includes(`href="${url}"`), `html button ${url}`);
        }
        // The footer names the address the message was sent to (the purchase address), in both versions.
        assert.ok(html.includes("This message was sent to jordan.lee@example.com because of your 2026 Discover Your Health Age purchase."));
        assert.ok(html.includes('<a href="mailto:support@healthexporesources.com"'));
    });

    it("never contains sample or synthetic markers for a real customer", () => {
        for (const purchase of [smallKit(1), largeKit(1), dyha(3)]) {
            const { text, html } = render(purchase);
            for (const body of [text, html]) {
                assert.doesNotMatch(body, /sample date|HealthAge Test Customer|test\.customer@example\.com|HealthAge Test Workspace|example\.invalid/i);
            }
        }
    });

    it("shows ISO dates in full and passes anything else through unchanged", () => {
        assert.equal(formatEmailDate("2026-11-04"), "4 November 2026");
        assert.equal(formatEmailDate("2027-02-09"), "9 February 2027");
        assert.equal(formatEmailDate("2026-01-01 (sample date)"), "2026-01-01 (sample date)");
        assert.equal(formatEmailDate("2026-13-40"), "2026-13-40");
        assert.equal(formatEmailDate("soon"), "soon");
    });

    it("uses the current Admin Portal address, which is the backend's own constant", () => {
        const backend = read("src", "modules", "workspace", "workspace.links.ts");
        assert.ok(backend.includes(`WORKSPACE_ADMIN_URL = "${ADMIN_PORTAL_URL}"`), "migration email and backend invites must agree");
        assert.equal(ADMIN_PORTAL_URL, "https://healthage.healthexporesources.com/");
        assert.doesNotMatch(render(dyha(2)).html, /vercel\.app|workspace-admin/);
    });
});

// ---------------------------------------------------------------------------
// Platform links
// ---------------------------------------------------------------------------

describe("onboarding email: platform downloads", () => {
    it("has a separate button for each of the four platforms, each pointing at its own configured URL", () => {
        const { html, text } = render(largeKit(1));
        for (const [label, url] of [
            ["Android", LINKS.androidUrl],
            ["iOS", LINKS.iosUrl],
            ["Windows", LINKS.windowsUrl],
            ["macOS", LINKS.macosUrl],
        ] as const) {
            const button = new RegExp(`<a href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>Download for ${label}</a>`);
            assert.match(html, button, `${label} button`);
            assert.ok(text.includes(`${label}: ${url}`), `${label} text link`);
        }
        assert.match(text, /Available on: Android • Windows • iOS • macOS/);
    });

    it("omits a platform that is not configured, and never prints an empty link", () => {
        const { html, text } = render(smallKit(1), { iosUrl: null, macosUrl: null });
        assert.doesNotMatch(html, /Download for (iOS|macOS)/);
        assert.doesNotMatch(text, /\biOS:|\bmacOS:/);
        assert.match(html, /Download for Android/);
        assert.match(html, /Download for Windows/);
        assert.doesNotMatch(html + text, /href=""|undefined|null/);
    });

    it("only ever links to plain http(s) URLs: anything else is refused, never emitted", () => {
        for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com/app", 'https://example.com/"onmouseover="x', "https://exa mple.com", "//example.com/app", "https://example.com/<script>"]) {
            assert.equal(isSafeHttpUrl(bad), false, bad);
            assert.throws(() => render(dyha(2), { iosUrl: bad }), /not a plain http\(s\) URL/, bad);
        }
        for (const good of ["https://apps.apple.com/app/id1", "http://example.com/x?a=1&b=2"]) assert.equal(isSafeHttpUrl(good), true, good);
    });

    it("the configuration check reports a malformed link by name, before any customer is emailed", () => {
        const config = { ...readEmailConfig({}), iosUrl: "javascript:alert(1)", macosUrl: "apps.apple.com/no-scheme" };
        assert.deepEqual(emailConfigIssues(config), ["HEALTHAGE_IOS_URL is not a plain http(s) URL", "HEALTHAGE_MACOS_URL is not a plain http(s) URL"]);
        assert.deepEqual(emailConfigIssues(readEmailConfig({})), []);
    });
});

// ---------------------------------------------------------------------------
// HTML and plain text
// ---------------------------------------------------------------------------

describe("onboarding email: HTML design and email-client compatibility", () => {
    const { html } = render(largeKit(1));

    it("is a self-contained, inline-CSS document: no scripts, stylesheets, images or external files", () => {
        assert.match(html, /^<!DOCTYPE html><html lang="en">/);
        for (const forbidden of [/<script/i, /<style/i, /<link\b/i, /<img\b/i, /@import/i, /url\(/i, /<iframe/i, /<form/i, /\son[a-z]+\s*=/i, /javascript:/i, /\ssrc\s*=/i]) {
            assert.doesNotMatch(html, forbidden, String(forbidden));
        }
        assert.ok(html.length < 100_000, `stays under Gmail's 102 KB clipping limit (${html.length} bytes)`);
        const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
        assert.ok(hrefs.length >= 6);
        assert.ok(hrefs.every((href) => /^https?:\/\//.test(href) || /^mailto:[^\s"]+$/.test(href)), `only http(s) and mailto links: ${hrefs.join(" ")}`);
    });

    it("is mobile friendly: viewport, fluid 600px table, stacked full-width buttons, table layout", () => {
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        assert.match(html, /width="600" style="width:100%;max-width:600px;"/);
        assert.match(html, /role="presentation"/);
        const buttons = [...html.matchAll(/<table[^>]*max-width:320px[^>]*>/g)];
        assert.equal(buttons.length, 5, "one Admin Portal button plus four download buttons, each its own row");
        assert.match(html, /overflow-wrap:anywhere/, "long URLs and addresses wrap on a narrow phone");
    });

    it("uses the HealthAge navy / white / subtle gold palette, with an Open Admin Portal button and a hidden preheader", () => {
        assert.match(html, /#0B2545/);
        assert.match(html, /#C9A227/);
        assert.match(html, /#FFFFFF/);
        assert.match(html, />HealthAge<\/div>/);
        assert.match(html, /<a href="https:\/\/healthage\.healthexporesources\.com\/"[^>]*>Open Admin Portal<\/a>/);
        assert.match(html, /display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all/);
        assert.match(html, /Welcome to the new Discover Your Health Age App/);
        assert.match(html, />How to get started<\/h2>/);
    });
});

describe("onboarding email: HTML and plain text say the same thing", () => {
    for (const [label, purchase] of [
        ["small kit", smallKit(1)],
        ["large kit", largeKit(1)],
        ["DYHA 4", dyha(4)],
        ["mixed", { licenses: 11, lines: [purchaseLine("health_expo_screening_kit_large", 2, 8), purchaseLine("discover_your_health_age", 1, 3)] } as PurchaseSummary],
    ] as const) {
        it(`${label}: same steps in the same order, and every fact appears in both`, () => {
            const { text, html } = render(purchase);
            assert.deepEqual(textSteps(text), htmlSteps(html));
            const plain = htmlToText(html);
            for (const fact of ["Jordan Lee", "jordan.lee@example.com", "Lee Community Health", "4 November 2026", "4 November 2027", ADMIN_PORTAL_URL, "support@healthexporesources.com"]) {
                assert.ok(text.includes(fact) && plain.includes(fact), `visible in both: ${fact}`);
            }
            // Store links are buttons: the URL is in the href (HTML) and printed in full (text).
            for (const url of Object.values(LINKS)) {
                assert.ok(text.includes(url) && html.includes(`href="${url}"`), `link in both: ${url}`);
            }
            for (const line of purchase.lines) assert.ok(text.includes(line.label) && plain.includes(line.label), line.label);
            assert.doesNotMatch(text, /<[a-z][^>]*>|&[a-z]+;/i, "the plain-text version contains no markup");
            // A bold UI label is shown in quotes in text; it must never carry a second pair of its own.
            assert.doesNotMatch(text, /““|””|"“|”"/, "no doubled quotation marks");
            assert.doesNotMatch(plain, /““|””/, "no doubled quotation marks in the HTML either");
            assert.match(text, /\n- Pastor Rodney Bowes$/);
            assert.match(plain, /- Pastor Rodney Bowes/);
        });
    }
});

describe("onboarding email: HTML escaping", () => {
    it("escapes the customer's name, workspace name and address everywhere they appear", () => {
        const { html, text } = render(largeKit(1), {
            customerName: `<script>alert("x")</script> & O'Brien`,
            workspaceName: `Tom & "Jerry" <b>Clinic</b>`,
            accountEmail: `a<b>@example.com`,
        });
        assert.doesNotMatch(html, /<script/i);
        assert.doesNotMatch(html, /<b>Clinic<\/b>/);
        assert.doesNotMatch(html, /a<b>@example\.com/);
        assert.match(html, /Hi &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; O&#39;Brien,/);
        assert.match(html, /Tom &amp; &quot;Jerry&quot; &lt;b&gt;Clinic&lt;\/b&gt;/);
        assert.match(html, /a&lt;b&gt;@example\.com/);
        // The plain-text version shows the characters themselves; it is not HTML.
        assert.ok(text.includes(`Tom & "Jerry" <b>Clinic</b>`));
    });

    it("cannot be used to inject an attribute through the support address or a link", () => {
        const { html } = render(dyha(2), { supportEmail: `x"onclick="alert(1)@example.com` });
        assert.doesNotMatch(html, /href="mailto:/, "an unsafe support address is shown as text, never as a mailto link");
        // The quote that would close the attribute is escaped, so no attribute can start.
        assert.doesNotMatch(html, /"onclick/);
        assert.match(html, /x&quot;onclick=&quot;alert\(1\)@example\.com/);
    });
});

// ---------------------------------------------------------------------------
// The instructions are the application's real flow
// ---------------------------------------------------------------------------

describe("onboarding email: the instructions do not invent anything", () => {
    it("does not mention steps, screens or codes the product does not have", () => {
        for (const purchase of [smallKit(1), largeKit(1), dyha(4)]) {
            const { text } = render(purchase);
            assert.doesNotMatch(text, /verification (code|link|email)|verify your email|confirm your email|activation (link|code)|one-time|OTP|magic link/i);
            assert.doesNotMatch(text, /enter your (license|licence) (key|code)/i);
            assert.doesNotMatch(text, /license key|licence key|serial number|billing portal|settings page|admin approval is required/i);
        }
    });

    it("tells the owner to register with exactly the purchase address, that no approval is needed, and to ask support if access does not activate", () => {
        const { text, html } = render(largeKit(1));
        assert.match(text, /On the sign-in page, choose “Sign up”\. Enter your full name, “jordan\.lee@example\.com” as the email, and a password of at least 8 characters, then select “Create account”\./);
        assert.match(text, /Use exactly “jordan\.lee@example\.com”, the email address used for your purchase/);
        // No approval step: said plainly, and tied to the purchase address.
        assert.match(text, /There is no approval step and nothing to wait for: as an eligible purchaser you can sign in as soon as your account is created\. Your workspace is already linked to the email address used for your purchase, so always sign in with “jordan\.lee@example\.com”\./);
        // Support is still offered when access does not activate.
        assert.match(text, /If you see “Account not authorized”, or your workspace does not appear after you sign in, please contact us at support@healthexporesources\.com\./);
        // The HTML says the same thing, with the address and support link intact.
        assert.ok(html.includes("There is no approval step and nothing to wait for"), "HTML has the no-approval sentence");
        assert.ok(html.includes('<a href="mailto:support@healthexporesources.com"'), "HTML keeps the support link");
    });

    it("never mentions an approval the portal does not require (the old sign-up notice is gone)", () => {
        for (const kit of [smallKit(1), largeKit(1), dyha(3)]) {
            const { text, html } = render(kit);
            for (const body of [text, html]) {
                assert.doesNotMatch(body, /requires admin approval|admin approval is required|platform admin will review|awaiting approval|wait for (an )?admin/i);
                assert.doesNotMatch(body, /the page may say/i);
            }
        }
    });

    it("sends additional members to the app, not the portal (the portal only admits owners and admins)", () => {
        const { text } = render(largeKit(1));
        const memberStep = text.slice(text.indexOf("What each additional member does"), text.indexOf("Download HealthAge"));
        assert.match(memberStep, /installs the HealthAge app/);
        assert.doesNotMatch(memberStep, /Admin Portal|healthage\.healthexporesources\.com/);
    });
});

// --- drift guards against the real application sources -------------------

const frontend = resolve(process.cwd(), "..", "Healthapp-frontend");
const mobile = resolve(process.cwd(), "..", "Healthapp");
const haveFrontend = existsSync(resolve(frontend, "src", "app", "page.tsx"));
const haveMobile = existsSync(resolve(mobile, "src", "screens", "SignUpScreen.tsx"));

describe("onboarding email: backend behaviour the instructions rely on (in this repository)", () => {
    const auth = read("src", "modules", "auth", "auth.route.ts");
    const workspaceRoute = read("src", "modules", "workspace", "workspace.route.ts");
    const entitlement = read("src", "modules", "entitlement", "entitlement.service.ts");
    const seats = read("src", "modules", "workspace", "workspace.seats.ts");

    it("registration creates an ACTIVE account and claims the invited seat for that email (so no approval step is needed)", () => {
        const register = auth.slice(auth.indexOf('"/register"'), auth.indexOf('"/forgot-password"'));
        assert.match(register, /status: "active"/);
        assert.match(register, /linkWorkspaceMembershipsForUser\(app, newUser\)/);
        const login = auth.slice(auth.indexOf('"/login"'), auth.indexOf('"/me"'));
        assert.match(login, /linkWorkspaceMembershipsForUser\(app, foundUser\)/);
        assert.match(entitlement, /status: "active",[\s\S]{0,80}joinedAt: now/);
        assert.match(entitlement, /eq\(workspaceMembers\.status, "invited"\)/);
    });

    it("an owner can invite members by email; a seat is required and the owner's own seat counts", () => {
        // The POST handler: from its summary line to the next route (independent of line endings).
        const start = workspaceRoute.indexOf("Invite a member to the current user's workspace");
        assert.ok(start > 0, "found the invite route");
        const add = workspaceRoute.slice(start, workspaceRoute.indexOf("app.patch(", start));
        assert.match(workspaceRoute, /addMemberBodySchema = z\.object\(\{\s*email: z\.string\(\)\.trim\(\)\.email\(\),\s*role: z\.enum\(\["admin", "member"\]\)\.default\("member"\)/);
        assert.match(add, /requireWorkspaceManager/);
        assert.match(add, /assertWorkspaceHasAvailableSeat/);
        assert.match(workspaceRoute, /\["owner", "admin"\]\.includes\(row\.member\.role\)/);
        assert.match(seats, /ne\(workspaceMembers\.status, "revoked"\)/, "every non-revoked member, the owner included, uses a license");
        assert.match(seats, /assignedCount < seatLimit/);
    });

    it("the migration creates the purchaser as the workspace OWNER with seat_limit equal to the license total", () => {
        const apply = read("scripts", "migrations", "legacy-shopify-customers", "apply.ts");
        assert.match(apply, /seat_limit/);
        assert.match(read("scripts", "migrations", "legacy-shopify-customers", "apply-core.ts"), /role: GRANT_CONFIG\.ownerRole/);
        assert.match(read("scripts", "migrations", "legacy-shopify-customers", "apply-core.ts"), /seatLimit: customer\.licenseQuantity/);
    });
});

describe("onboarding email: every label it quotes exists in the Admin Portal", { skip: !haveFrontend && "Admin Portal project is not checked out next to this one" }, () => {
    const file = (...parts: string[]) => readFileSync(resolve(frontend, "src", ...parts), "utf8");

    it("sign-in and sign-up screens", () => {
        const signIn = file("components", "admin", "AdminAuthScreen.tsx");
        assert.match(signIn, /title="Sign in"/);
        assert.match(signIn, /<AuthLink href="\/workspace-admin">Sign up<\/AuthLink>/);
        const signUp = file("components", "workspaces", "WorkspaceAuthScreen.tsx");
        for (const label of ["Full name", "Work email", "Password", "Create account", "At least 8 characters"]) {
            assert.ok(signUp.includes(label), label);
        }
        // The email says there is no approval step, so the sign-up screen must not claim one.
        assert.doesNotMatch(signUp, /requires admin approval|platform admin will review|A platform admin approves/i);
        assert.ok(signUp.includes("No approval is needed"), "the sign-up confirmation says no approval is needed");
        assert.match(signUp, /NAME_PATTERN = \/\^\[A-Za-z\]\[A-Za-z0-9 \]\*\$\//, "letters, numbers and spaces; must start with a letter");
        assert.match(signUp, /minLength=\{8\}/);
    });

    it("the access gate and its error message", () => {
        const page = file("app", "page.tsx");
        assert.match(page, /memberStatus === "active"/);
        assert.match(page, /\(entitlementResponse\.workspace\.role === "owner" \|\| entitlementResponse\.workspace\.role === "admin"\)/);
        assert.ok(page.includes("Account not authorized."));
    });

    it("an owner lands on My Workspaces, which shows the license counter and the Members and Invite a Member sections", () => {
        const storage = file("lib", "admin", "storage.ts");
        assert.match(storage, /workspaceViews: readonly ViewMode\[\] = \["my-workspaces", "analytics", "members"\]/);
        assert.match(storage, /isPlatformAdmin \? "overview" : "my-workspaces"/);
        const dashboard = file("components", "admin", "AdminDashboard.tsx");
        assert.ok(dashboard.includes('label: "My Workspaces"') && dashboard.includes('label: "Members"'));
        const members = file("components", "admin", "MembersView.tsx");
        for (const label of ["Manage Organization Members", "Invite a Member", "members-invite-email", "members-invite-role", '<option value="member">member</option>', 'isBusy ? "Working…" : "Invite"']) {
            assert.ok(members.includes(label), label);
        }
        assert.ok(members.includes("licenses used"), "the counter reads '1 of N licenses used'");
        assert.match(members, /\$\{used\} of \$\{limit\} \$\{limit === 1 \? "license" : "licenses"\} used/);
        assert.ok(members.includes("Active members and pending invitations count toward the organization"));
        assert.match(members, /<label className="ha-label" htmlFor="members-organization">\s*Organization\s*<\/label>/);
    });
});

describe("onboarding email: the mobile app flow it describes exists", { skip: !haveMobile && "Mobile app project is not checked out next to this one" }, () => {
    it("has Sign in and Create account, registers with name + email + 8-character password, and needs no checkout for workspace access", () => {
        const i18n = readFileSync(resolve(mobile, "src", "components", "i18n.ts"), "utf8");
        assert.ok(i18n.includes('signInTitle: "Sign in"'));
        assert.ok(i18n.includes('createAccountLink: "Create account"'));
        assert.ok(i18n.includes("No individual checkout is needed for workspace access."));
        assert.ok(i18n.includes("Workspace access is applied automatically when your organization invites the email address you use to sign in."));
        const service = readFileSync(resolve(mobile, "src", "components", "utils", "authService.ts"), "utf8");
        assert.match(service, /"\/auth\/register"/);
        assert.match(service, /input\.password\.length < 8/);
        assert.match(service, /Email verification is not supported by the backend yet/, "so there is no verification step to describe");
        assert.match(readFileSync(resolve(mobile, "src", "screens", "SignInScreen.tsx"), "utf8"), /t\("createAccountLink"\)|createAccountLink/);
    });
});

// ---------------------------------------------------------------------------
// From the migration plan to the email
// ---------------------------------------------------------------------------

describe("purchase summary (the migration plan, in the email's terms)", () => {
    const plan = buildMigrationPlan(readOrdersCsv(resolve(process.cwd(), "orders_export_1.csv")));
    const ready = plan.customers.filter((customer) => customer.status === "ready_create_workspace");

    it("for every migratable customer in the real export, the email's license count IS the migration's license count", () => {
        assert.ok(ready.length > 0);
        const index = buildPurchaseIndex(plan.customers);
        for (const customer of ready) {
            const summary = index.get(customer.email);
            assert.ok(summary, `${customer.orderNumbers.join(",")} has a purchase summary`);
            assert.equal(summary.licenses, customer.licenseQuantity);
            assert.equal(summary.lines.reduce((sum, line) => sum + line.licenses, 0), customer.licenseQuantity);
            const reference = summarizeLicensesByProduct([customer]).reduce((sum, product) => sum + product.licenses, 0);
            assert.equal(summary.licenses, reference);
            // And the email renders without throwing, saying exactly that number.
            const { text } = getLegacyFreeYearEmailContent(emailInput(summary));
            assert.ok(text.includes(`“1 of ${customer.licenseQuantity} ${customer.licenseQuantity === 1 ? "license" : "licenses"} used”`));
        }
        // The emails, taken together, hand out exactly the licenses the migration writes.
        const readyEmails = new Set(ready.map((customer) => customer.email));
        const emailed = [...index].filter(([email]) => readyEmails.has(email)).reduce((sum, [, summary]) => sum + summary.licenses, 0);
        assert.equal(emailed, ready.reduce((sum, customer) => sum + customer.licenseQuantity, 0));
    });

    it("the real export contains all three kinds of customer, and each gets its own wording", () => {
        const kinds = new Set(ready.flatMap((customer) => buildPurchaseSummary(customer)!.lines.map((line) => line.kind)));
        assert.deepEqual([...kinds].sort(), ["dyha", "large_venue_kit", "small_venue_kit"]);
    });

    it("a customer with no qualifying purchase has no summary, so nothing can be emailed for them", () => {
        const none = plan.customers.filter((customer) => customer.status !== "ready_create_workspace" && customer.qualifyingOrderCount === 0);
        assert.ok(none.length > 0);
        for (const customer of none) assert.equal(buildPurchaseSummary(customer), null);
    });

    it("a product with no customer wording is refused loudly instead of being described wrongly", () => {
        assert.throws(() => purchaseLine("some_future_product", 1, 1), /No customer-email wording for product rule "some_future_product"/);
    });
});
