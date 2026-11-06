import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import nodemailer from "nodemailer";

import { env } from "@config/env";
import { users } from "@db/schema";
import { buildWorkspaceInviteEmail, type WorkspaceInviteEmailInput } from "./workspace.invite-template";

export type { WorkspaceInviteEmailInput } from "./workspace.invite-template";
export { isLegacyMigrationWorkspace } from "./workspace.invite-template";

export function inferWorkspaceDisplayName(email: string, explicitName?: string | null): string {
    if (explicitName && explicitName.trim().length > 0) return explicitName.trim();
    const localPart = email.split("@")[0] ?? "User";
    return localPart || "User";
}

/**
 * The single builder for workspace invitation and owner-welcome emails. The design and wording live in
 * `workspace.invite-template.ts`; this adds the per-environment values: the store links and the support
 * address (HEALTHAGE_*_URL, HEALTHAGE_SUPPORT_EMAIL; unset means the published defaults).
 */
export function getWorkspaceInviteEmailContent(input: WorkspaceInviteEmailInput) {
    return buildWorkspaceInviteEmail({
        ...input,
        storeUrls: {
            android: env.HEALTHAGE_ANDROID_URL,
            ios: env.HEALTHAGE_IOS_URL,
            windows: env.HEALTHAGE_WINDOWS_URL,
            macos: env.HEALTHAGE_MACOS_URL,
            ...input.storeUrls,
        },
        supportEmail: input.supportEmail ?? env.HEALTHAGE_SUPPORT_EMAIL,
    });
}

/**
 * The display name of the person sending an invitation, for the email ("Pat has invited you...").
 * Best effort: the invitation is already saved, so a failed lookup just means the email says
 * "Your workspace administrator" instead. It never throws.
 */
export async function findInviterDisplayName(app: FastifyInstance, userId: string | undefined): Promise<string | null> {
    if (!userId) return null;
    try {
        const [row] = await app.db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
        const name = row?.name?.trim();
        return name ? name : null;
    } catch {
        return null;
    }
}

export function createWorkspaceSmtpTransport() {
    return nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
        },
    });
}
