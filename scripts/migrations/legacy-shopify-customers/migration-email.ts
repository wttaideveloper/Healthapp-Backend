/**
 * Free-year grant email for the legacy Shopify customer migration.
 *
 * This is NOT the live Shopify workspace-owner welcome mail. The copy, subject,
 * and placeholders are specific to the historical 2026 upgrade grant.
 *
 * Store links are configuration, not a single obsolete web URL.
 * Unconfigured iOS/macOS links are omitted rather than shown empty.
 */

export type FreeYearEmailInput = {
    readonly customerName: string;
    readonly startDate: string;
    readonly expiryDate: string;
    readonly supportEmail: string;
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

export function getLegacyFreeYearEmailContent(input: FreeYearEmailInput): FreeYearEmailContent {
    const subject = "Your 1 year of FREE access to the new Discover Your Health Age App";
    const stores = configuredStoreLinks(input);
    const availableOn = stores.map((store) => store.label).join(" • ");
    const getStartedText =
        stores.length === 0
            ? ""
            : `Get started here:\n\n${stores.map((store) => `${store.label}:\n${store.url}`).join("\n\n")}\n\n`;
    const getStartedHtml =
        stores.length === 0
            ? ""
            : `<p>Get started here:</p>
${stores
    .map(
        (store) =>
            `<p>${escapeHtml(store.label)}:<br><a href="${escapeHtml(store.url)}">${escapeHtml(store.url)}</a></p>`
    )
    .join("\n")}`;

    const text = `Hi ${input.customerName},

Great news — the new Discover Your Health Age App is ready!

Thank you for purchasing the app in 2026. We’ve been working hard to
make the Discover Your Health Age experience even better.

As part of the upgrade, you’re receiving 1 full year of FREE access
to the new app.

Now available on:

${availableOn}

Your Access
1 Year Free
Start Date: ${input.startDate}
Expires: ${input.expiryDate}

${getStartedText}Simply follow the instructions to create or complete your account,
and you’ll be ready to go.

Need help? Contact us at ${input.supportEmail}.

Thank you for being part of the Discover Your Health Age community.
We’re excited for you to experience the new app!

- Pastor Rodney Bowes`;

    const html = `<p>Hi ${escapeHtml(input.customerName)},</p>
<p>Great news — the new Discover Your Health Age App is ready!</p>
<p>Thank you for purchasing the app in 2026. We’ve been working hard to make the Discover Your Health Age experience even better.</p>
<p>As part of the upgrade, you’re receiving <strong>1 full year of FREE access</strong> to the new app.</p>
<p>Now available on:</p>
<p>${escapeHtml(availableOn)}</p>
<p><strong>Your Access</strong><br>
1 Year Free<br>
Start Date: ${escapeHtml(input.startDate)}<br>
Expires: ${escapeHtml(input.expiryDate)}</p>
${getStartedHtml}
<p>Simply follow the instructions to create or complete your account, and you’ll be ready to go.</p>
<p>Need help? Contact us at <a href="mailto:${escapeHtml(input.supportEmail)}">${escapeHtml(input.supportEmail)}</a>.</p>
<p>Thank you for being part of the Discover Your Health Age community. We’re excited for you to experience the new app!</p>
<p>- Pastor Rodney Bowes</p>`;

    return { subject, text, html };
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
