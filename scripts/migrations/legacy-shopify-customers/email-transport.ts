/**
 * SMTP delivery of the approved free-year email, shared by the apply CLI (stage 1)
 * and the send-emails CLI (stage 2) so both stages send byte-identical messages
 * built from the one approved template in `migration-email.ts`.
 *
 * This module imports NO mail library. The transport factory and the environment
 * are passed in, so nothing that imports it (the tests included) can reach a real
 * mail server by accident. Only the two CLI entry points import `nodemailer` and
 * hand `createTransport` in.
 */

import { getLegacyFreeYearEmailContent, type PurchaseSummary } from "./migration-email";

export type FreeYearEmailRequest = {
    /** Where this message is delivered. In test mode this is a test address, never the customer. */
    readonly to: string;
    /**
     * The greeting name, final. The caller infers it from the CUSTOMER's address;
     * it is never re-inferred from `to`, which would greet a customer by their
     * tester's mailbox name during a test send.
     */
    readonly customerName: string;
    /**
     * The address the PURCHASER registers and signs in with (the workspace owner email). Like the
     * greeting name it describes the customer, never `to`: in a test send `to` is the tester.
     */
    readonly accountEmail: string;
    readonly workspaceName: string;
    /** What the customer bought and how many licenses it is worth: from the migration, never recomputed. */
    readonly purchase: PurchaseSummary;
    readonly startDate: string;
    readonly expiryDate: string;
    readonly androidUrl: string | null;
    readonly windowsUrl: string | null;
    readonly iosUrl: string | null;
    readonly macosUrl: string | null;
    readonly supportEmail: string;
};

export type MailMessage = {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
    readonly headers?: Readonly<Record<string, string>>;
};

export type SendMailResult = {
    readonly accepted?: readonly unknown[];
    readonly rejected?: readonly unknown[];
};

export type MailTransport = {
    sendMail(message: MailMessage): Promise<SendMailResult>;
};

export type SmtpTransportConfig = {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly auth: { readonly user: string; readonly pass: string };
};

export type TransportDeps = {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly createTransport: (config: SmtpTransportConfig) => MailTransport;
};

export type SmtpSettings = SmtpTransportConfig & { readonly from: string };

/** Throws when SMTP is not configured, so a run can fail before it sends anything. */
export function readSmtpSettings(env: Readonly<Record<string, string | undefined>>): SmtpSettings {
    const host = env.SMTP_HOST;
    const port = Number(env.SMTP_PORT ?? "0");
    const user = env.SMTP_USER;
    const pass = env.SMTP_PASS;
    if (!host || !port || !user || !pass) {
        throw new Error("SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS are not configured");
    }
    return {
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        from: env.EMAIL_FROM ?? user,
    };
}

/** The exact message for a request: approved subject/text/html, unchanged. */
export function buildFreeYearMessage(
    request: FreeYearEmailRequest,
    from: string,
    headers?: Readonly<Record<string, string>>
): MailMessage {
    const content = getLegacyFreeYearEmailContent({
        customerName: request.customerName,
        accountEmail: request.accountEmail,
        workspaceName: request.workspaceName,
        purchase: request.purchase,
        startDate: request.startDate,
        expiryDate: request.expiryDate,
        androidUrl: request.androidUrl,
        windowsUrl: request.windowsUrl,
        iosUrl: request.iosUrl,
        macosUrl: request.macosUrl,
        supportEmail: request.supportEmail,
    });

    return {
        from,
        to: request.to,
        subject: content.subject,
        text: content.text,
        html: content.html,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    };
}

/**
 * Sends one free-year email. Resolves only when the SMTP server accepted the
 * recipient and rejected nobody; anything else throws, so the caller records
 * nothing in the ledger and the attempt stays retryable.
 *
 * "Accepted" means the server took responsibility for the message, not that it
 * reached the inbox. It is the strongest signal SMTP gives.
 */
export async function sendFreeYearEmail(
    request: FreeYearEmailRequest,
    deps: TransportDeps,
    options?: { readonly headers?: Readonly<Record<string, string>> }
): Promise<void> {
    const settings = readSmtpSettings(deps.env);
    const transport = deps.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: settings.auth,
    });

    const result = await transport.sendMail(buildFreeYearMessage(request, settings.from, options?.headers));

    const rejected = (result.rejected ?? []).map((value) => String(value));
    if (rejected.length > 0) {
        throw new Error(`SMTP server rejected recipient(s): ${rejected.join(", ")}`);
    }

    const wanted = request.to.trim().toLowerCase();
    const accepted = (result.accepted ?? []).map((value) => String(value).trim().toLowerCase());
    if (!accepted.includes(wanted)) {
        throw new Error(`SMTP server did not confirm acceptance of ${request.to}`);
    }
}
