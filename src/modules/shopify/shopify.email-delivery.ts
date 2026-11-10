/**
 * One attempt to send a Shopify purchase confirmation email, and what to make of the result.
 *
 * This file knows about SMTP and the environment; it knows nothing about the database. The durable queue that
 * decides WHEN to attempt, how often and when to give up is `shopify.email-outbox.ts`.
 *
 * THE ONE RULE for failures: only repeat an attempt when the message PROVABLY did not reach the mail server.
 * A repeat after an ambiguous failure can deliver a second copy to the customer. So every failure is sorted into
 * one of three classes (`classifySmtpFailure`), based on what nodemailer really reports (verified against the real
 * library and local fake SMTP servers in shopify.email-delivery.test.ts, not on assumed error codes):
 *
 *   retry             nothing was sent: the connection could not be made (refused, unreachable, DNS, connect or
 *                     greeting timeout, TLS set-up) or the server answered with a temporary 4xx reply
 *   unknown_delivery  the connection broke or went silent mid-session, or our watchdog gave up while sending: the
 *                     server may already hold the message. Never repeated automatically
 *   rejected          the server refused it for good (5xx, bad credentials, bad address) or the email could not be built
 */
import nodemailer from "nodemailer";

import { env } from "@config/env";

import { buildShopifyPurchaseEmail, type ShopifyPurchaseEmailContent } from "./shopify.purchase-email";

/** The purchase email with this environment's store links and support address (unset values mean the published defaults). */
export function getShopifyPurchaseEmailContent(email: ShopifyPurchaseEmailContent) {
    return buildShopifyPurchaseEmail({
        ...email,
        storeUrls: {
            android: env.HEALTHAGE_ANDROID_URL,
            ios: env.HEALTHAGE_IOS_URL,
            windows: env.HEALTHAGE_WINDOWS_URL,
            macos: env.HEALTHAGE_MACOS_URL,
        },
        supportEmail: env.HEALTHAGE_SUPPORT_EMAIL,
    });
}

export type ShopifyPurchaseEmailTransport = {
    sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
};

export type ShopifyPurchaseEmailSendDeps = {
    /** The SMTP transport. Tests pass a fake or a local one; production uses `createPurchaseSmtpTransport`. */
    createTransport?: () => ShopifyPurchaseEmailTransport;
    /** The watchdog: the longest one whole attempt may take. Must stay well under the outbox lease. */
    sendTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * nodemailer's own timeouts for this module's connections. Without them nodemailer waits up to an hour on a silent
 * socket. They are deliberately generous for a slow-but-working server and short for a dead one:
 *   connectionTimeout  TCP connect          greetingTimeout  the server's first "220" line
 *   dnsTimeout         name lookup          socketTimeout    silence in the middle of the conversation
 */
export const PURCHASE_SMTP_TIMEOUTS = {
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    dnsTimeout: 10_000,
    socketTimeout: 60_000,
} as const;

/** The SMTP settings for purchase emails: the same server and login as every other HealthAge email, plus the timeouts. */
export function buildPurchaseSmtpOptions() {
    return {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        ...PURCHASE_SMTP_TIMEOUTS,
    };
}

/**
 * A dedicated transport so the timeouts apply to purchase emails only: the shared workspace transport (invitations,
 * admin-created workspaces) is deliberately left exactly as it was.
 */
export function createPurchaseSmtpTransport(): ShopifyPurchaseEmailTransport {
    return nodemailer.createTransport(buildPurchaseSmtpOptions());
}

// ---------------------------------------------------------------------------
// Classifying a failure
// ---------------------------------------------------------------------------

export type SmtpFailureClass = "retry" | "unknown_delivery" | "rejected";

/** Thrown by our own watchdog when a send takes too long: the outcome is unknown, so it is never retried. */
export class SmtpSendWatchdogError extends Error {
    readonly code = "ESENDTIMEOUT";
    constructor(ms: number) {
        super(`Sending took longer than ${ms} ms; whether the server received the message is unknown`);
        this.name = "SmtpSendWatchdogError";
    }
}

type ErrorShape = { code?: unknown; responseCode?: unknown; syscall?: unknown; errors?: unknown; message?: unknown };

/** True for a failure of the TCP connect itself. nodemailer overwrites `code` with ESOCKET but keeps Node's `syscall`. */
function failedWhileConnecting(error: ErrorShape): boolean {
    if (error.syscall === "connect" || error.syscall === "getaddrinfo") return true;
    // Node reports "every address refused" as an AggregateError whose members carry the syscall.
    return (
        Array.isArray(error.errors) &&
        error.errors.length > 0 &&
        error.errors.every((member) => !!member && typeof member === "object" && (member as ErrorShape).syscall === "connect")
    );
}

/**
 * Sorts a failed attempt into retry / unknown_delivery / rejected. Order matters:
 *  1. A reply from the server decides: 4xx means "not accepted, try later" (even after the message body, the server has
 *     said it did not take it); anything else is final.
 *  2. Failures that can only happen BEFORE any message data is sent are safe to repeat.
 *  3. Any other connection-level failure may have happened after the server took the message: unknown.
 *  4. Everything else (invalid address, authentication, protocol errors, our own bugs) is final.
 */
export function classifySmtpFailure(error: unknown): SmtpFailureClass {
    if (error instanceof SmtpSendWatchdogError) return "unknown_delivery";
    if (!error || typeof error !== "object") return "rejected";

    const shape = error as ErrorShape;
    if (typeof shape.responseCode === "number") {
        return shape.responseCode >= 400 && shape.responseCode < 500 ? "retry" : "rejected";
    }

    const code = typeof shape.code === "string" ? shape.code : "";
    const message = typeof shape.message === "string" ? shape.message : "";

    if (failedWhileConnecting(shape)) return "retry";
    if (code === "EDNS" || code === "ETLS") return "retry";
    if (code === "ETIMEDOUT" && /^(Connection timeout|Greeting never received)/.test(message)) return "retry";

    if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "ESENDTIMEOUT") return "unknown_delivery";

    return "rejected";
}

/** Kept for callers that only need the yes/no: is it safe to repeat this attempt? */
export function isTransientSmtpError(error: unknown): boolean {
    return classifySmtpFailure(error) === "retry";
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/** "pat@example.com" -> "p***@example.com": enough to match a support ticket, not a mailing list. */
export function maskEmailForLog(email: string): string {
    const at = email.lastIndexOf("@");
    if (at < 1) return "***";
    return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export type EmailErrorSummary = { code?: string; responseCode?: number; command?: string; message: string };

/**
 * A log-safe summary of an email error: the codes and a short message, with the SMTP credentials scrubbed from the
 * text in case a server echoes them. Never the raw error object, which can carry the whole SMTP conversation.
 */
export function summarizeEmailError(error: unknown): EmailErrorSummary {
    const source = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [env.SMTP_PASS, env.SMTP_USER]) {
        if (secret && secret.length >= 3) message = message.split(secret).join("[redacted]");
    }
    return {
        ...(typeof source.code === "string" ? { code: source.code } : {}),
        ...(typeof source.responseCode === "number" ? { responseCode: source.responseCode } : {}),
        ...(typeof source.command === "string" ? { command: source.command } : {}),
        message: message.slice(0, 300),
    };
}

/** The short note stored in `purchase_email_last_error`: the codes and a clipped message, no addresses or bodies. */
export function formatErrorNote(summary: EmailErrorSummary): string {
    const parts = [summary.code, summary.responseCode !== undefined ? String(summary.responseCode) : undefined, summary.command].filter(Boolean);
    return `${parts.length > 0 ? `${parts.join(" ")}: ` : ""}${summary.message}`.slice(0, 400);
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

/** Longer than nodemailer's own phases can add up to on a slow server, and well under the 5-minute outbox lease. */
export const DEFAULT_SEND_TIMEOUT_MS = 120_000;

export type SendAttemptResult =
    | { ok: true }
    | {
          ok: false;
          stage: "build" | "send";
          failure: SmtpFailureClass;
          /** True only for `failure === "retry"`. */
          transient: boolean;
          error: EmailErrorSummary;
      };

function withWatchdog<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SmtpSendWatchdogError(ms)), ms);
    });
    return Promise.race([promise, watchdog]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/** Builds and sends the email once. Never throws: the outcome is in the result. */
export async function attemptSendPurchaseEmail(
    email: ShopifyPurchaseEmailContent,
    deps: ShopifyPurchaseEmailSendDeps = {}
): Promise<SendAttemptResult> {
    let content: { subject: string; text: string; html: string };
    try {
        content = getShopifyPurchaseEmailContent(email);
    } catch (error) {
        return { ok: false, stage: "build", failure: "rejected", transient: false, error: summarizeEmailError(error) };
    }

    try {
        const transport = (deps.createTransport ?? createPurchaseSmtpTransport)();
        await withWatchdog(
            transport.sendMail({
                from: env.EMAIL_FROM ?? env.SMTP_USER,
                to: email.recipientEmail,
                subject: content.subject,
                text: content.text,
                html: content.html,
            }),
            deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
        );
        return { ok: true };
    } catch (error) {
        const failure = classifySmtpFailure(error);
        return { ok: false, stage: "send", failure, transient: failure === "retry", error: summarizeEmailError(error) };
    }
}
