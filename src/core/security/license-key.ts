import { createHash, randomBytes } from "node:crypto";

export function generateLicenseKey(): string {
    const raw = randomBytes(12).toString("hex").toUpperCase();
    const chunks = [raw.slice(0, 6), raw.slice(6, 12), raw.slice(12, 18), raw.slice(18, 24)];
    return `ORG-${chunks.join("-")}`;
}

export function hashLicenseKey(licenseKey: string): string {
    return createHash("sha256").update(licenseKey.trim().toUpperCase()).digest("hex");
}
