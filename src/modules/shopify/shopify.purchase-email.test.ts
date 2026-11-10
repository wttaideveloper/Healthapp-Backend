import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COLOR } from "../../core/email/email-document";
import { WORKSPACE_ADMIN_URL } from "../workspace/workspace.links";
import {
    SHOPIFY_PURCHASE_EMAIL_SUBJECTS,
    buildShopifyPurchaseEmail,
    selectShopifyPurchaseTemplate,
    summarizeShopifyPurchaseLines,
    type ShopifyPurchaseEmailContent,
    type ShopifyPurchaseLine,
} from "./shopify.purchase-email";
import {
    SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
    SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
} from "./shopify.constants";
import { parseShopifyOrderLineItems } from "./shopify.license";

const PRODUCT = {
    large: SHOPIFY_LARGE_VENUE_KIT_PRODUCT_ID,
    small: SHOPIFY_SMALL_VENUE_KIT_PRODUCT_ID,
    unrelated: "9999999999999",
} as const;

const LARGE: ShopifyPurchaseLine = { productId: "large_venue_kit", label: "Large Venue Kit", quantity: 1, licenses: 4 };
const SMALL: ShopifyPurchaseLine = { productId: "small_venue_kit", label: "Small Venue Kit", quantity: 1, licenses: 1 };
const DISCOVER: ShopifyPurchaseLine = { productId: "discover_your_health_age", label: "Discover Your Health Age", quantity: 1, licenses: 1 };

function content(overrides: Partial<ShopifyPurchaseEmailContent> = {}): ShopifyPurchaseEmailContent {
    return {
        recipientEmail: "pat@example.com",
        customerName: "Pat Morgan",
        orderNumber: "1042",
        scenario: "new_workspace",
        workspaceName: "Pat Morgan",
        workspaceOwnerEmail: "pat@example.com",
        accountExists: false,
        lines: [LARGE],
        licensesAdded: 4,
        workspaceTotalLicenses: 4,
        purchasedAt: "2026-11-02T10:00:00.000Z",
        accessExpiresAt: "2027-11-02T10:00:00.000Z",
        hasOtherItems: false,
        ...overrides,
    };
}

const large = (overrides: Partial<ShopifyPurchaseEmailContent> = {}) => buildShopifyPurchaseEmail(content(overrides));
const small = (overrides: Partial<ShopifyPurchaseEmailContent> = {}) =>
    buildShopifyPurchaseEmail(content({ lines: [SMALL], licensesAdded: 1, workspaceTotalLicenses: 1, ...overrides }));
const discover = (overrides: Partial<ShopifyPurchaseEmailContent> = {}) =>
    buildShopifyPurchaseEmail(content({ lines: [DISCOVER], licensesAdded: 1, workspaceTotalLicenses: 1, ...overrides }));

describe("Shopify purchase email: subjects and template selection", () => {
    it("uses the exact subject for each product", () => {
        assert.equal(large().subject, "Your HealthAge Large Venue Kit Purchase Is Confirmed!");
        assert.equal(small().subject, "Your HealthAge Small Venue Kit Purchase Is Confirmed!");
        assert.equal(discover().subject, "Thank You for Purchasing Discover Your Health Age!");
        assert.equal(SHOPIFY_PURCHASE_EMAIL_SUBJECTS.multiple_products, "Your HealthAge Purchase Is Confirmed!");
    });

    it("picks the product's own template for one product, and the consolidated one for a mix", () => {
        assert.equal(selectShopifyPurchaseTemplate([LARGE]), "large_venue_kit");
        assert.equal(selectShopifyPurchaseTemplate([SMALL]), "small_venue_kit");
        assert.equal(selectShopifyPurchaseTemplate([DISCOVER]), "discover_your_health_age");
        assert.equal(selectShopifyPurchaseTemplate([LARGE, SMALL]), "multiple_products");
        assert.equal(selectShopifyPurchaseTemplate([LARGE, SMALL, DISCOVER]), "multiple_products");
    });

    it("the subject is one clean line with no personal data in it", () => {
        for (const subject of Object.values(SHOPIFY_PURCHASE_EMAIL_SUBJECTS)) {
            assert.doesNotMatch(subject, /[\r\n@#0-9]/);
        }
    });
});

describe("Shopify purchase email: reading the order's products", () => {
    it("merges several line items of one product, in the order bought, and flags other items", () => {
        const items = parseShopifyOrderLineItems({
            line_items: [
                { product_id: Number(PRODUCT.small), quantity: 1, title: "Small Venue Kit", variant_title: "Blue" },
                { product_id: Number(PRODUCT.unrelated), quantity: 5, title: "T-Shirt" },
                { product_id: Number(PRODUCT.small), quantity: 2, title: "Small Venue Kit", variant_title: "Red" },
                { product_id: Number(PRODUCT.large), quantity: 1, title: "Large Venue Kit" },
            ],
        });
        const { lines, hasOtherItems } = summarizeShopifyPurchaseLines(items);
        assert.deepEqual(lines, [
            { productId: "small_venue_kit", label: "Small Venue Kit", quantity: 3, licenses: 3 },
            { productId: "large_venue_kit", label: "Large Venue Kit", quantity: 1, licenses: 4 },
        ]);
        assert.equal(hasOtherItems, true);
    });

    it("lists no unsupported product and no zero-quantity line", () => {
        const items = parseShopifyOrderLineItems({
            line_items: [
                { product_id: Number(PRODUCT.unrelated), quantity: 1 },
                { product_id: Number(PRODUCT.large), quantity: 0 },
            ],
        });
        assert.deepEqual(summarizeShopifyPurchaseLines(items).lines, []);
    });
});

describe("Shopify purchase email: Large Venue Kit, new customer", () => {
    const email = large();

    it("confirms the purchase with the customer's name, product, order number and licenses", () => {
        assert.match(email.text, /^Hello Pat Morgan,/);
        assert.match(email.text, /Large Venue Kit Purchase Confirmed/);
        assert.match(email.text, /Payment received\. Thank you!\nOrder #1042 · Large Venue Kit × 1/);
        assert.match(email.text, /Order number: #1042/);
        assert.match(email.text, /Order date: 2 November 2026/);
        assert.match(email.text, /Product: Large Venue Kit × 1/);
        assert.match(email.text, /Licenses: 4 licenses \(4 per kit\)/);
        assert.match(email.text, /4 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(email.text, /Access until: 2 November 2027/);
    });

    it("explains the workspace: 1 licence for the owner, the rest for the team", () => {
        assert.match(email.text, /Your new workspace includes 4 licenses: 1 for you as the workspace owner and 3 licenses for your team\./);
        assert.match(email.text, /Workspace: Pat Morgan\nWorkspace administrator: pat@example\.com/);
    });

    it("keeps the account set-up instructions: portal, create an account with this email, workspace, invite, app", () => {
        assert.match(email.text, new RegExp(`Open Admin Portal: ${WORKSPACE_ADMIN_URL.replace(/\//g, "\\/")}`));
        assert.match(email.text, /1\. Open the HealthAge Admin Portal/);
        assert.match(email.text, /2\. Create your account/);
        assert.match(email.text, /New to HealthAge\? Select “Sign up”, enter your full name, “pat@example\.com” as the email/);
        assert.match(email.text, /3\. Open your workspace/);
        assert.match(email.text, /4\. Invite your team members/);
        assert.match(email.text, /You can invite up to 3 additional members/);
        assert.match(email.text, /5\. Download the HealthAge app/);
        assert.match(email.text, /Android: https:\/\/play\.google\.com\//);
    });

    it("shows the support contact and signs off as HealthAge", () => {
        assert.match(email.text, /Contact us at support@healthexporesources\.com and mention order #1042\./);
        assert.match(email.text, /Warm regards,\nThe HealthAge Team$/);
    });

    it("never promises anything the order did not buy", () => {
        assert.doesNotMatch(email.text, /Small Venue Kit|Discover Your Health Age|free/i);
    });
});

describe("Shopify purchase email: Small Venue Kit", () => {
    it("new customer with one license: direct app route, no Admin Portal or team instructions", () => {
        const email = small();
        assert.match(email.text, /Small Venue Kit Purchase Confirmed/);
        assert.match(email.text, /Licenses: 1 license \(1 per kit\)/);
        assert.match(email.text, /1 LICENSE ADDED TO YOUR WORKSPACE/);
        assert.match(email.text, /Your workspace includes 1 license, for your own use\./);
        assert.match(email.text, /1\. Download the HealthAge app/);
        assert.match(email.text, /2\. Create your account or sign in/);
        assert.match(email.text, /3\. Start using HealthAge/);
        assert.doesNotMatch(email.text, /Open Admin Portal|Invite your team|Invite a Member/);
    });

    it("three kits: 3 licenses, one per kit, and the team route", () => {
        const email = small({ lines: [{ ...SMALL, quantity: 3, licenses: 3 }], licensesAdded: 3, workspaceTotalLicenses: 3 });
        assert.match(email.text, /Licenses: 3 licenses \(1 per kit × 3\)/);
        assert.match(email.text, /3 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(email.text, /You can invite up to 2 additional members/);
    });
});

describe("Shopify purchase email: Discover Your Health Age", () => {
    it("speaks about the app, not venue kits or a team workspace, for a single license", () => {
        const email = discover();
        assert.match(email.text, /Welcome to Discover Your Health Age/);
        assert.match(email.text, /Product: Discover Your Health Age × 1/);
        assert.match(email.text, /Licenses: 1 license \(1 per app\)/);
        assert.match(email.text, /Registered email: pat@example\.com/);
        assert.match(email.text, /Your payment has been received and your Pro access is ready to activate\./);
        assert.match(email.text, /1\. Download the HealthAge app/);
        assert.doesNotMatch(email.text, /Venue Kit|Workspace:|ADDED TO YOUR WORKSPACE|Open Admin Portal/);
    });

    it("gives the buyer the team route when several licenses were bought, because the backend allocates them", () => {
        const email = discover({ lines: [{ ...DISCOVER, quantity: 4, licenses: 4 }], licensesAdded: 4, workspaceTotalLicenses: 4 });
        assert.match(email.text, /Licenses: 4 licenses \(1 per app × 4\)/);
        assert.match(email.text, /4 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(email.text, /Open Admin Portal/);
    });
});

describe("Shopify purchase email: existing customer buying again", () => {
    const base = { scenario: "existing_workspace" as const, workspaceName: "Pat's Church", workspaceTotalLicenses: 8 };

    it("confirms the purchase and shows how many licenses were added and the new total", () => {
        const email = large({ ...base, accountExists: true });
        assert.equal(email.subject, "Your HealthAge Large Venue Kit Purchase Is Confirmed!");
        assert.match(email.text, /4 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(email.text, /Your workspace now has 8 licenses in total\./);
        assert.match(email.text, /The licenses for your “Large Venue Kit” have been added to your existing HealthAge workspace, “Pat's Church”\./);
        assert.match(email.text, /Workspace: Pat's Church/);
    });

    it("a customer who already signs in gets pointers to their licenses, not the full set-up again", () => {
        const email = large({ ...base, accountExists: true });
        assert.match(email.text, /USING YOUR LICENSES/);
        assert.match(email.text, /1\. Open the HealthAge Admin Portal/);
        assert.match(email.text, /2\. Check your licenses/);
        assert.match(email.text, /3\. Invite your team members/);
        assert.match(email.text, /up to 7 additional members/);
        assert.doesNotMatch(email.text, /Create your account|Download the HealthAge app/);
    });

    it("a repeat customer who never created an account still gets the registration steps", () => {
        const email = large({ ...base, accountExists: false });
        assert.match(email.text, /Create your account/);
        assert.match(email.text, /Download the HealthAge app/);
    });

    it("a repeat Small Venue Kit purchase says one license was added", () => {
        const email = small({ ...base, workspaceTotalLicenses: 2, accountExists: true });
        assert.equal(email.subject, "Your HealthAge Small Venue Kit Purchase Is Confirmed!");
        assert.match(email.text, /1 LICENSE ADDED TO YOUR WORKSPACE/);
        assert.match(email.text, /Your workspace now has 2 licenses in total\./);
    });

    it("shows the workspace administrator's address when it is not the buyer's", () => {
        const email = large({ ...base, workspaceOwnerEmail: "owner@example.com", recipientEmail: "buyer@example.com", accountExists: true });
        assert.match(email.text, /Workspace administrator: owner@example\.com/);
        assert.ok(email.html.includes("This message was sent to buyer@example.com because of your HealthAge purchase (order #1042)."));
    });
});

describe("Shopify purchase email: signing in and registering (new customer)", () => {
    it("an existing HealthAge user is told to sign in, not to register", () => {
        const email = large({ accountExists: true });
        assert.match(email.text, /2\. Sign in to your account/);
        assert.match(email.text, /You already have a HealthAge account\. Sign in with “pat@example\.com”/);
        assert.doesNotMatch(email.text, /Create your account|Select “Sign up”/);
    });

    it("a new user is told to register with the exact purchase address", () => {
        const email = large({ accountExists: false });
        assert.match(email.text, /always use this exact address/);
        assert.match(email.text, /please do not create a second one/);
    });

    it("the one-license app route differs for existing and new users", () => {
        assert.match(small({ accountExists: true }).text, /2\. Sign in/);
        assert.match(small({ accountExists: true }).text, /You already have a HealthAge account\. Select “Sign In”/);
        assert.match(small({ accountExists: false }).text, /New to HealthAge\? Select “Create Account”/);
    });
});

describe("Shopify purchase email: mixed orders get one consolidated email", () => {
    const mixed = buildShopifyPurchaseEmail(
        content({ lines: [LARGE, { ...SMALL, quantity: 2, licenses: 2 }, DISCOVER], licensesAdded: 7, workspaceTotalLicenses: 7 })
    );

    it("uses the consolidated subject and title, and lists every product with its licenses", () => {
        assert.equal(mixed.subject, "Your HealthAge Purchase Is Confirmed!");
        assert.match(mixed.text, /Your HealthAge Purchase Is Confirmed\n/);
        assert.match(mixed.text, /Products: Large Venue Kit × 1 — 4 licenses/);
        assert.match(mixed.text, /Small Venue Kit × 2 — 2 licenses/);
        assert.match(mixed.text, /Discover Your Health Age × 1 — 1 license\n/);
    });

    it("states the combined total once, and is a single email", () => {
        assert.match(mixed.text, /7 LICENSES ADDED TO YOUR WORKSPACE/);
        assert.match(mixed.text, /Your new workspace includes 7 licenses: 1 for you as the workspace owner and 6 licenses for your team\./);
        assert.equal((mixed.text.match(/ADDED TO YOUR WORKSPACE/g) ?? []).length, 1);
    });

    it("mentions other items only when the order had some, without naming them", () => {
        assert.doesNotMatch(mixed.text, /Other items in your order/);
        const withOther = large({ hasOtherItems: true });
        assert.match(withOther.text, /Other items in your order\nYour order also included other items\. Those are covered by the separate order confirmation email from our online store\./);
        assert.ok(withOther.html.includes("Other items in your order"));
    });
});

describe("Shopify purchase email: refuses to state wrong numbers", () => {
    it("rejects lines that do not add up to the licenses allocated", () => {
        assert.throws(() => large({ licensesAdded: 5 }), /add up to 4 license\(s\) but the order allocated 5/);
    });

    it("rejects a line whose quantity and licenses are inconsistent", () => {
        assert.throws(() => large({ lines: [{ ...LARGE, quantity: 3, licenses: 4 }], licensesAdded: 4 }), /inconsistent quantity or license numbers/);
    });

    it("rejects an empty order, a bad recipient and a workspace total below what was added", () => {
        assert.throws(() => large({ lines: [], licensesAdded: 0 }), /no HealthAge products/);
        assert.throws(() => large({ recipientEmail: "not-an-address" }), /recipient is not a valid email address/);
        assert.throws(() => large({ workspaceTotalLicenses: 2 }), /workspace total is smaller/);
    });

    it("omits the order number and date when the order has none, instead of printing a blank", () => {
        const email = large({ orderNumber: null, purchasedAt: null });
        assert.doesNotMatch(email.text, /Order number|Order date|mention order/);
        assert.match(email.text, /Contact us at support@healthexporesources\.com\./);
    });

    it("accepts an order number that already starts with #", () => {
        assert.match(large({ orderNumber: "#1042" }).text, /Order number: #1042/);
    });
});

describe("Shopify purchase email: safe with hostile text", () => {
    const hostile = `<script>alert("x")</script> & O'Brien`;

    it("escapes the customer name, workspace name and order number in the HTML and keeps the text literal", () => {
        const email = large({ customerName: hostile, workspaceName: hostile, orderNumber: hostile });
        assert.doesNotMatch(email.html, /<script/i);
        assert.ok(email.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; O&#39;Brien"));
        assert.ok(email.text.includes(hostile));
    });

    it("keeps the subject to one line even if the product label had a line break", () => {
        const email = buildShopifyPurchaseEmail(content({ lines: [{ ...LARGE, label: "Large\r\nBcc: evil@example.com" }] }));
        assert.equal(email.subject, SHOPIFY_PURCHASE_EMAIL_SUBJECTS.large_venue_kit);
    });
});

describe("Shopify purchase email: HTML design and client compatibility", () => {
    const email = large({ hasOtherItems: true });

    it("is the HealthAge navy and gold design: header band, confirmation strip, highlight panel, order card", () => {
        assert.ok(email.html.includes(COLOR.navy));
        assert.ok(email.html.includes(COLOR.gold));
        assert.ok(email.html.includes(COLOR.goldSoft));
        assert.ok(email.html.includes(">HealthAge</div>"));
        assert.ok(email.html.includes("&#10003;"), "the confirmation check mark");
        assert.ok(email.html.includes("Payment received. Thank you!"));
        assert.match(email.html, /font-size:52px[^>]*>4<\/div>/, "the big licence figure");
        assert.ok(email.html.includes(">Order number<"));
    });

    it("is table-based inline-CSS HTML: no <style>, scripts, images, forms or event handlers", () => {
        assert.doesNotMatch(email.html, /<style|<script|<img|<form|<link|<iframe|\son[a-z]+=/i);
        assert.ok(email.html.includes('role="presentation"'));
        assert.match(email.html, /<table[^>]+width="600"[^>]*style="width:100%;max-width:600px;"/);
    });

    it("is responsive: a fluid 600px column, a viewport tag, and full-width buttons capped at 320px", () => {
        assert.ok(email.html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
        assert.match(email.html, /width="100%"[^>]*max-width:320px/);
        assert.doesNotMatch(email.html, /width:(?:6[1-9]\d|[7-9]\d\d|\d{4,})px/, "nothing is fixed wider than the 600px column");
    });

    it("has exactly one h1, an accessible primary button and a hidden preheader", () => {
        assert.equal((email.html.match(/<h1\b/g) ?? []).length, 1);
        assert.ok(email.html.includes("Open Admin Portal</a>"));
        assert.ok(email.html.includes("mso-hide:all"));
        assert.match(email.html, /display:none;max-height:0;overflow:hidden[^>]*>Your payment has been received\./);
    });

    it("links only to plain https URLs and mailto addresses", () => {
        const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
        assert.ok(hrefs.length >= 6);
        assert.ok(hrefs.every((href) => /^https:\/\/[^\s"<>]+$/.test(href) || /^mailto:[^\s"<>]+$/.test(href)), hrefs.join(" "));
    });

    it("says the same things in the HTML and the plain text", () => {
        for (const fact of ["Large Venue Kit × 1", "#1042", "Pat Morgan", "pat@example.com", "support@healthexporesources.com", "2 November 2026", "2 November 2027", "Open the HealthAge Admin Portal"]) {
            assert.ok(email.html.includes(fact), `html has ${fact}`);
            assert.ok(email.text.includes(fact), `text has ${fact}`);
        }
        assert.doesNotMatch(email.text, /<[a-z][\s\S]*>/i, "the text version has no markup");
    });

    it("lets an environment override the store links, and rejects an unsafe one", () => {
        const custom = buildShopifyPurchaseEmail({ ...content(), storeUrls: { android: "https://example.com/android" }, supportEmail: "help@example.com" });
        assert.ok(custom.text.includes("Android: https://example.com/android"));
        assert.ok(custom.text.includes("help@example.com"));
        assert.throws(() => buildShopifyPurchaseEmail({ ...content(), storeUrls: { android: "javascript:alert(1)" } }), /not a plain http\(s\) URL/);
    });
});
