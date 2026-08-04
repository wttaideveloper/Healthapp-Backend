import z from 'zod';

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
    SHOPIFY_SHOP_DOMAIN: z.string().min(1).optional(),

});

// Validate process.env
const _env = envSchema.safeParse(process.env);

if (!_env.success) {
    console.error('❌ Invalid environment variables:', _env.error.format());
    process.exit(1);
}

export const env = _env.data;
