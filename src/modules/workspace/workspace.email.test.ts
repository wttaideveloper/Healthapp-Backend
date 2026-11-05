import "../shopify/shopify.test-env";

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import { getWorkspaceInviteEmailContent } from "./workspace.email";
import { WORKSPACE_ADMIN_URL } from "./workspace.links";

const NEW_URL = "https://healthage.healthexporesources.com/";
// Built from parts so this file does not itself contain the retired address.
const OLD_HOST = ["health-age-admin", "vercel", "app"].join(".");

const root = process.cwd();
const read = (relativePath: string) => readFileSync(join(root, relativePath), "utf8");

describe("Workspace Admin link in customer emails", () => {
    it("is the confirmed HealthAge Admin address", () => {
        assert.equal(WORKSPACE_ADMIN_URL, NEW_URL);
    });

    it("member invite email links to it, in the text and the HTML", () => {
        const email = getWorkspaceInviteEmailContent({
            organizationName: "Acme Clinic",
            userName: "Pat",
            userEmail: "pat@example.com",
        });
        assert.match(email.text, new RegExp(`1\\. Visit: ${NEW_URL.replace(/[.]/g, "\\.")}\\n2\\. Download`));
        assert.ok(email.html.includes(`<li>Visit: <a href="${NEW_URL}">${NEW_URL}</a></li>`));
    });

    it("workspace owner / organization welcome email links to it", () => {
        const email = getWorkspaceInviteEmailContent({
            organizationName: "Acme Clinic",
            userName: "Pat",
            userEmail: "pat@example.com",
            isOwner: true,
        });
        assert.match(email.subject, /Workspace Admin/);
        assert.ok(email.text.includes(`1. Visit: ${NEW_URL}`));
        assert.ok(email.html.includes(`<a href="${NEW_URL}">${NEW_URL}</a>`));
    });

    it("Shopify owner-welcome email (owner variant with a custom subject) links to it", () => {
        // sendShopifyWorkspaceOwnerWelcomeEmail builds its message with exactly these inputs.
        const email = getWorkspaceInviteEmailContent({
            organizationName: "Eastwood SDA Church",
            userName: "Rhonda McMorris",
            userEmail: "owner@example.com",
            isOwner: true,
            subject: "Complete registration to access your workspace.",
        });
        assert.equal(email.subject, "Complete registration to access your workspace.");
        assert.ok(email.text.includes(`Visit: ${NEW_URL}`));
        assert.ok(email.html.includes(`href="${NEW_URL}"`));
    });

    it("contains the Admin link and no other link, and nothing from the retired address", () => {
        for (const isOwner of [true, false]) {
            const email = getWorkspaceInviteEmailContent({
                organizationName: "Acme Clinic",
                userName: "Pat",
                userEmail: "pat@example.com",
                isOwner,
            });
            assert.deepEqual(email.text.match(/https?:\/\/\S+/g), [NEW_URL]);
            for (const body of [email.subject, email.text, email.html]) {
                assert.equal(body.includes(OLD_HOST), false);
                assert.doesNotMatch(body, /vercel/i);
                assert.doesNotMatch(body, /\/workspace-admin/);
            }
        }
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

    it("every template copy builds the link from WORKSPACE_ADMIN_URL instead of hard-coding it", () => {
        for (const file of [
            "src/modules/workspace/workspace.email.ts",
            "src/modules/workspace/workspace.route.ts",
            "src/modules/admin/admin-workspace.route.ts",
        ]) {
            const source = read(file);
            assert.ok(source.includes("${WORKSPACE_ADMIN_URL}"), `${file} should interpolate WORKSPACE_ADMIN_URL`);
            assert.equal(source.includes("healthage.healthexporesources.com"), false, `${file} should not hard-code the address`);
        }
    });

    it("the address is written in exactly one non-test source file", () => {
        const definers = [...walk(join(root, "src"))]
            .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
            .filter((path) => readFileSync(path, "utf8").includes("healthage.healthexporesources.com"))
            .map((path) => path.replace(/\\/g, "/").split("/").pop());
        assert.deepEqual(definers, ["workspace.links.ts"]);
    });

    it("the live Shopify owner-welcome email still builds its message from the shared template", () => {
        const shopify = read("src/modules/shopify/shopify.service.ts");
        assert.match(shopify, /getWorkspaceInviteEmailContent[\s\S]*?from "@modules\/workspace\/workspace\.email"/);
        assert.ok(shopify.includes("isOwner: true"));
    });

    it("the README documents the current address", () => {
        const readme = read("README.md");
        assert.ok(readme.includes(NEW_URL));
        assert.equal(readme.includes(OLD_HOST), false);
    });
});
