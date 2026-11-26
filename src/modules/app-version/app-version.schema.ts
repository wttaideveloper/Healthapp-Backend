import { z } from "zod";

/**
 * Every platform that has its own build and update channel. Part of the public contract of
 * GET /api/v1/app-version/:platform: values may be added, never renamed or removed.
 */
export const APP_VERSION_PLATFORMS = [
    "android",
    "ios",
    "windows-store",
    "windows-direct",
    "macos",
    "web",
] as const;

export const appVersionPlatformSchema = z.enum(APP_VERSION_PLATFORMS);

export type AppVersionPlatform = z.infer<typeof appVersionPlatformSchema>;

export const appVersionParamsSchema = z.object({
    platform: appVersionPlatformSchema,
});

/**
 * Stable response contract for mobile and desktop clients. Every field is always present; null
 * means "not configured". Versions are MAJOR.MINOR.PATCH and `releasedAt` is an ISO 8601 UTC
 * date-time. The server never decides whether a client must update: each client compares its own
 * version with `latestVersion` and `minimumSupportedVersion`.
 */
export const appVersionResponseSchema = z.object({
    platform: appVersionPlatformSchema,
    latestVersion: z.string().nullable(),
    minimumSupportedVersion: z.string().nullable(),
    updateUrl: z.string().nullable(),
    releaseNotes: z.string().nullable(),
    releasedAt: z.string().nullable(),
});

export type AppVersionResponse = z.infer<typeof appVersionResponseSchema>;
