import { APP_VERSION_PATTERN, env } from "@config/env";

import { HEALTHAGE_STORE_URLS } from "../workspace/workspace.links";
import { APP_VERSION_PLATFORMS, type AppVersionPlatform, type AppVersionResponse } from "./app-version.schema";

/** One platform's update settings as configured (env.ts has already checked the format of each value). */
export type AppVersionSettings = {
    latestVersion?: string;
    minimumSupportedVersion?: string;
    updateUrl?: string;
    releaseNotes?: string;
    releasedAt?: string;
};

export type AppVersionSettingsByPlatform = Record<AppVersionPlatform, AppVersionSettings>;

/** The exact response served for each platform. */
export type AppVersionPolicies = Readonly<Record<AppVersionPlatform, Readonly<AppVersionResponse>>>;

/** How each platform is spelled in its APP_VERSION_* variable names (used in configuration errors). */
const ENV_NAME: Record<AppVersionPlatform, string> = {
    android: "ANDROID",
    ios: "IOS",
    "windows-store": "WINDOWS_STORE",
    "windows-direct": "WINDOWS_DIRECT",
    macos: "MACOS",
    web: "WEB",
};

/**
 * Reads each platform's settings from the environment.
 *
 * The update link is the store or download link that customer emails already use (HEALTHAGE_*_URL,
 * unset meaning the published defaults in workspace.links.ts, with the same fallback rule as the
 * email templates), so an update prompt and an email can never send people to different places.
 * windows-direct and web have no published link, so they have no default.
 */
export function readAppVersionSettings(source: typeof env = env): AppVersionSettingsByPlatform {
    return {
        android: {
            latestVersion: source.APP_VERSION_ANDROID_LATEST,
            minimumSupportedVersion: source.APP_VERSION_ANDROID_MINIMUM,
            updateUrl: source.HEALTHAGE_ANDROID_URL?.trim() || HEALTHAGE_STORE_URLS.android,
            releaseNotes: source.APP_VERSION_ANDROID_RELEASE_NOTES,
            releasedAt: source.APP_VERSION_ANDROID_RELEASED_AT,
        },
        ios: {
            latestVersion: source.APP_VERSION_IOS_LATEST,
            minimumSupportedVersion: source.APP_VERSION_IOS_MINIMUM,
            updateUrl: source.HEALTHAGE_IOS_URL?.trim() || HEALTHAGE_STORE_URLS.ios,
            releaseNotes: source.APP_VERSION_IOS_RELEASE_NOTES,
            releasedAt: source.APP_VERSION_IOS_RELEASED_AT,
        },
        "windows-store": {
            latestVersion: source.APP_VERSION_WINDOWS_STORE_LATEST,
            minimumSupportedVersion: source.APP_VERSION_WINDOWS_STORE_MINIMUM,
            updateUrl: source.HEALTHAGE_WINDOWS_URL?.trim() || HEALTHAGE_STORE_URLS.windows,
            releaseNotes: source.APP_VERSION_WINDOWS_STORE_RELEASE_NOTES,
            releasedAt: source.APP_VERSION_WINDOWS_STORE_RELEASED_AT,
        },
        "windows-direct": {
            latestVersion: source.APP_VERSION_WINDOWS_DIRECT_LATEST,
            minimumSupportedVersion: source.APP_VERSION_WINDOWS_DIRECT_MINIMUM,
            updateUrl: source.HEALTHAGE_WINDOWS_DIRECT_URL,
            releaseNotes: source.APP_VERSION_WINDOWS_DIRECT_RELEASE_NOTES,
            releasedAt: source.APP_VERSION_WINDOWS_DIRECT_RELEASED_AT,
        },
        macos: {
            latestVersion: source.APP_VERSION_MACOS_LATEST,
            minimumSupportedVersion: source.APP_VERSION_MACOS_MINIMUM,
            updateUrl: source.HEALTHAGE_MACOS_URL?.trim() || HEALTHAGE_STORE_URLS.macos,
            releaseNotes: source.APP_VERSION_MACOS_RELEASE_NOTES,
            releasedAt: source.APP_VERSION_MACOS_RELEASED_AT,
        },
        web: {
            latestVersion: source.APP_VERSION_WEB_LATEST,
            minimumSupportedVersion: source.APP_VERSION_WEB_MINIMUM,
            updateUrl: source.HEALTHAGE_WEB_URL,
            releaseNotes: source.APP_VERSION_WEB_RELEASE_NOTES,
            releasedAt: source.APP_VERSION_WEB_RELEASED_AT,
        },
    };
}

/** [major, minor, patch], or null when `version` is not MAJOR.MINOR.PATCH. */
function parseVersion(version: string): [number, number, number] | null {
    const match = APP_VERSION_PATTERN.exec(version);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative, zero or positive as `a` is lower than, equal to or higher than `b`. Numeric: 1.0.10 > 1.0.9. */
export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) {
        throw new Error("compareVersions expects MAJOR.MINOR.PATCH versions");
    }
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * Builds the response served for each platform, once, at start-up.
 *
 * A configuration that would make clients misbehave stops the server from starting, like any invalid
 * variable in env.ts, instead of being served: a minimum version without a latest version, or a
 * minimum above the latest (clients would ask for an update that does not exist). The error names
 * variables and versions only; no other configuration value is ever included.
 */
export function resolveAppVersionPolicies(settings: AppVersionSettingsByPlatform): AppVersionPolicies {
    const problems: string[] = [];
    const policies = {} as Record<AppVersionPlatform, Readonly<AppVersionResponse>>;

    for (const platform of APP_VERSION_PLATFORMS) {
        const prefix = `APP_VERSION_${ENV_NAME[platform]}`;
        const config = settings[platform];

        const latestVersion = config.latestVersion?.trim() || null;
        const minimumSupportedVersion = config.minimumSupportedVersion?.trim() || null;
        const latestIsValid = latestVersion !== null && parseVersion(latestVersion) !== null;
        const minimumIsValid = minimumSupportedVersion !== null && parseVersion(minimumSupportedVersion) !== null;

        if (latestVersion !== null && !latestIsValid) {
            problems.push(`${prefix}_LATEST must be MAJOR.MINOR.PATCH`);
        }
        if (minimumSupportedVersion !== null && !minimumIsValid) {
            problems.push(`${prefix}_MINIMUM must be MAJOR.MINOR.PATCH`);
        }
        if (minimumSupportedVersion !== null && latestVersion === null) {
            problems.push(`${prefix}_MINIMUM is set but ${prefix}_LATEST is not`);
        } else if (
            latestVersion !== null &&
            minimumSupportedVersion !== null &&
            latestIsValid &&
            minimumIsValid &&
            compareVersions(minimumSupportedVersion, latestVersion) > 0
        ) {
            problems.push(
                `${prefix}_MINIMUM (${minimumSupportedVersion}) is higher than ${prefix}_LATEST (${latestVersion})`
            );
        }

        let releasedAt: string | null = null;
        const releasedAtSetting = config.releasedAt?.trim();
        if (releasedAtSetting) {
            const time = Date.parse(releasedAtSetting);
            if (Number.isNaN(time)) {
                problems.push(`${prefix}_RELEASED_AT is not a valid date-time`);
            } else {
                releasedAt = new Date(time).toISOString();
            }
        }

        policies[platform] = Object.freeze({
            platform,
            latestVersion,
            minimumSupportedVersion,
            updateUrl: config.updateUrl?.trim() || null,
            releaseNotes: config.releaseNotes?.trim() || null,
            releasedAt,
        });
    }

    if (problems.length > 0) {
        throw new Error(`Invalid app version configuration: ${problems.join("; ")}.`);
    }

    return Object.freeze(policies);
}
