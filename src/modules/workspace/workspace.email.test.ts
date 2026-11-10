import "../shopify/shopify.test-env";

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

import { findInviterDisplayName, getWorkspaceInviteEmailContent, isLegacyMigrationWorkspace } from "./workspace.email";
import { LEGACY_MIGRATION_BILLING_SOURCE, buildWorkspaceInviteEmail } from "./workspace.invite-template";
import { HEALTHAGE_STORE_URLS, HEALTHAGE_SUPPORT_EMAIL, WORKSPACE_ADMIN_URL } from "./workspace.links";

const NEW_URL = "https://healthage.healthexporesources.com/";
// Built from parts so this file does not itself contain the retired address.
const OLD_HOST = ["health-age-admin", "vercel", "app"].join(".");

const root = process.cwd();
const read = (relativePath: string) => readFileSync(join(root, relativePath), "utf8");

const STORE_URLS_IN_ORDER = [HEALTHAGE_STORE_URLS.android, HEALTHAGE_STORE_URLS.ios, HEALTHAGE_STORE_URLS.windows, HEALTHAGE_STORE_URLS.macos];
const htmlToText = (html: string): string =>
    html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");

const memberInput = {
    organizationName: "Grace Fellowship Health Ministry",
    userName: "Maria Lopez",
    userEmail: "maria.lopez@example.com",
    role: "member",
    inviterName: "Jordan Lee",
    accessExpiresAt: "2027-11-05T14:24:52.226Z",
} as const;

describe("Workspace Admin link and app download links", () => {
    it("the Admin address is the confirmed one, and the app links are the published store listings", () => {
        assert.equal(WORKSPACE_ADMIN_URL, NEW_URL);
        assert.deepEqual(STORE_URLS_IN_ORDER, [
            "https://play.google.com/store/apps/details?id=com.wtt.healthAge",
            "https://apps.apple.com/in/app/health-age/id6744716742",
            "https://apps.microsoft.com/detail/9P8MFP2CBVL5",
            "https://healthage.healthexporesources.com/download/",
        ]);
        assert.equal(HEALTHAGE_SUPPORT_EMAIL, "support@healthexporesources.com");
    });
});

describe("member invitation email", () => {
    const { subject, text, html } = getWorkspaceInviteEmailContent(memberInput);
    const plain = htmlToText(html);

    it("is addressed to the invited person, from the inviter, for the workspace, with the role and invited address", () => {
        assert.equal(subject, "You’ve Been Invited to Join Grace Fellowship Health Ministry on HealthAge");
        assert.match(text, /^Hello Maria Lopez,\n\nYou’ve Been Invited to HealthAge!\n\nJordan Lee has invited you to join “Grace Fellowship Health Ministry” on HealthAge\./);
        assert.match(text, /YOUR INVITATION\nWorkspace: Grace Fellowship Health Ministry\nInvited email: maria\.lopez@example\.com\nRole: Member\nInvited by: Jordan Lee\nAccess until: 5 November 2027/);
        for (const fact of ["Maria Lopez", "You’ve Been Invited to HealthAge!", "Jordan Lee has invited you to join", "Grace Fellowship Health Ministry", "maria.lopez@example.com", "Member", "Jordan Lee", "5 November 2027"]) {
            assert.ok(plain.includes(fact), `html: ${fact}`);
        }
    });

    it("tells the invited person they need no subscription", () => {
        for (const body of [text, plain]) {
            assert.match(body, /You do not need to purchase a subscription\. Your workspace administrator has already allocated your license\./);
        }
    });

    it("walks through the real flow: use the invited address, download the app, create an account or sign in, license activates", () => {
        assert.match(text, /GETTING STARTED\n1\. Use your invited email address\n\s+Your invitation is linked to “maria\.lopez@example\.com”\. Create your account or sign in with this exact address: that is how your invitation is accepted\./);
        assert.match(text, /2\. Download the new HealthAge app/);
        assert.match(text, /3\. Create your account or sign in\n\s+Open the app, then:\n\s+- New to HealthAge\? Select “Create Account” and register with “maria\.lopez@example\.com”\.\n\s+- Already have an account\? Select “Sign In” and use “maria\.lopez@example\.com”\./);
        assert.match(text, /4\. Start using HealthAge\n\s+Your allocated license activates automatically once you sign in\./);
    });

    it("has all four platform download links (Android, iOS, Windows, macOS), as buttons and as text", () => {
        assert.deepEqual(text.match(/https?:\/\/\S+/g), STORE_URLS_IN_ORDER, "the only links are the four app downloads, in order");
        for (const [label, url] of [["Android", HEALTHAGE_STORE_URLS.android], ["iOS", HEALTHAGE_STORE_URLS.ios], ["Windows", HEALTHAGE_STORE_URLS.windows], ["macOS", HEALTHAGE_STORE_URLS.macos]] as const) {
            assert.ok(text.includes(`${label}: ${url}`), `${label} text link`);
            assert.match(html, new RegExp(`<a href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>Download for ${label}</a>`), `${label} button`);
        }
    });

    it("does not send a plain member to the Admin Portal (the portal only admits owners and admins)", () => {
        // (The macOS download page shares the portal's host, so look for the portal itself, not the host.)
        const portalAddress = /healthage\.healthexporesources\.com\/(?!download\/)/;
        assert.doesNotMatch(text, portalAddress, "no portal address in the text");
        assert.doesNotMatch(html, portalAddress, "no portal link in the HTML");
        assert.equal(html.includes(`href="${NEW_URL}"`), false);
        assert.doesNotMatch(text, /Admin Portal|Visit:/);
    });

    it("has the support address and a branded footer naming the recipient", () => {
        assert.match(text, /Need help\? Contact us at support@healthexporesources\.com\./);
        assert.ok(html.includes('<a href="mailto:support@healthexporesources.com"'));
        assert.ok(html.includes("This message was sent to maria.lopez@example.com because you were invited to Grace Fellowship Health Ministry on HealthAge."));
        assert.match(html, /HealthAge · Discover Your Health Age/);
    });

    it("is responsive, self-contained, table-based HTML in the HealthAge palette", () => {
        assert.match(html, /^<!DOCTYPE html><html lang="en">/);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        assert.match(html, /width="600" style="width:100%;max-width:600px;"/);
        assert.match(html, /role="presentation"/);
        assert.equal([...html.matchAll(/<table[^>]*max-width:320px[^>]*>/g)].length, 4, "one full-width download button per platform");
        assert.match(html, /overflow-wrap:anywhere/);
        for (const color of ["#0B2545", "#C9A227", "#FFFFFF"]) assert.ok(html.includes(color), color);
        for (const forbidden of [/<script/i, /<style/i, /<link\b/i, /<img\b/i, /@import/i, /url\(/i, /<iframe/i, /<form/i, /\son[a-z]+\s*=/i, /javascript:/i, /\ssrc\s*=/i]) {
            assert.doesNotMatch(html, forbidden, String(forbidden));
        }
        assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
        assert.ok(html.length < 100_000);
    });

    it("never prints a missing or placeholder value", () => {
        const minimal = getWorkspaceInviteEmailContent({ organizationName: "Acme Clinic", userName: "pat", userEmail: "pat@example.com" });
        for (const body of [minimal.subject, minimal.text, minimal.html]) {
            assert.doesNotMatch(body, /undefined|null|\[object|NaN|\$\{|\[Inviter|\[Workspace/);
        }
        // No inviter: the sentence still reads naturally, and the optional rows are simply absent.
        assert.match(minimal.text, /Your workspace administrator has invited you to join “Acme Clinic” on HealthAge\./);
        assert.doesNotMatch(minimal.text, /Invited by:|Access until:/);
        assert.match(minimal.text, /Role: Member/, "the role defaults to member");
    });

    it("a workspace without an expiry date shows no access-until line, and a bad date is ignored rather than printed", () => {
        for (const accessExpiresAt of [null, undefined, "", "soon", new Date("nope")]) {
            const email = getWorkspaceInviteEmailContent({ ...memberInput, accessExpiresAt });
            assert.doesNotMatch(email.text, /Access until/, String(accessExpiresAt));
        }
        const fromDate = getWorkspaceInviteEmailContent({ ...memberInput, accessExpiresAt: new Date("2028-02-09T10:00:00.000Z") });
        assert.match(fromDate.text, /Access until: 9 February 2028/);
    });

    it("has no Accept Invitation button, because the application has no per-invitation link", () => {
        assert.doesNotMatch(text, /Accept Invitation|accept the invitation/i);
        assert.doesNotMatch(html, /Accept Invitation/);
    });

    it("renders an Accept Invitation button with a plain-text fallback link only if a caller supplies an invitation URL", () => {
        const url = "https://example.com/invite/abc123";
        const email = getWorkspaceInviteEmailContent({ ...memberInput, acceptInvitationUrl: url });
        assert.match(email.html, new RegExp(`<a href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>Accept Invitation</a>`));
        assert.ok(email.html.includes("Or copy this link:"), "visible fallback URL");
        assert.ok(email.text.includes(`Accept Invitation: ${url}`));
        assert.throws(() => getWorkspaceInviteEmailContent({ ...memberInput, acceptInvitationUrl: "javascript:alert(1)" }), /not a plain http\(s\) URL/);
    });

    it("an invited admin sees the Admin Portal as well, and the Admin role", () => {
        const admin = getWorkspaceInviteEmailContent({ ...memberInput, role: "admin" });
        assert.match(admin.text, /Role: Admin/);
        assert.match(admin.text, /Manage the workspace \(admins only\)\n\s+As an admin you can also manage members in the Admin Portal: https:\/\/healthage\.healthexporesources\.com\//);
        assert.ok(admin.html.includes(`href="${NEW_URL}"`));
    });
});

// Written out in full on purpose: if the shared wording is ever changed, this must be changed deliberately.
const NOTICE_TITLE = "Important: Discontinuation of the Previous HealthAge Software";
const NOTICE_LEAD =
    "We are discontinuing the previous version of HealthAge and transitioning all users to our new and improved HealthAge application. The old software will no longer be supported. Please switch to the new HealthAge application to continue enjoying your HealthAge services.";
const MEMBER_NOTICE = `${NOTICE_LEAD} Your organization’s existing purchase includes one year of free access to the new version.`;

describe("member invitation email: the discontinuation notice (migrated workspaces)", () => {
    const withNotice = getWorkspaceInviteEmailContent({ ...memberInput, discontinuationNotice: true });
    const without = getWorkspaceInviteEmailContent(memberInput);

    it("is added when the caller asks for it, in the HTML and the plain text, with the member wording", () => {
        assert.ok(withNotice.text.includes(NOTICE_TITLE));
        assert.ok(withNotice.text.includes(MEMBER_NOTICE));
        assert.ok(htmlToText(withNotice.html).includes(NOTICE_TITLE));
        assert.ok(htmlToText(withNotice.html).includes(MEMBER_NOTICE));
        assert.ok(withNotice.text.includes(`${"=".repeat(60)}\n${NOTICE_TITLE}\n\n${MEMBER_NOTICE}\n${"=".repeat(60)}`), "framed in the text version");
    });

    it("never tells a member that THEY made the purchase: it is their organization's", () => {
        assert.equal(withNotice.text.includes("Your existing purchase includes"), false);
        assert.match(withNotice.text, /Your organization’s existing purchase includes one year of free access to the new version\./);
    });

    it("is a prominent navy panel with a gold rule and title and ivory text", () => {
        const panel = withNotice.html.indexOf(`<td bgcolor="#0B2545" style="background-color:#0B2545;border-top:4px solid #C9A227;`);
        assert.ok(panel > 0);
        assert.match(withNotice.html.slice(panel, panel + 600), new RegExp(`color:#C9A227;[^"]*">${NOTICE_TITLE}</div>`));
        assert.match(withNotice.html.slice(panel, panel + 1400), /color:#FBF6E6;/);
    });

    it("sits after the invitation facts and before the steps, so the invitation itself is still first", () => {
        const text = withNotice.text;
        assert.ok(text.indexOf("YOUR INVITATION") < text.indexOf("No subscription needed"));
        assert.ok(text.indexOf("No subscription needed") < text.indexOf(NOTICE_TITLE));
        assert.ok(text.indexOf(NOTICE_TITLE) < text.indexOf("GETTING STARTED"));
        assert.ok(withNotice.html.indexOf(">Your Invitation</h2>") < withNotice.html.indexOf(NOTICE_TITLE), "HTML: after the invitation facts");
        assert.ok(withNotice.html.indexOf(NOTICE_TITLE) < withNotice.html.indexOf(">Getting Started</h2>"), "HTML: before the steps");
    });

    it("is NOT added unless asked for (members of ordinary workspaces are not told about a purchase they never made)", () => {
        assert.equal(without.text.includes(NOTICE_TITLE), false);
        assert.equal(without.html.includes(NOTICE_TITLE), false);
        assert.equal(getWorkspaceInviteEmailContent({ ...memberInput, discontinuationNotice: false }).text.includes(NOTICE_TITLE), false);
    });

    it("an invited admin gets it too, but the owner welcome never does", () => {
        assert.ok(getWorkspaceInviteEmailContent({ ...memberInput, role: "admin", discontinuationNotice: true }).text.includes(NOTICE_TITLE));
        const owner = getWorkspaceInviteEmailContent({ organizationName: "Acme", userName: "Pat", userEmail: "pat@example.com", isOwner: true, discontinuationNotice: true });
        assert.equal(owner.text.includes(NOTICE_TITLE), false);
        assert.equal(owner.html.includes(NOTICE_TITLE), false);
    });

    it("gives no date and does not claim the old software is already off", () => {
        const start = withNotice.text.indexOf(NOTICE_TITLE);
        const notice = withNotice.text.slice(start, withNotice.text.indexOf("=".repeat(60), start));
        assert.doesNotMatch(notice, /\d/);
        assert.doesNotMatch(notice, /already|shut down|switched off|no longer (available|accessible)/i);
    });

    it("changes nothing else: the same steps, the four app links, no portal link, the support address and the no-subscription message", () => {
        const strip = (value: string) => value.replace(/={60}\n[\s\S]*?\n={60}\n\n/, "");
        assert.equal(strip(withNotice.text), without.text);
        assert.deepEqual(withNotice.text.match(/https?:\/\/\S+/g), STORE_URLS_IN_ORDER);
        assert.doesNotMatch(withNotice.text, /healthage\.healthexporesources\.com\/(?!download\/)/);
        assert.match(withNotice.text, /You do not need to purchase a subscription\./);
        assert.match(withNotice.text, /Contact us at support@healthexporesources\.com\./);
        assert.equal(withNotice.subject, without.subject);
    });
});

describe("which workspaces get the notice", () => {
    it("only workspaces created by the legacy migration", () => {
        assert.equal(isLegacyMigrationWorkspace("legacy_shopify_migration"), true);
        for (const other of ["manual", "shopify", "stripe", "", "Legacy_Shopify_Migration", null, undefined]) {
            assert.equal(isLegacyMigrationWorkspace(other as string | null | undefined), false, String(other));
        }
    });

    it("uses the same value the migration writes", () => {
        assert.equal(LEGACY_MIGRATION_BILLING_SOURCE, "legacy_shopify_migration");
        assert.ok(read("scripts/migrations/legacy-shopify-customers/product-eligibility.ts").includes(`workspaceBillingSource: "${LEGACY_MIGRATION_BILLING_SOURCE}"`));
    });

    it("both member-invitation routes decide it from the workspace's billing source, and the owner welcome does not", () => {
        for (const file of ["src/modules/workspace/workspace.route.ts", "src/modules/admin/admin-workspace.route.ts"]) {
            const source = read(file);
            assert.match(source, /import \{[^}]*isLegacyMigrationWorkspace[^}]*\} from "(\.|@modules\/workspace)\/workspace\.email"/, file);
            assert.match(source, /discontinuationNotice: isLegacyMigrationWorkspace\(workspace\.billingSource\),/, file);
        }
        const admin = read("src/modules/admin/admin-workspace.route.ts");
        const ownerCall = admin.slice(admin.indexOf("const ownerMail = getWorkspaceInviteEmailContent"), admin.indexOf("await smtpTransport.sendMail", admin.indexOf("const ownerMail")));
        assert.equal(ownerCall.includes("discontinuationNotice"), false, "the owner welcome call does not ask for the notice");
    });
});

describe("owner / organization welcome email", () => {
    it("tells the workspace administrator to open the Admin Portal, keeps the Workspace Admin subject, and links the apps", () => {
        const email = getWorkspaceInviteEmailContent({ organizationName: "Acme Clinic", userName: "Pat", userEmail: "pat@example.com", isOwner: true });
        assert.match(email.subject, /Workspace Admin/);
        assert.match(email.text, /You have been added as the workspace administrator for “Acme Clinic”\./);
        assert.ok(email.text.includes(`Open Admin Portal: ${NEW_URL}`));
        assert.ok(email.text.includes(`1. Open the HealthAge Admin Portal\n   Go to ${NEW_URL}.`));
        assert.ok(email.html.includes(`<a href="${NEW_URL}"`));
        assert.match(email.html, />Open Admin Portal<\/a>/);
        assert.match(email.text, /Workspace administrator: pat@example\.com\nRole: Owner/);
        for (const url of STORE_URLS_IN_ORDER) assert.ok(email.text.includes(url), url);
    });

    it("Shopify owner-welcome email (owner variant with a custom subject) keeps its subject and links the portal", () => {
        // The generic owner variant with a custom subject (used by the admin-created workspace flow). Shopify purchases now send the product-specific email from shopify.purchase-email.ts instead.
        const email = getWorkspaceInviteEmailContent({
            organizationName: "Eastwood SDA Church",
            userName: "Rhonda McMorris",
            userEmail: "owner@example.com",
            isOwner: true,
            subject: "Complete registration to access your workspace.",
        });
        assert.equal(email.subject, "Complete registration to access your workspace.");
        assert.ok(email.text.includes(NEW_URL));
        assert.ok(email.html.includes(`href="${NEW_URL}"`));
    });

    it("never contains the retired address or an old workspace-admin path", () => {
        for (const isOwner of [true, false]) {
            const email = getWorkspaceInviteEmailContent({ organizationName: "Acme Clinic", userName: "Pat", userEmail: "pat@example.com", isOwner });
            for (const body of [email.subject, email.text, email.html]) {
                assert.equal(body.includes(OLD_HOST), false);
                assert.doesNotMatch(body, /vercel/i);
                assert.doesNotMatch(body, /\/workspace-admin/);
            }
        }
    });
});

describe("invitation email safety", () => {
    it("escapes every dynamic value in the HTML and keeps the plain-text version literal", () => {
        const email = getWorkspaceInviteEmailContent({
            organizationName: `Acme & "Sons" <b>Clinic</b>`,
            userName: `<script>alert(1)</script>`,
            userEmail: `o'brien+test@example.com`,
            inviterName: `Eve <img src=x onerror=alert(1)>`,
        });
        // No real tag or attribute can start: the angle brackets and quotes are all escaped.
        assert.doesNotMatch(email.html, /<script|<img|<b>Clinic/i);
        assert.doesNotMatch(email.html, /<[^>]*\sonerror\s*=/i, "no element carries an event handler");
        assert.match(email.html, /Acme &amp; &quot;Sons&quot; &lt;b&gt;Clinic&lt;\/b&gt;/);
        assert.match(email.html, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt;,/);
        assert.match(email.html, /o&#39;brien\+test@example\.com/);
        assert.match(email.html, /Eve &lt;img src=x onerror=alert\(1\)&gt;/);
        assert.ok(email.text.includes(`Acme & "Sons" <b>Clinic</b>`));
        assert.doesNotMatch(email.text, /&amp;|&lt;|&quot;/);
    });

    it("cannot be used to inject a header through a name (the subject stays on one line)", () => {
        const email = getWorkspaceInviteEmailContent({ organizationName: "Acme\r\nBcc: attacker@example.com", userName: "Pat", userEmail: "pat@example.com" });
        assert.doesNotMatch(email.subject, /[\r\n]/);
        assert.doesNotMatch(email.subject, /Bcc: attacker@example\.com$/m, "no separate header line");
    });

    it("refuses an unsafe download link instead of emitting it", () => {
        assert.throws(() => buildWorkspaceInviteEmail({ ...memberInput, storeUrls: { ios: "javascript:alert(1)" } }), /not a plain http\(s\) URL/);
        assert.throws(() => buildWorkspaceInviteEmail({ ...memberInput, storeUrls: { macos: 'https://example.com/"onmouseover="x' } }), /not a plain http\(s\) URL/);
    });

    it("a configured link or support address replaces the default; a blank one falls back to the default", () => {
        const custom = getWorkspaceInviteEmailContent({ ...memberInput, storeUrls: { ios: "https://example.com/ios" }, supportEmail: "help@example.com" });
        assert.ok(custom.text.includes("iOS: https://example.com/ios"));
        assert.ok(custom.text.includes(`Android: ${HEALTHAGE_STORE_URLS.android}`));
        assert.match(custom.text, /Contact us at help@example\.com\./);
        const blank = getWorkspaceInviteEmailContent({ ...memberInput, storeUrls: { ios: "  " } });
        assert.ok(blank.text.includes(`iOS: ${HEALTHAGE_STORE_URLS.ios}`));
    });
});

describe("findInviterDisplayName", () => {
    const appReturning = (rows: Array<{ name: string }>) =>
        ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) } }) as never;

    it("returns the inviter's name, trimmed", async () => {
        assert.equal(await findInviterDisplayName(appReturning([{ name: "  Jordan Lee " }]), "user-1"), "Jordan Lee");
    });

    it("returns null when there is no such user, no id, or an empty name", async () => {
        assert.equal(await findInviterDisplayName(appReturning([]), "user-1"), null);
        assert.equal(await findInviterDisplayName(appReturning([{ name: "x" }]), undefined), null);
        assert.equal(await findInviterDisplayName(appReturning([{ name: "   " }]), "user-1"), null);
    });

    it("never throws: a failed lookup must not stop an invitation email", async () => {
        const failing = { db: { select: () => { throw new Error("database is down"); } } } as never;
        assert.equal(await findInviterDisplayName(failing, "user-1"), null);
    });
});

describe("Workspace Admin link has a single source and no stale copies", () => {
    function* walk(directory: string): Generator<string> {
        for (const name of readdirSync(directory)) {
            if (["node_modules", "dist", ".git", "migration-reports", "build"].includes(name)) continue;
            const full = join(directory, name);
            if (statSync(full).isDirectory()) yield* walk(full);
            else yield full;
        }
    }
    const textFile = /\.(ts|md|json|ya?ml|sh|html|txt)$/i;

    it("the retired address appears nowhere in source, scripts, docs, or config", () => {
        const files = [
            ...walk(join(root, "src")),
            ...walk(join(root, "scripts")),
            ...["README.md", "ACCESS_MODEL.md", "package.json", "docker-compose.yml", "Dockerfile", "drizzle.config.ts", "tsconfig.json"]
                .map((name) => join(root, name))
                .filter((path) => existsSync(path)),
        ].filter((path) => textFile.test(path) || !/\./.test(path.split(/[\\/]/).pop()!));

        assert.ok(files.length > 20, "expected to scan the repository, found too few files");
        const offenders = files.filter((path) => readFileSync(path, "utf8").includes(OLD_HOST));
        assert.deepEqual(offenders, []);
    });

    it("there is ONE invitation template: both routes use the shared builder; the Shopify purchase email is built on the shared design system, with no local copy", () => {
        for (const file of ["src/modules/workspace/workspace.route.ts", "src/modules/admin/admin-workspace.route.ts"]) {
            const source = read(file);
            assert.match(source, /import \{[^}]*getWorkspaceInviteEmailContent[^}]*\} from "(\.|@modules\/workspace)\/workspace\.email"/, `${file} imports the shared builder`);
            assert.equal(/function getWorkspaceInviteEmailContent/.test(source), false, `${file} has no local copy of the template`);
            assert.equal(/Hello \$\{|You’ve been added to the Pro account/.test(source), false, `${file} has no inline email text`);
            assert.equal(source.includes("${WORKSPACE_ADMIN_URL}"), false, `${file} does not build the link itself`);
        }
        // Shopify purchases send the product-specific confirmation (shopify.purchase-email.ts). The service only
        // supplies facts and environment values; the markup and the links come from the shared design system and
        // the single link source, never from a copy.
        // The service only queues it; the delivery module builds it (with the environment's links) and sends it.
        const shopify = read("src/modules/shopify/shopify.service.ts");
        assert.equal(/Hello \$\{|<table|<html/i.test(shopify), false, "the Shopify service has no inline email text or markup");
        const delivery = read("src/modules/shopify/shopify.email-delivery.ts");
        assert.match(delivery, /buildShopifyPurchaseEmail[\s\S]*?from "\.\/shopify\.purchase-email"/);
        assert.equal(/Hello \$\{|<table|<html/i.test(delivery), false, "the delivery module has no inline email text or markup");
        const purchaseEmail = read("src/modules/shopify/shopify.purchase-email.ts");
        assert.match(purchaseEmail, /from "\.\.\/\.\.\/core\/email\/email-document"/);
        assert.match(purchaseEmail, /WORKSPACE_ADMIN_URL[\s\S]*?from "\.\.\/workspace\/workspace\.links"/);
        assert.equal(/<table|<html/i.test(purchaseEmail), false, "the purchase email builds no markup of its own");
    });

    it("the member-invitation sites pass the role, the inviter's name and the workspace's access end date", () => {
        for (const file of ["src/modules/workspace/workspace.route.ts", "src/modules/admin/admin-workspace.route.ts"]) {
            const source = read(file);
            assert.match(source, /role: req\.body\.role,\s*inviterName: await findInviterDisplayName\(app, req\.authUser\?\.sub\),\s*accessExpiresAt: workspace\.expiresAt/, file);
        }
    });

    it("the address is written in exactly one non-test source file, and so are the app download links", () => {
        const nonTest = [...walk(join(root, "src"))].filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
        const definers = nonTest.filter((path) => readFileSync(path, "utf8").includes("healthage.healthexporesources.com")).map((path) => path.replace(/\\/g, "/").split("/").pop());
        assert.deepEqual(definers, ["workspace.links.ts"]);
        for (const url of ["play.google.com/store/apps/details?id=com.wtt.healthAge", "apps.apple.com/in/app/health-age/id6744716742", "apps.microsoft.com/detail/9P8MFP2CBVL5"]) {
            const owners = nonTest.filter((path) => readFileSync(path, "utf8").includes(url)).map((path) => path.replace(/\\/g, "/").split("/").pop());
            assert.deepEqual(owners, ["workspace.links.ts"], url);
        }
    });

    it("the shared email design module is a pure leaf: no imports, so it can never pull in the environment, the database or SMTP", () => {
        const source = read("src/core/email/email-document.ts");
        assert.equal(/^\s*import\s/m.test(source), false, "no import statements");
        assert.equal(/require\(/.test(source), false);
        assert.doesNotMatch(source, /process\.env|nodemailer|healthage\.healthexporesources\.com/);
    });

    it("the README documents the current address", () => {
        const readme = read("README.md");
        assert.ok(readme.includes(NEW_URL));
        assert.equal(readme.includes(OLD_HOST), false);
    });
});
