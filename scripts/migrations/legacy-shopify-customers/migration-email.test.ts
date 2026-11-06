/**
 * The onboarding emails: which template each purchase gets, the content of each template,
 * instructions that match what the application really does, link handling, HTML safety, and
 * text/HTML parity.
 *
 * Pure: nothing here reaches a database, a mail server or the network. Some tests read the
 * source of the Admin Portal, the backend and the mobile app to prove that every label and
 * behaviour the emails describe exists ("drift guards"); the ones that need the sibling
 * projects skip themselves when those folders are not checked out next to this one.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { DEFAULT_HEALTHAGE_ANDROID_URL, DEFAULT_HEALTHAGE_IOS_URL, DEFAULT_HEALTHAGE_MACOS_URL, DEFAULT_HEALTHAGE_WINDOWS_URL, emailConfigIssues, readEmailConfig } from "./apply-core.ts";
import { buildMigrationPlan, summarizeLicensesByProduct } from "./build-plan.ts";
import {
    ADMIN_PORTAL_URL,
    EMAIL_SUBJECTS,
    emailSubjectFor,
    formatEmailDate,
    getLegacyFreeYearEmailContent,
    isSafeHttpUrl,
    selectEmailTemplate,
    type EmailTemplateKind,
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

/** True if a body sends the reader to the Admin Portal (the portal address itself, not the /download/ page on the same host). */
const mentionsPortal = (body: string): boolean => /healthage\.healthexporesources\.com\/(?!download\/)/.test(body) || /Admin Portal/.test(body.replace(/You do not need to access the Admin Portal or invite additional members\./g, ""));

const read = (...parts: string[]) => readFileSync(resolve(process.cwd(), ...parts), "utf8");

const ALL_SHAPES: ReadonlyArray<readonly [string, PurchaseSummary]> = [
    ["existing customer, 1 license", dyha(1)],
    ["Small Venue Kit", smallKit(1)],
    ["Large Venue Kit", largeKit(1)],
    ["DYHA with 4 licenses", dyha(4)],
    ["mixed purchase", { licenses: 11, lines: [purchaseLine("health_expo_screening_kit_large", 2, 8), purchaseLine("discover_your_health_age", 1, 3)] }],
];

// ---------------------------------------------------------------------------
// Which template each purchase gets
// ---------------------------------------------------------------------------

describe("onboarding email: product-to-template mapping", () => {
    it("the three subjects are exactly the approved ones", () => {
        assert.equal(EMAIL_SUBJECTS.existing_customer, "Important: Upgrade to the New Discover Your Health Age App – 1 Year FREE Access");
        assert.equal(EMAIL_SUBJECTS.small_venue_kit, "Your Small Venue Kit – Upgrade to the New HealthAge App with 1 Year FREE Access");
        assert.equal(EMAIL_SUBJECTS.large_venue_kit, "Your Large Venue Kit – Upgrade to the New HealthAge App with 1 Year FREE Access");
        assert.equal(new Set(Object.values(EMAIL_SUBJECTS)).size, 3, "three different subjects");
    });

    it("SKU 008 -> existing customer, SKU 004-1 -> Small Venue Kit, SKU 004-2 -> Large Venue Kit (the SKUs come from the product rules)", () => {
        const expected: Record<string, EmailTemplateKind> = { "008": "existing_customer", "004-1": "small_venue_kit", "004-2": "large_venue_kit" };
        for (const rule of ELIGIBLE_PRODUCTS) {
            const sku = rule.expectedSkus[0]!;
            assert.ok(sku in expected, `rule ${rule.id} has a template for SKU ${sku}`);
            const line = purchaseLine(rule.id, 1, 1);
            const template = selectEmailTemplate({ licenses: 1, lines: [line] });
            assert.equal(template, expected[sku], `SKU ${sku}`);
        }
        assert.equal(ELIGIBLE_PRODUCTS.length, 3, "a fourth product needs a template decision before it is emailed");
    });

    it("each purchase is rendered with its own template's subject", () => {
        assert.equal(render(dyha(1)).subject, EMAIL_SUBJECTS.existing_customer);
        assert.equal(render(dyha(5)).subject, EMAIL_SUBJECTS.existing_customer);
        assert.equal(render(smallKit(1)).subject, EMAIL_SUBJECTS.small_venue_kit);
        assert.equal(render(largeKit(1)).subject, EMAIL_SUBJECTS.large_venue_kit);
        for (const [, purchase] of ALL_SHAPES) assert.equal(render(purchase).subject, emailSubjectFor(purchase));
    });

    it("a mixed purchase gets a deterministic template and nothing is discarded (every product and the combined total appear)", () => {
        const largePlusSoftware = { licenses: 8 + 3, lines: [purchaseLine("health_expo_screening_kit_large", 2, 8), purchaseLine("discover_your_health_age", 1, 3)] };
        const smallPlusSoftware = { licenses: 1 + 2, lines: [purchaseLine("health_expo_screening_kit_small", 1, 1), purchaseLine("discover_your_health_age", 1, 2)] };
        const smallPlusLarge = { licenses: 1 + 4, lines: [purchaseLine("health_expo_screening_kit_small", 1, 1), purchaseLine("health_expo_screening_kit_large", 1, 4)] };
        assert.equal(selectEmailTemplate(largePlusSoftware), "large_venue_kit");
        assert.equal(selectEmailTemplate(smallPlusSoftware), "small_venue_kit");
        assert.equal(selectEmailTemplate(smallPlusLarge), "large_venue_kit");
        // Order of the lines does not change the choice.
        assert.equal(selectEmailTemplate({ ...largePlusSoftware, lines: [...largePlusSoftware.lines].reverse() }), "large_venue_kit");

        for (const purchase of [largePlusSoftware, smallPlusSoftware, smallPlusLarge]) {
            const { text, html } = render(purchase);
            for (const body of [text, htmlToText(html)]) {
                assert.match(body, new RegExp(`Your purchases include ${purchase.licenses} licenses in total`));
                for (const line of purchase.lines) assert.ok(body.includes(line.label), `lists ${line.label}`);
            }
            assert.match(text, /Licenses: \d+ licenses/);
            assert.match(text, new RegExp(`up to ${purchase.licenses - 1} additional members`));
        }
    });

    it("every customer in the real export gets the template their SKU-derived products call for", () => {
        const plan = buildMigrationPlan(readOrdersCsv(resolve(process.cwd(), "orders_export_1.csv")));
        const ready = plan.customers.filter((customer) => customer.status === "ready_create_workspace");
        assert.ok(ready.length > 0);
        const seen = new Set<EmailTemplateKind>();
        for (const customer of ready) {
            const summary = buildPurchaseSummary(customer)!;
            const kinds = new Set(summary.lines.map((line) => line.kind));
            const expected: EmailTemplateKind = kinds.has("large_venue_kit") ? "large_venue_kit" : kinds.has("small_venue_kit") ? "small_venue_kit" : "existing_customer";
            const email = getLegacyFreeYearEmailContent(emailInput(summary));
            assert.equal(email.subject, EMAIL_SUBJECTS[expected], customer.orderNumbers.join(","));
            seen.add(expected);
            // The route follows the real license count: one license never sees the Admin Portal.
            if (summary.licenses === 1) assert.equal(mentionsPortal(email.text), false, "a single license never goes through the Admin Portal");
            else assert.match(email.text, /Open the HealthAge Admin Portal/);
        }
        assert.deepEqual([...seen].sort(), ["existing_customer", "large_venue_kit", "small_venue_kit"], "the real export exercises every template");
    });
});

// ---------------------------------------------------------------------------
// Template 1: existing customers (Discover Your Health Age, 1 license)
// ---------------------------------------------------------------------------

describe("onboarding email: existing customer (Discover Your Health Age, 1 license)", () => {
    const { text, html } = render(dyha(1));
    const plain = htmlToText(html);

    it("announces the new version and the free year", () => {
        for (const body of [text, plain]) {
            assert.match(body, /Your New HealthAge Experience Is Ready!/);
            assert.match(body, /Thank you for being a Discover Your Health Age customer!/);
            assert.match(body, /new and improved version of Discover Your Health Age/);
            assert.match(body, /we’re giving you 1 full year of FREE access to the new software/);
            assert.match(body, /Android/);
            assert.match(body, /iOS \(iPhone and iPad\)/);
            assert.match(body, /Windows/);
            assert.match(body, /macOS/);
        }
        assert.match(text, /WHAT’S NEW\?/);
    });

    it("shows the one-year entitlement: access, start and expiry dates, and the registered purchase email", () => {
        assert.match(text, /Your existing purchase qualifies you for one full year of free access to the new software\./);
        assert.match(text, /Access: 1 Year FREE\nStart Date: 4 November 2026\nExpiry Date: 4 November 2027\nRegistered Email: jordan\.lee@example\.com/);
        for (const fact of ["1 Year FREE", "4 November 2026", "4 November 2027", "jordan.lee@example.com"]) assert.ok(plain.includes(fact), `html: ${fact}`);
    });

    it("tells existing customers to sign in with their existing account, using the purchase email", () => {
        assert.deepEqual(textSteps(text), ["Download the New HealthAge App", "Sign In to Your HealthAge Account", "Start Using the New HealthAge App"]);
        assert.match(text, /Already have a HealthAge account\? You do not need to create a new one\. Open the new app and sign in using your existing HealthAge email address and password\./);
        assert.match(text, /please use the same email address associated with your original purchase \(“jordan\.lee@example\.com”\)\. Your free access is linked to this email address\./);
        assert.match(text, /Once you sign in, your one-year free access will be activated automatically\./);
        assert.match(text, /No additional purchase or payment is required\./);
    });

    it("never tells anyone to create a duplicate account, and offers password recovery instead of assuming passwords work", () => {
        const creates = text.match(/create (a )?(new|second|another)\b/gi) ?? [];
        const negated = text.match(/(do not|don’t|not need to) (need to )?create (a )?(new|second|another)\b/gi) ?? [];
        assert.equal(creates.length, negated.length, `every mention of creating an account is a warning not to: ${creates.join(" | ")}`);
        assert.match(text, /If you already have an account, please do not create a second one\./);
        assert.match(text, /Forgot your password\? On the sign-in screen select “Forgot password\?” and follow the steps to reset it\./);
        // No account migration or password import is promised: there is none.
        assert.doesNotMatch(text, /migrat(e|ed|ion) your account|your old (account|password)|legacy (account|password)|transfer(red)? your/i);
    });

    it("is the direct route: no Admin Portal, workspace or member instructions", () => {
        assert.equal(mentionsPortal(text) || mentionsPortal(html), false);
        assert.doesNotMatch(text, /My Workspaces|Manage Organization Members|Invite a Member|workspace|additional member/i);
        assert.doesNotMatch(html, /Open Admin Portal/);
    });

    it("has the support contact, and says nothing a second time that the discontinuation notice already says", () => {
        assert.doesNotMatch(text, /Important Upgrade Information/i, "that section only repeated the notice, so it is gone");
        assert.doesNotMatch(text, /replaces the previous software|provides access across Android, iOS, Windows and macOS|to continue enjoying your HealthAge experience/);
        assert.match(text, /If you have any difficulty accessing your free entitlement or signing in, contact us at support@healthexporesources\.com\./);
        assert.match(text, /Warm regards,\nPastor Rodney Bowes\nHealthAge Support Team\nDiscover Your Health Age$/);
    });
});

// ---------------------------------------------------------------------------
// Template 2: Small Venue Kit (1 license)
// ---------------------------------------------------------------------------

describe("onboarding email: Small Venue Kit (1 license)", () => {
    const small = smallKit(1);
    const { text, html } = render(small);
    const plain = htmlToText(html);

    it("is exactly one license, from the product rules, and never says four or pluralises it", () => {
        assert.equal(small.licenses, perUnit("health_expo_screening_kit_small"));
        assert.equal(small.licenses, 1);
        assert.match(text, /Purchase: Small Venue Kit × 1\nLicenses: 1 license\n/);
        assert.match(text, /Your Small Venue Kit includes one license for your personal use\./);
        assert.match(text, /your Small Venue Kit purchase qualifies you for 1 full year of FREE access to the new software/);
        assert.doesNotMatch(text, /\b1 licenses\b|\b4 licenses\b|four licenses|Large Venue Kit/i);
        for (const fact of ["Small Venue Kit × 1", "1 license"]) assert.ok(plain.includes(fact), `html: ${fact}`);
    });

    it("shows the one-year entitlement details", () => {
        assert.match(text, /Registered Email: jordan\.lee@example\.com\nAccess Period: 1 Year FREE\nStart Date: 4 November 2026\nExpiry Date: 4 November 2027/);
    });

    it("sends the purchaser straight to the app: download, sign in or create an account, start", () => {
        assert.deepEqual(textSteps(text), ["Download the New HealthAge App", "Open the App and Sign In", "Start Using HealthAge"]);
        assert.match(text, /Already have a HealthAge account\? Sign in using your existing email address and password\./);
        assert.match(text, /New to HealthAge\? Select “Create Account” and register using the same email address associated with your purchase \(“jordan\.lee@example\.com”\)\./);
        assert.match(text, /Your one-year free access will activate automatically once you sign in with your eligible purchase email\./);
        assert.match(text, /No additional purchase or payment is required\./);
    });

    it("never sends a Small Venue Kit purchaser to the Admin Portal, and has no workspace or invitation instructions", () => {
        assert.equal(mentionsPortal(text), false, "text");
        assert.equal(mentionsPortal(html), false, "html");
        assert.doesNotMatch(html, /Open Admin Portal/);
        assert.doesNotMatch(text, /My Workspaces|Manage Organization Members|Invite a Member|Select “Members”|Organization\b|Your Team Members|invitation email|Invite your/i);
        assert.doesNotMatch(text, /additional member seats|up to \d+ additional|workspace owner|Workspace:/i);
        // The one sentence that names the portal says the purchaser does not need it.
        assert.match(text, /You do not need to access the Admin Portal or invite additional members\./);
        assert.deepEqual(text.match(/https?:\/\/\S+/g), [LINKS.androidUrl, LINKS.iosUrl, LINKS.windowsUrl, LINKS.macosUrl], "the only links are the four app downloads");
        // Also with the real default links (the macOS download page shares the portal's host).
        const withDefaults = getLegacyFreeYearEmailContent(emailInput(small, { androidUrl: DEFAULT_HEALTHAGE_ANDROID_URL, iosUrl: DEFAULT_HEALTHAGE_IOS_URL, windowsUrl: DEFAULT_HEALTHAGE_WINDOWS_URL, macosUrl: DEFAULT_HEALTHAGE_MACOS_URL }));
        assert.equal(mentionsPortal(withDefaults.text) || mentionsPortal(withDefaults.html), false);
        assert.ok(withDefaults.text.includes(DEFAULT_HEALTHAGE_MACOS_URL));
    });

    it("keeps the personal-licence and no-portal facts (now beside the access details) and the support contact", () => {
        assert.doesNotMatch(text, /Important Upgrade Information/i);
        assert.doesNotMatch(text, /replaces the previous version|to continue enjoying your HealthAge experience/);
        // Under "Your Free Access", straight after the details card, before the instructions.
        const facts = text.indexOf("Your Small Venue Kit includes one license for your personal use.");
        assert.ok(text.indexOf("YOUR FREE ACCESS") < facts && facts < text.indexOf("HOW TO SWITCH TO THE NEW VERSION"));
        assert.ok(text.indexOf("You do not need to access the Admin Portal or invite additional members.") > facts);
        assert.match(text, /If you need assistance, contact us at support@healthexporesources\.com\./);
        assert.match(text, /We’re excited for you to experience the new HealthAge!/);
    });
});

// ---------------------------------------------------------------------------
// Template 3: Large Venue Kit (4 licenses)
// ---------------------------------------------------------------------------

describe("onboarding email: Large Venue Kit (4 licenses)", () => {
    const large = largeKit(1);
    const { text, html } = render(large);
    const plain = htmlToText(html);

    it("uses the migration's real license count (4 comes from the product rules, not from the email)", () => {
        assert.equal(large.licenses, perUnit("health_expo_screening_kit_large"));
        assert.equal(large.licenses, 4);
        assert.match(text, /your Large Venue Kit purchase qualifies you for 1 full year of FREE access to the new software/);
        assert.match(text, /Purchase: Large Venue Kit × 1\nLicenses: 4 licenses\nWorkspace Owner: jordan\.lee@example\.com\nWorkspace: Lee Community Health\nStart Date: 4 November 2026\nExpiry Date: 4 November 2027/);
        assert.match(text, /YOUR 4 LICENSES\nYour Large Venue Kit includes 4 licenses:/);
        assert.match(plain, /Your Large Venue Kit includes 4 licenses:/);
    });

    it("explains one owner license and three additional member licenses", () => {
        for (const body of [text, plain]) {
            assert.match(body, /1 license for you as the workspace owner\./);
            assert.match(body, /3 additional licenses for your team members\./);
            assert.match(body, /You can invite up to 3 additional members through the HealthAge Admin Portal\./);
        }
        assert.match(text, /Your owner account uses one license, leaving 3 licenses available for your team\./);
        assert.match(text, /“1 of 4 licenses used”/);
    });

    it("sends the owner to the Admin Portal and walks through workspace, licenses and invitations", () => {
        assert.deepEqual(textSteps(text), [
            "Open the HealthAge Admin Portal",
            "Sign In to Your Account",
            "Open Your Workspace",
            "Check Your Licenses",
            "Invite Your Team Members",
            "Your Team Members Can Get Started",
        ]);
        assert.ok(text.includes(`Open Admin Portal: ${ADMIN_PORTAL_URL}`), "primary button");
        assert.ok(text.includes(`Go to ${ADMIN_PORTAL_URL}. This is the official HealthAge Admin Portal`));
        assert.match(text, /After signing in, go to “My Workspaces”\. Your workspace is named “Lee Community Health”\./);
        assert.match(text, /Open the “Manage Organization Members” section\. At the start it reads “1 of 4 licenses used”\./);
        assert.match(text, /Select “Members” from the menu\. Under “Invite a Member”:/);
        assert.match(text, /- Enter the member’s email address\.\n\s+- Keep the role set to “member”\.\n\s+- Select “Invite”\./);
        assert.match(text, /You can invite up to 3 additional members: your 4 licenses minus the one you use\./);
        assert.match(text, /Each invited member receives an invitation email from HealthAge\./);
    });

    it("signs the owner in with the purchase email, with the existing-account and new-account paths", () => {
        assert.match(text, /Your workspace and 4 licenses are linked to your purchase email address, so always use “jordan\.lee@example\.com”\./);
        assert.match(text, /Already have a HealthAge account\? Sign in using your existing email address and password\./);
        assert.match(text, /New to HealthAge\? Select “Sign up”, enter your full name, “jordan\.lee@example\.com” as the email and a password of at least 8 characters, then select “Create account”\./);
    });

    it("tells invited members to use the app (not the portal) and that their license activates automatically", () => {
        const members = text.slice(text.indexOf("6. Your Team Members Can Get Started"), text.indexOf("DOWNLOAD THE NEW HEALTHAGE APP"));
        assert.match(members, /Open the invitation email from HealthAge\./);
        assert.match(members, /Select “Create Account” in the app and register with the invited email address, or select “Sign In” if they already have an account\./);
        assert.match(members, /Their allocated license activates automatically\. No additional purchase is required\./);
        assert.doesNotMatch(members, /Admin Portal|healthage\.healthexporesources\.com/);
    });

    it("lists the four platforms, says no payment is needed (beside the licenses it is about) and gives the support contact", () => {
        assert.match(text, /DOWNLOAD THE NEW HEALTHAGE APP\nInstall the app on your device and sign in with “jordan\.lee@example\.com”: your own license activates automatically\./);
        assert.doesNotMatch(text, /Important Upgrade Information/i);
        assert.match(text, /You can invite up to 3 additional members through the HealthAge Admin Portal\.\n\nNo additional purchase or payment is required for your 4 licenses\./);
        assert.ok(text.indexOf("YOUR 4 LICENSES") < text.indexOf("No additional purchase or payment is required for your 4 licenses.") && text.indexOf("No additional purchase or payment is required for your 4 licenses.") < text.indexOf("HOW TO SWITCH TO THE NEW VERSION"));
        assert.match(text, /If you have any difficulty accessing your workspace or licenses, contact us at support@healthexporesources\.com\./);
        assert.match(text, /We’re excited for you and your team to experience the new HealthAge!/);
    });

    it("never shows Small Venue Kit wording", () => {
        assert.doesNotMatch(text, /Small Venue Kit|personal use|one license for your/i);
    });
});

// ---------------------------------------------------------------------------
// The route follows the real license count, whatever the product
// ---------------------------------------------------------------------------

describe("onboarding email: Discover Your Health Age with N licenses", () => {
    it("states the real number of licenses, whatever it is", () => {
        for (let n = 1; n <= 12; n += 1) {
            const { text, html } = render(dyha(n));
            const plain = htmlToText(html);
            assert.equal(EMAIL_SUBJECTS.existing_customer, render(dyha(n)).subject, "software purchases always get the existing-customer subject");
            if (n === 1) {
                assert.doesNotMatch(text, /Licenses:|additional member|Invite a Member/);
                assert.match(text, /Registered Email: /);
                continue;
            }
            const extra = n - 1;
            const word = (k: number) => `${k} ${k === 1 ? "license" : "licenses"}`;
            assert.ok(text.includes(`YOUR ${n} LICENSES\nYour Discover Your Health Age purchase includes ${word(n)}:`), `n=${n}: headline`);
            assert.ok(plain.includes(`Your Discover Your Health Age purchase includes ${word(n)}:`), `n=${n} (html)`);
            assert.ok(text.includes(`Licenses: ${word(n)}`), `n=${n}: details`);
            assert.ok(text.includes(`“1 of ${n} licenses used”`), `n=${n}: counter`);
            assert.ok(text.includes(`up to ${extra} additional member${extra === 1 ? "" : "s"}`), `n=${n}: invites ${extra}`);
            assert.ok(text.includes(`No additional purchase or payment is required for your ${word(n)}.`), `n=${n}: no payment`);
            // A software purchase with a team keeps its own intro (What's New) and the workspace route.
            assert.match(text, /WHAT’S NEW\?/);
            assert.match(text, /Open the HealthAge Admin Portal/);
        }
    });

    it("keeps the venue-kit and software wording apart", () => {
        assert.doesNotMatch(render(dyha(3)).text, /Venue Kit/);
        assert.doesNotMatch(render(largeKit(1)).text, /Discover Your Health Age purchase includes|WHAT’S NEW/);
    });
});

describe("onboarding email: other combinations always follow the real counts", () => {
    it("two Small Venue Kits are two licenses, so the second one can be given to a member through the workspace", () => {
        const two = render(smallKit(2));
        assert.equal(selectEmailTemplate(smallKit(2)), "small_venue_kit");
        assert.match(two.text, /Your 2 Small Venue Kits include 2 licenses:/);
        assert.match(two.text, /Purchase: Small Venue Kit × 2\nLicenses: 2 licenses/);
        assert.match(two.text, /1 additional license for your team members\./);
        assert.match(two.text, /up to 1 additional member\b/);
        assert.match(two.text, /Open the HealthAge Admin Portal/, "more than one license needs the portal to hand one on");
        assert.doesNotMatch(two.text, /Your Small Venue Kit includes one license for your personal use/);
    });

    it("several Large Venue Kits", () => {
        const eight = render(largeKit(2));
        assert.match(eight.text, /Your 2 Large Venue Kits include 8 licenses:/);
        assert.match(eight.text, /Purchase: Large Venue Kit × 2\nLicenses: 8 licenses/);
        assert.match(eight.text, /7 additional licenses for your team members\./);
        assert.match(eight.text, /up to 7 additional members/);
        assert.match(eight.text, /“1 of 8 licenses used”/);
    });

    it("a mixed purchase lists every product line with its own license count", () => {
        const mixed: PurchaseSummary = { licenses: 11, lines: [purchaseLine("health_expo_screening_kit_large", 2, 8), purchaseLine("discover_your_health_age", 1, 3)] };
        const { text, html } = render(mixed);
        for (const body of [text, htmlToText(html)]) {
            assert.match(body, /Your purchases include 11 licenses in total:/);
            assert.match(body, /Large Venue Kit × 2 — 8 licenses/);
            assert.match(body, /Discover Your Health Age — 3 licenses/);
            assert.match(body, /up to 10 additional members/);
        }
        assert.match(text, /your purchases qualify you for 1 full year/);
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
            assert.throws(() => emailSubjectFor(purchase) && render(purchase), /Refusing to build the email/, `${label} (subject path)`);
        }
    });
});

// ---------------------------------------------------------------------------
// Dynamic data
// ---------------------------------------------------------------------------

describe("onboarding email: dynamic information", () => {
    it("carries the customer's own name, address, workspace, product, licenses, dates, links and support address", () => {
        const { text, html } = render(largeKit(1));
        const plain = htmlToText(html);
        for (const [label, value] of [
            ["name", "Hi Jordan Lee,"],
            ["account email", "jordan.lee@example.com"],
            ["workspace", "Lee Community Health"],
            ["start date", "4 November 2026"],
            ["expiry date", "4 November 2027"],
            ["portal", ADMIN_PORTAL_URL],
            ["support", "support@healthexporesources.com"],
            ["licenses", "4 licenses"],
        ] as const) {
            assert.ok(text.includes(value), `text: ${label}`);
            assert.ok(plain.includes(value), `html: ${label}`);
        }
        for (const url of Object.values(LINKS)) {
            assert.ok(text.includes(url), `text link ${url}`);
            assert.ok(html.includes(`href="${url}"`), `html button ${url}`);
        }
        // The footer names the address the message was sent to (the purchase address), in the HTML.
        assert.ok(html.includes("This message was sent to jordan.lee@example.com because of your Discover Your Health Age purchase."));
        assert.ok(html.includes('<a href="mailto:support@healthexporesources.com"'));
    });

    it("every template carries the customer's own details, never another customer's or a sample's", () => {
        for (const [label, purchase] of ALL_SHAPES) {
            const { text, html } = render(purchase);
            for (const body of [text, html]) {
                assert.match(body, /Jordan Lee/, label);
                assert.match(body, /jordan\.lee@example\.com/, label);
                assert.doesNotMatch(body, /sample date|HealthAge Test Customer|test\.customer@example\.com|HealthAge Test Workspace|example\.invalid|undefined|\[Customer|\[Workspace|\[Start|\[Expiry/i, label);
            }
        }
        // The workspace name is only shown where a workspace is (more than one license).
        assert.ok(!render(dyha(1)).text.includes("Lee Community Health"));
        assert.ok(!render(smallKit(1)).text.includes("Lee Community Health"));
        assert.ok(render(largeKit(1)).text.includes("Lee Community Health"));
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
    it("has a separate button for each of the four platforms, in the order Android, iOS, Windows, macOS, each pointing at its own configured URL", () => {
        for (const purchase of [dyha(1), smallKit(1), largeKit(1)]) {
            const { html, text } = render(purchase);
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
            // Inside a step (the direct route) the platforms are summarised first; in the workspace route they have their own section.
            if (purchase.licenses === 1) assert.match(text, /Available on: Android • iOS • Windows • macOS/);
            const order = [...text.matchAll(/^\s*(Android|iOS|Windows|macOS): https/gm)].map((match) => match[1]);
            assert.deepEqual(order, ["Android", "iOS", "Windows", "macOS"]);
        }
    });

    it("the published store links are the defaults, with no environment needed, and they match the backend's own list", () => {
        const config = readEmailConfig({});
        assert.deepEqual(
            [config.androidUrl, config.iosUrl, config.windowsUrl, config.macosUrl],
            [
                "https://play.google.com/store/apps/details?id=com.wtt.healthAge",
                "https://apps.apple.com/in/app/health-age/id6744716742",
                "https://apps.microsoft.com/detail/9P8MFP2CBVL5",
                "https://healthage.healthexporesources.com/download/",
            ]
        );
        assert.deepEqual(emailConfigIssues(config), []);
        const backend = read("src", "modules", "workspace", "workspace.links.ts");
        for (const [key, url] of [["android", config.androidUrl], ["ios", config.iosUrl], ["windows", config.windowsUrl], ["macos", config.macosUrl]] as const) {
            assert.ok(backend.includes(`${key}: "${url}"`), `${key}: the invitation emails (backend) and the migration emails use the same link`);
        }
        // Environment variables still override each default.
        assert.equal(readEmailConfig({ HEALTHAGE_IOS_URL: "https://example.com/ios" }).iosUrl, "https://example.com/ios");
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
    });
});

// ---------------------------------------------------------------------------
// HTML and plain text
// ---------------------------------------------------------------------------

describe("onboarding email: HTML design and email-client compatibility", () => {
    for (const [label, purchase] of ALL_SHAPES) {
        it(`${label}: a self-contained, inline-CSS document with no scripts, stylesheets, images or external files`, () => {
            const { html } = render(purchase);
            assert.match(html, /^<!DOCTYPE html><html lang="en">/);
            for (const forbidden of [/<script/i, /<style/i, /<link\b/i, /<img\b/i, /@import/i, /url\(/i, /<iframe/i, /<form/i, /\son[a-z]+\s*=/i, /javascript:/i, /\ssrc\s*=/i]) {
                assert.doesNotMatch(html, forbidden, String(forbidden));
            }
            assert.ok(html.length < 100_000, `stays under Gmail's 102 KB clipping limit (${html.length} bytes)`);
            const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
            assert.ok(hrefs.length >= 5);
            assert.ok(hrefs.every((href) => /^https?:\/\//.test(href) || /^mailto:[^\s"]+$/.test(href)), `only http(s) and mailto links: ${hrefs.join(" ")}`);
        });
    }

    it("is mobile friendly: viewport, fluid 600px table, stacked full-width buttons, table layout, wrapping long text", () => {
        const { html } = render(largeKit(1));
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        assert.match(html, /width="600" style="width:100%;max-width:600px;"/);
        assert.match(html, /role="presentation"/);
        assert.equal([...html.matchAll(/<table[^>]*max-width:320px[^>]*>/g)].length, 5, "the Admin Portal button plus four download buttons, each its own row");
        assert.equal([...render(smallKit(1)).html.matchAll(/<table[^>]*max-width:320px[^>]*>/g)].length, 4, "the direct route has only the four download buttons");
        assert.match(html, /overflow-wrap:anywhere/, "long URLs and addresses wrap on a narrow phone");
    });

    it("uses the HealthAge navy / white / subtle gold palette, one clear title, section headings and a hidden preheader", () => {
        for (const [, purchase] of ALL_SHAPES) {
            const { html } = render(purchase);
            assert.match(html, /#0B2545/);
            assert.match(html, /#C9A227/);
            assert.match(html, /#FFFFFF/);
            assert.match(html, />HealthAge<\/div>/);
            assert.match(html, />Discover Your Health Age<\/div>/);
            assert.equal([...html.matchAll(/<h1\b/g)].length, 1, "exactly one h1");
            assert.match(html, /<h1[^>]*>Your New HealthAge Experience Is Ready!<\/h1>/);
            assert.match(html, />How to Switch to the New Version<\/h2>/);
            assert.doesNotMatch(html, /Important Upgrade Information/, "the discontinuation notice is the one 'important' announcement");
            assert.match(html, />Your Free Access<\/h2>/);
            assert.match(html, /display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all/);
        }
        assert.match(render(largeKit(1)).html, /<a href="https:\/\/healthage\.healthexporesources\.com\/"[^>]*>Open Admin Portal<\/a>/);
        assert.match(render(dyha(1)).html, />What’s New\?<\/h2>/);
        assert.match(render(largeKit(1)).html, />Your 4 Licenses<\/h2>/);
    });
});

describe("onboarding email: HTML and plain text say the same thing", () => {
    for (const [label, purchase] of ALL_SHAPES) {
        it(`${label}: same steps in the same order, and every fact appears in both`, () => {
            const { text, html } = render(purchase);
            assert.deepEqual(textSteps(text), htmlSteps(html));
            const plain = htmlToText(html);
            const facts = ["Jordan Lee", "jordan.lee@example.com", "4 November 2026", "4 November 2027", "support@healthexporesources.com", "Your New HealthAge Experience Is Ready!", "Pastor Rodney Bowes", "HealthAge Support Team"];
            if (purchase.licenses > 1) facts.push("Lee Community Health", ADMIN_PORTAL_URL);
            for (const fact of facts) assert.ok(text.includes(fact) && plain.includes(fact), `visible in both: ${fact}`);
            for (const url of Object.values(LINKS)) assert.ok(text.includes(url) && html.includes(`href="${url}"`), `link in both: ${url}`);
            for (const line of purchase.lines) assert.ok(text.includes(line.label) && plain.includes(line.label), line.label);
            assert.doesNotMatch(text, /<[a-z][^>]*>|&[a-z]+;/i, "the plain-text version contains no markup");
            // A bold UI label is shown in quotes in text; it must never carry a second pair of its own.
            assert.doesNotMatch(text, /““|””|"“|”"/, "no doubled quotation marks");
            assert.doesNotMatch(plain, /““|””/, "no doubled quotation marks in the HTML either");
            assert.match(text, /\nWarm regards,\nPastor Rodney Bowes\nHealthAge Support Team\nDiscover Your Health Age$/);
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
        for (const [, purchase] of ALL_SHAPES) {
            const { text } = render(purchase);
            assert.doesNotMatch(text, /verification (code|link|email)|verify your email|confirm your email|activation (link|code)|one-time|OTP|magic link/i);
            assert.doesNotMatch(text, /enter your (license|licence) (key|code)/i);
            assert.doesNotMatch(text, /license key|licence key|serial number|billing portal|settings page|admin approval is required/i);
            assert.doesNotMatch(text, /accept the invitation|accept invitation|invitation (link|token|code)/i, "there is no per-invitation link or accept step in the application");
        }
    });

    it("tells a workspace owner to use exactly the purchase address, that no approval is needed, and to ask support if access does not activate", () => {
        const { text, html } = render(largeKit(1));
        assert.match(text, /There is no approval step and nothing to wait for: as an eligible purchaser you can sign in as soon as your account is created\./);
        assert.match(text, /If you see “Account not authorized”, or your workspace does not appear after you sign in, please contact us at support@healthexporesources\.com\./);
        assert.ok(html.includes("There is no approval step and nothing to wait for"), "HTML has the no-approval sentence");
        assert.ok(html.includes('<a href="mailto:support@healthexporesources.com"'), "HTML keeps the support link");
    });

    it("never mentions an approval the portal does not require (the old sign-up notice is gone)", () => {
        for (const [, purchase] of ALL_SHAPES) {
            const { text, html } = render(purchase);
            for (const body of [text, html]) {
                assert.doesNotMatch(body, /requires admin approval|admin approval is required|platform admin will review|awaiting approval|wait for (an )?admin/i);
                assert.doesNotMatch(body, /the page may say/i);
            }
        }
    });

    it("every template offers a support address for when access does not activate", () => {
        for (const [, purchase] of ALL_SHAPES) {
            const { text, html } = render(purchase);
            assert.match(text, /contact us at support@healthexporesources\.com\./);
            assert.ok(html.includes('<a href="mailto:support@healthexporesources.com"'));
        }
    });
});

// ---------------------------------------------------------------------------
// The discontinuation notice
// ---------------------------------------------------------------------------

// Written out in full on purpose: if the shared wording is ever changed, this must be changed deliberately.
const NOTICE_TITLE = "Important: Discontinuation of the Previous HealthAge Software";
const NOTICE_BODY =
    "We are discontinuing the previous version of HealthAge and transitioning all users to our new and improved HealthAge application. The old software will no longer be supported. Please switch to the new HealthAge application to continue enjoying your HealthAge services. Your existing purchase includes one year of free access to the new version.";

describe("onboarding email: the discontinuation notice", () => {
    const SHAPES: ReadonlyArray<readonly [string, PurchaseSummary]> = [
        ...ALL_SHAPES,
        ["two Small Venue Kits", smallKit(2)],
        ["two Large Venue Kits", largeKit(2)],
    ];

    it("is in the HTML and the plain-text version of every template, word for word, exactly once", () => {
        for (const [label, purchase] of SHAPES) {
            const { text, html } = render(purchase);
            assert.equal(text.split(NOTICE_TITLE).length - 1, 1, `${label}: title once in the text`);
            assert.equal(text.split(NOTICE_BODY).length - 1, 1, `${label}: wording once in the text`);
            assert.equal(html.split(NOTICE_TITLE).length - 1, 1, `${label}: title once in the HTML`);
            assert.equal(htmlToText(html).split(NOTICE_BODY).length - 1, 1, `${label}: wording once in the HTML`);
        }
    });

    it("covers each of the three templates, on both the direct and the workspace route", () => {
        const covered = new Map<string, string>();
        for (const [, purchase] of SHAPES) {
            const { subject, text } = render(purchase);
            assert.ok(text.includes(NOTICE_TITLE));
            covered.set(`${selectEmailTemplate(purchase)}/${purchase.licenses === 1 ? "direct" : "workspace"}`, subject);
        }
        assert.deepEqual([...covered.keys()].sort(), ["existing_customer/direct", "existing_customer/workspace", "large_venue_kit/workspace", "small_venue_kit/direct", "small_venue_kit/workspace"]);
    });

    it("is prominent: right after the introduction, above the access details, as a navy panel with a gold rule and title", () => {
        for (const [label, purchase] of SHAPES) {
            const { text, html } = render(purchase);
            const noticeAt = text.indexOf(NOTICE_TITLE);
            assert.ok(text.indexOf("As part of this upgrade") < noticeAt, `${label}: after the introduction`);
            assert.ok(noticeAt < text.indexOf("YOUR FREE ACCESS"), `${label}: before the access details`);
            assert.ok(noticeAt < text.indexOf("HOW TO SWITCH TO THE NEW VERSION"), `${label}: before the instructions`);
            if (purchase.lines.every((line) => line.kind === "dyha")) assert.ok(noticeAt < text.indexOf("WHAT’S NEW?"), `${label}: before What's New`);
            assert.ok(text.includes(`${"=".repeat(60)}\n${NOTICE_TITLE}\n\n`), `${label}: framed in the text version`);

            const panel = html.indexOf(`<td bgcolor="#0B2545" style="background-color:#0B2545;border-top:4px solid #C9A227;`);
            assert.ok(panel > 0, `${label}: navy panel with a gold rule`);
            assert.ok(panel < html.indexOf(">Your Free Access</h2>"), `${label}: panel is above the access details`);
            assert.match(html.slice(panel, panel + 600), new RegExp(`color:#C9A227;[^"]*">${NOTICE_TITLE}</div>`), `${label}: gold title`);
            assert.match(html.slice(panel, panel + 1400), /color:#FBF6E6;/, `${label}: ivory text`);
        }
    });

    it("gives no date and does not say the old software is already switched off", () => {
        for (const [label, purchase] of SHAPES) {
            const { text } = render(purchase);
            const start = text.indexOf(NOTICE_TITLE);
            const notice = text.slice(start, text.indexOf("=".repeat(60), start));
            assert.doesNotMatch(notice, /\d/, `${label}: no date or number`);
            assert.doesNotMatch(notice, /already|shut down|switched off|no longer (available|accessible)|has been (closed|shut|switched)/i, `${label}: no claim that it is already off`);
        }
    });

    it("does not displace anything: each template still has its own instructions, links, sign-in guidance and support address", () => {
        const direct = render(smallKit(1)).text;
        assert.deepEqual(textSteps(direct), ["Download the New HealthAge App", "Open the App and Sign In", "Start Using HealthAge"]);
        assert.match(direct, /Select “Create Account” and register using the same email address associated with your purchase/);
        assert.equal(mentionsPortal(direct), false, "the Small Venue Kit still never goes through the Admin Portal");
        const existing = render(dyha(1)).text;
        assert.deepEqual(textSteps(existing), ["Download the New HealthAge App", "Sign In to Your HealthAge Account", "Start Using the New HealthAge App"]);
        const workspace = render(largeKit(1)).text;
        assert.deepEqual(textSteps(workspace), [
            "Open the HealthAge Admin Portal",
            "Sign In to Your Account",
            "Open Your Workspace",
            "Check Your Licenses",
            "Invite Your Team Members",
            "Your Team Members Can Get Started",
        ]);
        for (const [, purchase] of ALL_SHAPES) {
            const { text, html } = render(purchase);
            for (const url of Object.values(LINKS)) assert.ok(text.includes(url) && html.includes(`href="${url}"`), url);
            assert.match(text, /contact us at support@healthexporesources\.com\./);
        }
    });

    it("is safe HTML: still no scripts, stylesheets, images or event handlers with the notice in place", () => {
        for (const [, purchase] of SHAPES) {
            const { html } = render(purchase);
            for (const forbidden of [/<script/i, /<style/i, /<link\b/i, /<img\b/i, /@import/i, /url\(/i, /\son[a-z]+\s*=/i, /javascript:/i]) assert.doesNotMatch(html, forbidden, String(forbidden));
        }
    });
});

describe("onboarding email: the discontinuation message is said once, and no instruction was lost with the repeats", () => {
    const SHAPES: ReadonlyArray<readonly [string, PurchaseSummary]> = [...ALL_SHAPES, ["two Small Venue Kits", smallKit(2)], ["two Large Venue Kits", largeKit(2)]];
    const count = (body: string, needle: string): number => body.split(needle).length - 1;

    it("the switch request, 'no longer supported' and the transition message appear only in the notice", () => {
        for (const [label, purchase] of SHAPES) {
            const { text, html } = render(purchase);
            const plain = htmlToText(html);
            for (const [name, body] of [["text", text], ["html", plain]] as const) {
                assert.equal(count(body, "will no longer be supported"), 1, `${label} ${name}: 'no longer supported' once`);
                assert.equal(count(body, "Please switch to the new"), 1, `${label} ${name}: 'Please switch to the new' once`);
                assert.equal(count(body, "continue enjoying your"), 1, `${label} ${name}: 'continue enjoying' once`);
                assert.equal((body.match(/discontinu/gi) ?? []).length, 2, `${label} ${name}: only the notice's title and first sentence`);
                assert.doesNotMatch(body, /replaces the previous|provides access across Android, iOS, Windows and macOS|Important Upgrade Information/, `${label} ${name}`);
            }
            // The notice itself is untouched and still leads the content, right after the introduction.
            assert.ok(text.includes(NOTICE_BODY), `${label}: notice wording`);
        }
    });

    it("every instruction the removed section carried that is not a repeat is still there", () => {
        for (const [label, purchase] of SHAPES) {
            const { text } = render(purchase);
            assert.match(text, /No additional purchase or payment is required/, `${label}: no payment is needed`);
            if (purchase.licenses > 1) assert.ok(text.includes(`No additional purchase or payment is required for your ${purchase.licenses} licenses.`), `${label}: stated for the real license count`);
        }
        const small = render(smallKit(1)).text;
        assert.match(small, /Your Small Venue Kit includes one license for your personal use\./);
        assert.match(small, /You do not need to access the Admin Portal or invite additional members\./);
        // The platforms are still listed (existing customers: under What's New and again as download buttons).
        const existing = render(dyha(1)).text;
        for (const platform of ["Android", "iOS (iPhone and iPad)", "Windows", "macOS"]) assert.ok(existing.includes(`- ${platform}`), platform);
        for (const [, purchase] of ALL_SHAPES) for (const url of Object.values(LINKS)) assert.ok(render(purchase).text.includes(url), url);
    });

    it("the page ends as before: the instructions, then the support line, the thanks and the sign-off", () => {
        for (const [label, purchase] of SHAPES) {
            const { text } = render(purchase);
            const lastStep = text.lastIndexOf("\n   ", text.indexOf("contact us at support@"));
            assert.ok(lastStep > 0 && text.indexOf("contact us at support@") > text.indexOf("HOW TO SWITCH TO THE NEW VERSION"), `${label}: support after the instructions`);
            assert.match(text, /Thank you for being part of the Discover Your Health Age community\.\nWe’re excited for you( and your team)? to experience the new HealthAge!\n\nWarm regards,/, label);
        }
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

    it("one license works with no Admin Portal: the app's access comes from the workspace membership, whatever its role", () => {
        // The access decision filters on the workspace and membership state; role is only reported, never required.
        assert.doesNotMatch(entitlement, /eq\(workspaceMembers\.role|inArray\(workspaceMembers\.role|role === "(owner|admin)"/, "no role gate on workspace access");
        assert.match(entitlement, /isWorkspaceAccessActive/);
        assert.match(entitlement, /source: "workspace"/);
    });

    it("a forgotten password can be reset (the existing-customer email points at it)", () => {
        assert.match(auth, /"\/forgot-password"/);
        assert.match(auth, /"\/reset-password"/);
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
        // The emails say there is no approval step, so the sign-up screen must not claim one.
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
    it("has Sign In, Create Account and Forgot password, registers with email + password, and needs no checkout for workspace access", () => {
        const i18n = readFileSync(resolve(mobile, "src", "components", "i18n.ts"), "utf8");
        // The three labels the emails quote.
        assert.ok(i18n.includes('signIn: "Sign In"'));
        assert.ok(i18n.includes('createAccount: "Create Account"'));
        assert.ok(i18n.includes('forgotPasswordQ: "Forgot password?"'));
        assert.ok(i18n.includes('signInTitle: "Sign in"'));
        assert.ok(i18n.includes('createAccountLink: "Create account"'));
        assert.ok(i18n.includes("No individual checkout is needed for workspace access."));
        assert.ok(i18n.includes("Workspace access is applied automatically when your organization invites the email address you use to sign in."));
        const service = readFileSync(resolve(mobile, "src", "components", "utils", "authService.ts"), "utf8");
        assert.match(service, /"\/auth\/register"/);
        assert.match(service, /Email verification is not supported by the backend yet/, "so there is no verification step to describe");
        assert.match(readFileSync(resolve(mobile, "src", "screens", "SignInScreen.tsx"), "utf8"), /t\("createAccountLink"\)|createAccountLink/);
    });

    it("unlocks Pro from the backend's hasAccess alone, so one workspace license needs no portal and no purchase", () => {
        const purchase = readFileSync(resolve(mobile, "src", "components", "utils", "purchase.ts"), "utf8");
        assert.match(purchase, /target\.hasAccess \?\?/);
        assert.match(purchase, /ENTITLEMENT_STATUS_PATH \?\? "\/entitlements\/me"|\/entitlements\/me/);
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
            const n = customer.licenseQuantity;
            if (n === 1) assert.doesNotMatch(text, /Licenses: [2-9]/);
            else assert.ok(text.includes(`“1 of ${n} licenses used”`), `${customer.email}: counter for ${n}`);
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
