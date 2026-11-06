/**
 * Customer-facing link to the HealthAge Admin / Workspace Admin portal.
 *
 * Every workspace invitation, organization welcome and Shopify owner-welcome
 * email tells the recipient to visit this address. It is defined once, here, so
 * the several copies of the invite template cannot drift apart again.
 *
 * Pure on purpose: no env, no SMTP, nothing to set up before importing it.
 *
 * (Replaces the retired Vercel address for the old workspace-admin page.)
 */
export const WORKSPACE_ADMIN_URL = "https://healthage.healthexporesources.com/";

/**
 * Where customers download the HealthAge app. Used by the workspace invitation emails (and mirrored,
 * with a test keeping the two equal, by the legacy-migration onboarding emails). Each can be overridden
 * per environment with HEALTHAGE_ANDROID_URL, HEALTHAGE_IOS_URL, HEALTHAGE_WINDOWS_URL and
 * HEALTHAGE_MACOS_URL.
 */
export const HEALTHAGE_STORE_URLS = {
    android: "https://play.google.com/store/apps/details?id=com.wtt.healthAge",
    ios: "https://apps.apple.com/in/app/health-age/id6744716742",
    windows: "https://apps.microsoft.com/detail/9P8MFP2CBVL5",
    macos: "https://healthage.healthexporesources.com/download/",
} as const;

/** Customer support address shown in customer emails. Not EMAIL_FROM. */
export const HEALTHAGE_SUPPORT_EMAIL = "support@healthexporesources.com";
