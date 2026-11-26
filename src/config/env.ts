import z from 'zod';

/**
 * App versions: MAJOR.MINOR.PATCH, digits only (at most 9 per part), no leading zeros, no
 * pre-release or build suffix. Shared with src/modules/app-version.
 */
export const APP_VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** An empty or whitespace-only value counts as unset (a blank placeholder line in .env is not an error); others are trimmed. */
const blankAsUnset = (value: unknown) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
};

const optionalAppVersion = () =>
    z.preprocess(
        blankAsUnset,
        z.string().regex(APP_VERSION_PATTERN, 'Expected MAJOR.MINOR.PATCH, for example 1.0.3').optional()
    );
const optionalReleaseNotes = () => z.preprocess(blankAsUnset, z.string().max(1000).optional());
const optionalReleaseDate = () => z.preprocess(blankAsUnset, z.string().datetime({ offset: true }).optional());
const optionalHttpsUrl = () => z.preprocess(blankAsUnset, z.url({ protocol: /^https$/ }).optional());

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(8091),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.url(),
    JWT_SECRET: z.string().min(32),
    /**
     * Access token lifetime. Previously tokens were signed without an expiry and
     * were therefore valid forever. Defaults to 30d so existing mobile/desktop
     * clients (which have no refresh-token flow) are not logged out aggressively.
     * Shorten once a refresh-token flow exists.
     */
    JWT_EXPIRES_IN: z.string().min(1).default('30d'),
    /** Trust X-Forwarded-For. Required for per-IP rate limiting behind nginx. */
    TRUST_PROXY: z.enum(['true', 'false']).default('true'),
    /** Requests per minute per IP for general traffic. */
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
    /** Requests per minute per IP for login/register/password-reset. */
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
    /** Requests per minute per IP for admin bootstrap endpoints. */
    RATE_LIMIT_ADMIN_BOOTSTRAP_MAX: z.coerce.number().int().positive().default(5),
    /** Force Swagger UI on/off. Defaults to off in production. */
    ENABLE_SWAGGER: z.enum(['true', 'false']).optional(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().min(1),
    SMTP_USER: z.string().min(1),
    SMTP_PASS: z.string().min(1),
    EMAIL_FROM: z.string().min(1).optional(),
    /** Google Play listing for Discover Your Health Age. Used by the free-year migration email. */
    HEALTHAGE_ANDROID_URL: z.string().url().optional(),
    /** Microsoft Store listing for Discover Your Health Age. Used by the free-year migration email. */
    HEALTHAGE_WINDOWS_URL: z.string().url().optional(),
    /** App Store listing. Omit from customer email until a real URL exists. */
    HEALTHAGE_IOS_URL: z.string().url().optional(),
    /** Mac App Store listing. Omit from customer email until a real URL exists. */
    HEALTHAGE_MACOS_URL: z.string().url().optional(),
    /** Customer support address for the free-year migration email. Not EMAIL_FROM. */
    HEALTHAGE_SUPPORT_EMAIL: z.string().email().optional(),
    /** Page offering the direct-download Windows installer (not the Microsoft Store). No default. */
    HEALTHAGE_WINDOWS_DIRECT_URL: optionalHttpsUrl(),
    /** The HealthAge web app. No default; a web client updates by reloading. */
    HEALTHAGE_WEB_URL: optionalHttpsUrl(),
    /*
     * App update information, served by GET /api/v1/app-version/:platform (src/modules/app-version).
     * For each platform (ANDROID, IOS, WINDOWS_STORE, WINDOWS_DIRECT, MACOS, WEB):
     *   APP_VERSION_<PLATFORM>_LATEST         newest version users can install now (MAJOR.MINOR.PATCH)
     *   APP_VERSION_<PLATFORM>_MINIMUM        oldest supported version; needs LATEST and must not exceed it
     *   APP_VERSION_<PLATFORM>_RELEASE_NOTES  plain text, at most 1000 characters
     *   APP_VERSION_<PLATFORM>_RELEASED_AT    ISO 8601 date-time, for example 2026-11-26T00:00:00Z
     * All optional: unset values are served as null, which clients read as "no update information".
     * Only set LATEST to a version that is already live in that platform's store or download page.
     *
     * The update link is not repeated here. It is the link customer emails already use:
     * HEALTHAGE_ANDROID_URL, HEALTHAGE_IOS_URL, HEALTHAGE_WINDOWS_URL (windows-store) and
     * HEALTHAGE_MACOS_URL (must be the macOS desktop download page), with the defaults in
     * src/modules/workspace/workspace.links.ts, plus HEALTHAGE_WINDOWS_DIRECT_URL and HEALTHAGE_WEB_URL.
     */
    APP_VERSION_ANDROID_LATEST: optionalAppVersion(),
    APP_VERSION_ANDROID_MINIMUM: optionalAppVersion(),
    APP_VERSION_ANDROID_RELEASE_NOTES: optionalReleaseNotes(),
    APP_VERSION_ANDROID_RELEASED_AT: optionalReleaseDate(),
    APP_VERSION_IOS_LATEST: optionalAppVersion(),
    APP_VERSION_IOS_MINIMUM: optionalAppVersion(),
    APP_VERSION_IOS_RELEASE_NOTES: optionalReleaseNotes(),
    APP_VERSION_IOS_RELEASED_AT: optionalReleaseDate(),
    APP_VERSION_WINDOWS_STORE_LATEST: optionalAppVersion(),
    APP_VERSION_WINDOWS_STORE_MINIMUM: optionalAppVersion(),
    APP_VERSION_WINDOWS_STORE_RELEASE_NOTES: optionalReleaseNotes(),
    APP_VERSION_WINDOWS_STORE_RELEASED_AT: optionalReleaseDate(),
    APP_VERSION_WINDOWS_DIRECT_LATEST: optionalAppVersion(),
    APP_VERSION_WINDOWS_DIRECT_MINIMUM: optionalAppVersion(),
    APP_VERSION_WINDOWS_DIRECT_RELEASE_NOTES: optionalReleaseNotes(),
    APP_VERSION_WINDOWS_DIRECT_RELEASED_AT: optionalReleaseDate(),
    APP_VERSION_MACOS_LATEST: optionalAppVersion(),
    APP_VERSION_MACOS_MINIMUM: optionalAppVersion(),
    APP_VERSION_MACOS_RELEASE_NOTES: optionalReleaseNotes(),
    APP_VERSION_MACOS_RELEASED_AT: optionalReleaseDate(),
    APP_VERSION_WEB_LATEST: optionalAppVersion(),
    APP_VERSION_WEB_MINIMUM: optionalAppVersion(),
    APP_VERSION_WEB_RELEASE_NOTES: optionalReleaseNotes(),
    APP_VERSION_WEB_RELEASED_AT: optionalReleaseDate(),
    ADMIN_EMAILS: z.string().optional(),
    ADMIN_BOOTSTRAP_TOKEN: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_PRICE_ID_ANNUAL: z.string().min(1).optional(),
    STRIPE_SUCCESS_URL: z.url().optional(),
    STRIPE_CANCEL_URL: z.url().optional(),
    STRIPE_BILLING_PORTAL_RETURN_URL: z.url().optional(),
    SHOPIFY_API_KEY: z.string().min(1).optional(),
    SHOPIFY_API_SECRET: z.string().min(1).optional(),
    SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),
    SHOPIFY_ACCESS_TOKEN: z.string().min(1).optional(),
    /** Store hostname, e.g. example.myshopify.com. Used to validate incoming webhooks. */
    SHOPIFY_SHOP_DOMAIN: z.string().min(1).optional(),
    /** Set to "false" to switch the Shopify purchase email retry/recovery worker off on this server. On by default. */
    SHOPIFY_EMAIL_WORKER_ENABLED: z.enum(['true', 'false']).optional(),

});

// Validate process.env
const _env = envSchema.safeParse(process.env);

if (!_env.success) {
    console.error('❌ Invalid environment variables:', _env.error.format());
    process.exit(1);
}

export const env = _env.data;
