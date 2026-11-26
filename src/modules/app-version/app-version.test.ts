import "../shopify/shopify.test-env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

import { env } from "@config/env";
import { errorHandlerPlugin } from "@plugins/error-handler.plugin";
import { HEALTHAGE_STORE_URLS } from "../workspace/workspace.links";
import { APP_VERSION_CACHE_CONTROL, appVersionRoutes } from "./app-version.route";
import { APP_VERSION_PLATFORMS } from "./app-version.schema";
import {
    compareVersions,
    readAppVersionSettings,
    resolveAppVersionPolicies,
    type AppVersionPolicies,
} from "./app-version.service";

/** This environment without any app-version or store-link setting, whatever the machine running the tests has set. */
const UNSET = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("APP_VERSION_") && !/^HEALTHAGE_\w+_URL$/.test(key))
) as typeof env;

const policiesFor = (overrides: Partial<typeof env> = {}): AppVersionPolicies =>
    resolveAppVersionPolicies(readAppVersionSettings({ ...UNSET, ...overrides }));

async function buildApp(policies: AppVersionPolicies) {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(appVersionRoutes, { prefix: "/api/v1/app-version", policies });
    await app.ready();
    return app;
}

describe("app version configuration", () => {
    it("serves no versions and the published store links when nothing is configured", () => {
        const policies = policiesFor();

        for (const platform of APP_VERSION_PLATFORMS) {
            assert.equal(policies[platform].platform, platform);
            assert.equal(policies[platform].latestVersion, null, platform);
            assert.equal(policies[platform].minimumSupportedVersion, null, platform);
            assert.equal(policies[platform].releaseNotes, null, platform);
            assert.equal(policies[platform].releasedAt, null, platform);
        }
        assert.equal(policies.android.updateUrl, HEALTHAGE_STORE_URLS.android);
        assert.equal(policies.ios.updateUrl, HEALTHAGE_STORE_URLS.ios);
        assert.equal(policies["windows-store"].updateUrl, HEALTHAGE_STORE_URLS.windows);
        assert.equal(policies.macos.updateUrl, HEALTHAGE_STORE_URLS.macos);
        assert.equal(policies["windows-direct"].updateUrl, null);
        assert.equal(policies.web.updateUrl, null);
    });

    it("uses the same HEALTHAGE_*_URL overrides as the customer emails", () => {
        const policies = policiesFor({
            HEALTHAGE_ANDROID_URL: "https://example.com/android",
            HEALTHAGE_IOS_URL: "https://example.com/ios",
            HEALTHAGE_WINDOWS_URL: "https://example.com/windows-store",
            HEALTHAGE_MACOS_URL: "https://example.com/macos",
            HEALTHAGE_WINDOWS_DIRECT_URL: "https://example.com/windows-setup",
            HEALTHAGE_WEB_URL: "https://example.com/app",
        });

        assert.equal(policies.android.updateUrl, "https://example.com/android");
        assert.equal(policies.ios.updateUrl, "https://example.com/ios");
        assert.equal(policies["windows-store"].updateUrl, "https://example.com/windows-store");
        assert.equal(policies.macos.updateUrl, "https://example.com/macos");
        assert.equal(policies["windows-direct"].updateUrl, "https://example.com/windows-setup");
        assert.equal(policies.web.updateUrl, "https://example.com/app");
    });

    it("serves the configured versions and notes, with the release date in UTC, for that platform only", () => {
        const policies = policiesFor({
            APP_VERSION_IOS_LATEST: "1.0.3",
            APP_VERSION_IOS_MINIMUM: "1.0.1",
            APP_VERSION_IOS_RELEASE_NOTES: "Performance improvements and bug fixes.",
            APP_VERSION_IOS_RELEASED_AT: "2026-11-26T05:30:00+05:30",
        });

        assert.deepEqual(policies.ios, {
            platform: "ios",
            latestVersion: "1.0.3",
            minimumSupportedVersion: "1.0.1",
            updateUrl: HEALTHAGE_STORE_URLS.ios,
            releaseNotes: "Performance improvements and bug fixes.",
            releasedAt: "2026-11-26T00:00:00.000Z",
        });
        assert.equal(policies.android.latestVersion, null);
        assert.equal(policies.android.releaseNotes, null);
    });

    it("accepts a minimum equal to the latest version", () => {
        const policies = policiesFor({ APP_VERSION_MACOS_LATEST: "1.0.3", APP_VERSION_MACOS_MINIMUM: "1.0.3" });
        assert.equal(policies.macos.minimumSupportedVersion, "1.0.3");
    });

    it("refuses a minimum version without a latest version", () => {
        assert.throws(
            () => policiesFor({ APP_VERSION_MACOS_MINIMUM: "1.0.3" }),
            /APP_VERSION_MACOS_MINIMUM is set but APP_VERSION_MACOS_LATEST is not/
        );
    });

    it("refuses a minimum above the latest version, comparing numerically", () => {
        assert.throws(
            () => policiesFor({ APP_VERSION_ANDROID_LATEST: "1.0.9", APP_VERSION_ANDROID_MINIMUM: "1.0.10" }),
            /APP_VERSION_ANDROID_MINIMUM \(1\.0\.10\) is higher than APP_VERSION_ANDROID_LATEST \(1\.0\.9\)/
        );
    });

    it("refuses a version that is not MAJOR.MINOR.PATCH", () => {
        assert.throws(
            () => policiesFor({ APP_VERSION_WEB_LATEST: "1.0" }),
            /APP_VERSION_WEB_LATEST must be MAJOR\.MINOR\.PATCH/
        );
    });
});

describe("compareVersions", () => {
    it("compares each part as a number", () => {
        assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
        assert.ok(compareVersions("1.2.0", "1.10.0") < 0);
        assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
        assert.equal(compareVersions("1.0.3", "1.0.3"), 0);
    });

    it("rejects anything that is not MAJOR.MINOR.PATCH", () => {
        for (const bad of ["1.0", "1.0.0-beta", "v1.0.0", "01.0.0", ""]) {
            assert.throws(() => compareVersions(bad, "1.0.0"), Error, bad);
        }
    });
});

describe("GET /api/v1/app-version/:platform", () => {
    it("answers without authentication, with the configured values and a short public cache", async () => {
        const app = await buildApp(
            policiesFor({ APP_VERSION_ANDROID_LATEST: "1.0.3", APP_VERSION_ANDROID_MINIMUM: "1.0.0" })
        );
        try {
            const response = await app.inject({ method: "GET", url: "/api/v1/app-version/android" });

            assert.equal(response.statusCode, 200);
            assert.equal(response.headers["cache-control"], APP_VERSION_CACHE_CONTROL);
            assert.deepEqual(response.json(), {
                platform: "android",
                latestVersion: "1.0.3",
                minimumSupportedVersion: "1.0.0",
                updateUrl: HEALTHAGE_STORE_URLS.android,
                releaseNotes: null,
                releasedAt: null,
            });
        } finally {
            await app.close();
        }
    });

    it("answers every supported platform with every field present", async () => {
        const app = await buildApp(policiesFor());
        try {
            for (const platform of APP_VERSION_PLATFORMS) {
                const response = await app.inject({ method: "GET", url: `/api/v1/app-version/${platform}` });
                assert.equal(response.statusCode, 200, platform);
                assert.deepEqual(Object.keys(response.json()).sort(), [
                    "latestVersion",
                    "minimumSupportedVersion",
                    "platform",
                    "releaseNotes",
                    "releasedAt",
                    "updateUrl",
                ]);
                assert.equal(response.json().platform, platform);
            }
        } finally {
            await app.close();
        }
    });

    it("rejects an unsupported platform with the standard error response", async () => {
        const app = await buildApp(policiesFor());
        try {
            for (const url of ["/api/v1/app-version/linux", "/api/v1/app-version/Android"]) {
                const response = await app.inject({ method: "GET", url });
                const body = response.json();

                assert.equal(response.statusCode, 400, url);
                assert.equal(typeof body.error.code, "string", url);
                assert.equal(typeof body.error.message, "string", url);
                assert.equal(response.headers["cache-control"], undefined, url);
            }
        } finally {
            await app.close();
        }
    });
});
