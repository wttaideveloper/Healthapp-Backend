/**
 * The workspace invitation / welcome emails, built on the shared email design system
 * (`src/core/email/email-document.ts`) so they match the legacy-customer onboarding emails.
 *
 * Pure on purpose (no env, SMTP or database): `workspace.email.ts` supplies the environment-specific
 * values (store links, support address) and the routes supply the invitation facts.
 *
 * Two variants:
 *   - member invitation (default): the invited person uses the HealthAge APP. Plain members are not
 *     admitted to the Admin Portal, so the email does not send them there.
 *   - owner / administrator welcome (`isOwner`): the person manages the workspace in the Admin Portal.
 *
 * There is no invitation token, link or expiry in the application: a membership is a row that is claimed
 * automatically when the person registers or signs in with the invited email address. So the email never
 * promises an "Accept Invitation" link. `acceptInvitationUrl` is only rendered if a caller supplies one
 * (none does today), together with a plain-text fallback of the same URL.
 */

import {
    bold,
    buildStoreLinks,
    discontinuationNoticeBlock,
    formatEmailDate,
    isMailbox,
    isSafeHttpUrl,
    renderEmailDocument,
    type Block,
    type DetailRow,
    type EmailDocument,
    type RenderedEmail,
    type Segment,
    type Step,
    type StoreLink,
} from "../../core/email/email-document";
import { HEALTHAGE_STORE_URLS, HEALTHAGE_SUPPORT_EMAIL, WORKSPACE_ADMIN_URL } from "./workspace.links";

export type WorkspaceInviteEmailInput = {
    readonly organizationName: string;
    readonly userName: string;
    readonly userEmail: string;
    /** Workspace owner / administrator welcome instead of a member invitation. */
    readonly isOwner?: boolean;
    /** Role the person is invited with. Defaults to "member". Ignored for an owner welcome. */
    readonly role?: string;
    /** Who sent the invitation, when known. */
    readonly inviterName?: string | null;
    /** When the workspace's access ends (an ISO date or date-time, or a Date), when known. */
    readonly accessExpiresAt?: string | Date | null;
    /** Only if the application ever issues a per-invitation link. None does today. */
    readonly acceptInvitationUrl?: string | null;
    /**
     * Add the "discontinuation of the previous HealthAge software" notice to a MEMBER invitation. The routes set it
     * for workspaces created by the legacy migration (`isLegacyMigrationWorkspace`). Ignored for the owner welcome.
     */
    readonly discontinuationNotice?: boolean;
    readonly subject?: string;
    readonly storeUrls?: Partial<Record<"android" | "ios" | "windows" | "macos", string | null | undefined>>;
    readonly supportEmail?: string;
};

/**
 * Workspaces created by the legacy Shopify migration. Their members are the people the old HealthAge software
 * was sold to, so they are the ones the discontinuation notice is for. Must equal the migration's own value
 * (`GRANT_CONFIG.workspaceBillingSource`); a test keeps them in step.
 */
export const LEGACY_MIGRATION_BILLING_SOURCE = "legacy_shopify_migration";

export function isLegacyMigrationWorkspace(billingSource: string | null | undefined): boolean {
    return billingSource === LEGACY_MIGRATION_BILLING_SOURCE;
}

/** A subject or name is one line: strip anything that could break a header or a sentence. */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

function isoDay(value: string | Date | null | undefined): string | null {
    if (!value) return null;
    const text = value instanceof Date ? (Number.isNaN(value.getTime()) ? "" : value.toISOString()) : value;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    return match ? match[1]! : null;
}

const roleLabel = (role: string): string => (role === "admin" ? "Admin" : role === "owner" ? "Owner" : "Member");

function storeLinksFor(input: WorkspaceInviteEmailInput): StoreLink[] {
    const urls = input.storeUrls ?? {};
    return buildStoreLinks({
        android: urls.android?.trim() || HEALTHAGE_STORE_URLS.android,
        ios: urls.ios?.trim() || HEALTHAGE_STORE_URLS.ios,
        windows: urls.windows?.trim() || HEALTHAGE_STORE_URLS.windows,
        macos: urls.macos?.trim() || HEALTHAGE_STORE_URLS.macos,
    });
}

function buildDocument(input: WorkspaceInviteEmailInput): EmailDocument {
    const org = oneLine(input.organizationName);
    const name = oneLine(input.userName);
    const email = input.userEmail;
    const links = storeLinksFor(input);
    const support: Segment = (() => {
        const address = input.supportEmail?.trim() || HEALTHAGE_SUPPORT_EMAIL;
        return isMailbox(address) ? { mail: address } : address;
    })();
    const accessUntil = isoDay(input.accessExpiresAt);
    const inviter = input.inviterName ? oneLine(input.inviterName) : "";
    const acceptUrl = input.acceptInvitationUrl?.trim() || "";
    if (acceptUrl && !isSafeHttpUrl(acceptUrl)) throw new Error("Refusing to build the invitation email: the invitation link is not a plain http(s) URL.");

    // "5 November 2027", not a raw ISO date.
    const formattedExpiry = accessUntil ? formatEmailDate(accessUntil) : null;
    const help: EmailDocument["help"] = ["Need help? Contact us at ", support, "."];
    const common = { greeting: `Hello ${name},`, help, preheader: "" };

    // ------------------------------------------------------------------ owner / administrator welcome
    if (input.isOwner) {
        const rows: DetailRow[] = [
            { label: "Workspace", lines: [org] },
            { label: "Workspace administrator", lines: [email] },
            { label: "Role", lines: ["Owner"] },
        ];
        if (formattedExpiry) rows.push({ label: "Access until", lines: [formattedExpiry] });

        const steps: Step[] = [
            { title: "Open the HealthAge Admin Portal", body: [["Go to ", { link: WORKSPACE_ADMIN_URL }, ". This is where you manage your workspace and its members."]] },
            {
                title: "Sign in with this email address",
                body: [["Use ", bold(email), "."]],
                items: [
                    ["Already have a HealthAge account? Sign in."],
                    ["New to HealthAge? Select ", bold("Sign up"), " and create an account with this same email address."],
                ],
            },
            {
                title: "Invite your members",
                body: [["Select ", bold("Members"), ", then use ", bold("Invite a Member"), " to give each person a license from your workspace."]],
            },
            { title: "Download the HealthAge app", body: [["Install the app on your device and sign in with ", bold(email), ": your Pro access activates automatically."]], downloads: links },
        ];
        const blocks: Block[] = [
            { type: "paragraphs", paragraphs: [["You have been added as the workspace administrator for ", bold(org), "."]] },
            { type: "details", rows },
            { type: "button", label: "Open Admin Portal", url: WORKSPACE_ADMIN_URL, tone: "gold" },
            { type: "heading", text: "Getting Started" },
            { type: "steps", steps },
        ];
        return {
            ...common,
            subject: oneLine(input.subject ?? `You’ve Been Added as Workspace Admin to ${org}’s “Discover your health age” App Pro Account`),
            preheader: `You are the workspace administrator for ${org}.`,
            title: "Your HealthAge Workspace Is Ready!",
            blocks,
            closing: ["Welcome to HealthAge."],
            signOff: ["The HealthAge Team"],
            recipientNote: `This message was sent to ${email} because you were added as the workspace administrator for ${org} on HealthAge.`,
        };
    }

    // ------------------------------------------------------------------ member (or admin) invitation
    const role = input.role === "admin" ? "admin" : "member";
    const rows: DetailRow[] = [
        { label: "Workspace", lines: [org] },
        { label: "Invited email", lines: [email] },
        { label: "Role", lines: [roleLabel(role)] },
    ];
    if (inviter) rows.push({ label: "Invited by", lines: [inviter] });
    if (formattedExpiry) rows.push({ label: "Access until", lines: [formattedExpiry] });

    const steps: Step[] = [
        {
            title: "Use your invited email address",
            body: [
                ["Your invitation is linked to ", bold(email), ". Create your account or sign in with this exact address: that is how your invitation is accepted."],
            ],
        },
        { title: "Download the new HealthAge app", body: [], downloads: links },
        {
            title: "Create your account or sign in",
            body: [["Open the app, then:"]],
            items: [
                ["New to HealthAge? Select ", bold("Create Account"), " and register with ", bold(email), "."],
                ["Already have an account? Select ", bold("Sign In"), " and use ", bold(email), "."],
            ],
        },
        {
            title: "Start using HealthAge",
            body: [["Your allocated license activates automatically once you sign in. No purchase or checkout is needed in the app."]],
        },
    ];
    if (role === "admin") {
        steps.splice(3, 0, {
            title: "Manage the workspace (admins only)",
            body: [["As an admin you can also manage members in the Admin Portal: ", { link: WORKSPACE_ADMIN_URL }]],
        });
    }

    const blocks: Block[] = [
        {
            type: "paragraphs",
            paragraphs: [inviter ? [`${inviter} has invited you to join `, bold(org), " on HealthAge."] : ["Your workspace administrator has invited you to join ", bold(org), " on HealthAge."]],
        },
        { type: "heading", text: "Your Invitation" },
        { type: "details", rows },
    ];
    if (acceptUrl) blocks.push({ type: "button", label: "Accept Invitation", url: acceptUrl, tone: "gold" });
    blocks.push({
        type: "callout",
        title: "No subscription needed",
        paragraphs: [["You do not need to purchase a subscription. Your workspace administrator has already allocated your license."]],
    });
    // Right after the invitation facts, before the steps, so it is seen but does not bury the invitation itself.
    if (input.discontinuationNotice) blocks.push(discontinuationNoticeBlock("member"));
    blocks.push({ type: "heading", text: "Getting Started" }, { type: "steps", steps });

    return {
        ...common,
        subject: oneLine(input.subject ?? `You’ve Been Invited to Join ${org} on HealthAge`),
        preheader: `${inviter || "Your workspace administrator"} has invited you to join ${org}. Your license is already allocated.`,
        title: "You’ve Been Invited to HealthAge!",
        blocks,
        closing: ["Welcome to HealthAge."],
        signOff: ["The HealthAge Team"],
        recipientNote: `This message was sent to ${email} because you were invited to ${org} on HealthAge.`,
    };
}

export function buildWorkspaceInviteEmail(input: WorkspaceInviteEmailInput): RenderedEmail {
    return renderEmailDocument(buildDocument(input));
}
