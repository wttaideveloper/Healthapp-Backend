import nodemailer from "nodemailer";

import { env } from "@config/env";

export function inferWorkspaceDisplayName(email: string, explicitName?: string | null): string {
    if (explicitName && explicitName.trim().length > 0) return explicitName.trim();
    const localPart = email.split("@")[0] ?? "User";
    return localPart || "User";
}

export function getWorkspaceInviteEmailContent(input: {
    organizationName: string;
    userName: string;
    userEmail: string;
    isOwner?: boolean;
    subject?: string;
}) {
    const isOwner = input.isOwner ?? false;
    const subject =
        input.subject ??
        (isOwner
            ? `You’ve Been Added as Workspace Admin to ${input.organizationName}’s “Discover your health age” App Pro Account`
            : `You’ve Been Added to ${input.organizationName}’s “Discover your health age” App’s Pro Account`);

    const introRoleLine = isOwner
        ? "You have been added as the workspace administrator for your organization."
        : "Your organization administrator has granted you access to premium features as part of your organization’s subscription.";

    const text = `Hello ${input.userName},

You’ve been added to the Pro account for ${input.organizationName} on “Discover your health age” App.
${introRoleLine}

To get started:
1. Visit: https://health-age-admin.vercel.app/workspace-admin
2. Download the app for your device (iPhone, Android, Windows, or Mac)
3. Sign in using this email address: ${input.userEmail}
4. If you don’t already have an account, create one using this email address
5. Your Pro access will automatically be activated after login`;

    const html = `<p>Hello ${input.userName},</p>
<p>You’ve been added to the Pro account for <strong>${input.organizationName}</strong> on “Discover your health age” App.</p>
<p>${introRoleLine}</p>
<p>To get started:</p>
<ol>
<li>Visit: <a href="https://health-age-admin.vercel.app/workspace-admin">https://health-age-admin.vercel.app/workspace-admin</a></li>
<li>Download the app for your device (iPhone, Android, Windows, or Mac)</li>
<li>Sign in using this email address: <strong>${input.userEmail}</strong></li>
<li>If you don’t already have an account, create one using this email address</li>
<li>Your Pro access will automatically be activated after login</li>
</ol>`;

    return { subject, text, html };
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
