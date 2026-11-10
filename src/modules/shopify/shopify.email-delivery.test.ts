/**
 * SMTP failure handling, tested against REAL nodemailer talking to a scriptable fake SMTP server on 127.0.0.1.
 *
 * This is the test that was missing: the first version of the classifier was written against assumed error codes
 * (it treated a refused connection as permanent and a mid-send drop as retryable). Here every scenario runs through the
 * real library, so the classification is checked against what nodemailer genuinely reports. Nothing leaves this machine.
 */
import "./shopify.test-env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    DEFAULT_SEND_TIMEOUT_MS,
    PURCHASE_SMTP_TIMEOUTS,
    SmtpSendWatchdogError,
    attemptSendPurchaseEmail,
    buildPurchaseSmtpOptions,
    classifySmtpFailure,
    createPurchaseSmtpTransport,
    isTransientSmtpError,
    type SmtpFailureClass,
} from "./shopify.email-delivery";
import { PURCHASE_EMAIL_LEASE_MS } from "./shopify.email-outbox";
import type { ShopifyPurchaseEmailContent } from "./shopify.purchase-email";
import {
    closedLoopbackPort,
    loopbackTransport,
    smtpErrors,
    startFakeSmtpServer,
    type FakeSmtpBehavior,
} from "./shopify.fake-smtp.test-env";

const EMAIL: ShopifyPurchaseEmailContent = {
    recipientEmail: "buyer@example.com",
    customerName: "Pat Morgan",
    orderNumber: "1042",
    scenario: "new_workspace",
    workspaceName: "Pat Morgan",
    workspaceOwnerEmail: "buyer@example.com",
    accountExists: false,
    lines: [{ productId: "large_venue_kit", label: "Large Venue Kit", quantity: 1, licenses: 4 }],
    licensesAdded: 4,
    workspaceTotalLicenses: 4,
    purchasedAt: "2026-11-02T10:00:00.000Z",
    accessExpiresAt: "2027-11-02T10:00:00.000Z",
    hasOtherItems: false,
};

type Scenario = {
    name: string;
    behavior: FakeSmtpBehavior;
    /** nodemailer options for the client. */
    client?: Record<string, unknown>;
    expected: SmtpFailureClass | "sent";
    /** What nodemailer reports. */
    code?: string;
    responseCode?: number;
    /** Did the server get the complete message body? (Where it did, a wrong "retry" would mail the customer twice.) */
    serverGotTheMessage: boolean;
    /** Did the server actually accept (250) it? */
    serverAccepted: boolean;
};

const SCENARIOS: Scenario[] = [
    { name: "a healthy server accepts the message", behavior: {}, expected: "sent", serverGotTheMessage: true, serverAccepted: true },

    // ---- the message never reached the server: safe to repeat
    { name: "the server greets with 421 (busy) and hangs up", behavior: { greeting: "421 4.3.2 service not available" }, expected: "retry", responseCode: 421, serverGotTheMessage: false, serverAccepted: false },
    { name: "the server never says hello (greeting timeout)", behavior: { greeting: null }, client: { greetingTimeout: 300 }, expected: "retry", code: "ETIMEDOUT", serverGotTheMessage: false, serverAccepted: false },
    { name: "temporary 450 at MAIL FROM", behavior: { mailFrom: "450 4.2.1 mailbox busy" }, expected: "retry", responseCode: 450, serverGotTheMessage: false, serverAccepted: false },
    { name: "temporary 451 at RCPT TO (greylisting)", behavior: { rcpt: "451 4.7.1 greylisted, try later" }, expected: "retry", responseCode: 451, serverGotTheMessage: false, serverAccepted: false },
    { name: "temporary 454 at authentication", behavior: { auth: "454 4.7.0 temporary authentication failure" }, client: { auth: { user: "u", pass: "p" } }, expected: "retry", responseCode: 454, serverGotTheMessage: false, serverAccepted: false },
    {
        // The server HAS the whole body but answered 451: by the SMTP rules it did not accept it, so repeating is safe.
        name: "temporary 451 AFTER the body (server read it, then refused it for now)",
        behavior: { afterData: "451 4.3.0 try again later" },
        expected: "retry",
        responseCode: 451,
        serverGotTheMessage: true,
        serverAccepted: false,
    },

    // ---- final refusals
    { name: "permanent 550 at RCPT TO (no such mailbox)", behavior: { rcpt: "550 5.1.1 no such user" }, expected: "rejected", responseCode: 550, serverGotTheMessage: false, serverAccepted: false },
    { name: "permanent 554 AFTER the body (rejected as spam)", behavior: { afterData: "554 5.7.1 rejected as spam" }, expected: "rejected", responseCode: 554, serverGotTheMessage: true, serverAccepted: false },
    { name: "authentication fails (535 bad credentials)", behavior: { auth: "535 5.7.8 bad credentials" }, client: { auth: { user: "u", pass: "p" } }, expected: "rejected", code: "EAUTH", responseCode: 535, serverGotTheMessage: false, serverAccepted: false },

    // ---- the server may hold the message: NEVER repeat
    { name: "the server takes the whole message and drops the connection", behavior: { afterData: "drop" }, expected: "unknown_delivery", code: "ECONNECTION", serverGotTheMessage: true, serverAccepted: false },
    { name: "the server takes the whole message and goes silent (socket timeout)", behavior: { afterData: "silent" }, client: { socketTimeout: 400 }, expected: "unknown_delivery", code: "ETIMEDOUT", serverGotTheMessage: true, serverAccepted: false },
    {
        // The classifier cannot tell this from a drop after the body, so it errs on the side of not repeating.
        name: "the connection is cut mid-conversation, before any message (conservatively not repeated)",
        behavior: { dropAfterEhlo: true },
        expected: "unknown_delivery",
        code: "ESOCKET",
        serverGotTheMessage: false,
        serverAccepted: false,
    },
];

describe("real nodemailer against a local fake SMTP server", () => {
    for (const scenario of SCENARIOS) {
        it(`${scenario.name} -> ${scenario.expected}`, async () => {
            const server = await startFakeSmtpServer(scenario.behavior);
            try {
                const result = await attemptSendPurchaseEmail(EMAIL, { createTransport: () => loopbackTransport(server.port, scenario.client) });

                if (scenario.expected === "sent") {
                    assert.deepEqual(result, { ok: true });
                } else {
                    assert.equal(result.ok, false);
                    if (result.ok) return;
                    assert.equal(result.failure, scenario.expected, `${result.error.code} ${result.error.responseCode ?? ""} ${result.error.message}`);
                    assert.equal(result.transient, scenario.expected === "retry");
                    assert.equal(result.stage, "send");
                    if (scenario.code) assert.equal(result.error.code, scenario.code);
                    if (scenario.responseCode) assert.equal(result.error.responseCode, scenario.responseCode);
                }

                assert.equal(server.received.length === 1, scenario.serverGotTheMessage, "did the server get the complete message?");
                assert.equal(server.accepted === 1, scenario.serverAccepted, "did the server accept it?");
            } finally {
                await server.close();
            }
        });
    }

    it("a refused connection (the server is down) is retried, and nodemailer reports it as ESOCKET with syscall 'connect'", async () => {
        const port = await closedLoopbackPort();
        const transport = loopbackTransport(port);

        const raw = await transport.sendMail({ from: "a@example.test", to: "b@example.test", subject: "x", text: "x", html: "<p>x</p>" }).then(
            () => undefined,
            (error: unknown) => error as Record<string, unknown>
        );
        assert.ok(raw, "nodemailer reports an error");
        assert.equal(raw.code, "ESOCKET", "the original ECONNREFUSED is overwritten with ESOCKET");
        assert.equal(raw.syscall, "connect", "but Node's syscall survives, which is what identifies a connect-phase failure");
        assert.equal(classifySmtpFailure(raw), "retry");

        const result = await attemptSendPurchaseEmail(EMAIL, { createTransport: () => loopbackTransport(port) });
        assert.ok(!result.ok && result.failure === "retry" && result.transient, "this is the outage the first version abandoned on attempt 1");
    });

    it("a server that accepts the message is sent to exactly once, with the right recipient and subject", async () => {
        const server = await startFakeSmtpServer();
        try {
            assert.deepEqual(await attemptSendPurchaseEmail(EMAIL, { createTransport: () => loopbackTransport(server.port) }), { ok: true });
            assert.equal(server.received.length, 1);
            assert.deepEqual(server.received[0]?.to, ["buyer@example.com"]);
            assert.match(server.received[0]!.body, /Subject: Your HealthAge Large Venue Kit Purchase Is Confirmed!/);
        } finally {
            await server.close();
        }
    });
});

describe("the watchdog: a send that takes too long is 'unknown', never retried", () => {
    it("fires while the slow server is still working, reports unknown_delivery, and the message arrives exactly once afterwards", async () => {
        const server = await startFakeSmtpServer({ dataReplyDelayMs: 700 });
        try {
            const result = await attemptSendPurchaseEmail(EMAIL, {
                createTransport: () => loopbackTransport(server.port, { socketTimeout: 5_000 }),
                sendTimeoutMs: 200,
            });

            assert.ok(!result.ok);
            if (result.ok) return;
            assert.equal(result.failure, "unknown_delivery");
            assert.equal(result.transient, false, "so the queue will not send it again");
            assert.equal(result.error.code, "ESENDTIMEOUT");
            assert.equal(server.accepted, 0, "at the moment the watchdog fired, nothing had been accepted yet");

            await new Promise((resolve) => setTimeout(resolve, 900));
            assert.equal(server.accepted, 1, "the slow send still completed in the background: one message, which a retry would have doubled");
            assert.equal(server.received.length, 1);
        } finally {
            await server.close();
        }
    });

    it("the default watchdog leaves a wide margin inside the outbox lease", () => {
        assert.ok(DEFAULT_SEND_TIMEOUT_MS * 2 <= PURCHASE_EMAIL_LEASE_MS, `${DEFAULT_SEND_TIMEOUT_MS} ms vs lease ${PURCHASE_EMAIL_LEASE_MS} ms`);
    });

    it("the error is recognised as unknown wherever it surfaces", () => {
        assert.equal(classifySmtpFailure(new SmtpSendWatchdogError(100)), "unknown_delivery");
        assert.equal(classifySmtpFailure(Object.assign(new Error("x"), { code: "ESENDTIMEOUT" })), "unknown_delivery");
    });
});

describe("classification table (shapes real nodemailer produces, plus Node errors that bypass nodemailer)", () => {
    const cases: Array<[string, unknown, SmtpFailureClass]> = [
        ["server reply 421", Object.assign(new Error("x"), { code: "EPROTOCOL", responseCode: 421 }), "retry"],
        ["server reply 4xx on any code", Object.assign(new Error("x"), { code: "EMESSAGE", responseCode: 452 }), "retry"],
        ["server reply 5xx on any code", Object.assign(new Error("x"), { code: "ESOCKET", responseCode: 554 }), "rejected"],
        ["DNS failure", Object.assign(new Error("getaddrinfo ENOTFOUND smtp.invalid"), { code: "EDNS" }), "retry"],
        ["TLS set-up failure", Object.assign(new Error("Error initiating TLS"), { code: "ETLS" }), "retry"],
        ["connect-phase socket error", smtpErrors.connectionRefused(), "retry"],
        ["connect timeout", smtpErrors.connectTimeout(), "retry"],
        ["greeting timeout", smtpErrors.greetingTimeout(), "retry"],
        ["raw Node ECONNREFUSED (no nodemailer wrapper)", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect" }), "retry"],
        ["raw Node DNS failure", Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN", syscall: "getaddrinfo" }), "retry"],
        [
            "Node's AggregateError when every address refused",
            Object.assign(new AggregateError([Object.assign(new Error("a"), { syscall: "connect" }), Object.assign(new Error("b"), { syscall: "connect" })], "all refused"), { code: "ESOCKET" }),
            "retry",
        ],
        ["mid-session close", smtpErrors.droppedAfterData(), "unknown_delivery"],
        ["mid-session silence", smtpErrors.silentMidSession(), "unknown_delivery"],
        ["socket error after connecting", Object.assign(new Error("read ECONNRESET"), { code: "ESOCKET", syscall: "read" }), "unknown_delivery"],
        ["permanent reply", smtpErrors.permanentReply(), "rejected"],
        ["bad credentials", smtpErrors.authFailed(), "rejected"],
        ["invalid recipient (no reply)", Object.assign(new Error("Invalid recipient"), { code: "EENVELOPE" }), "rejected"],
        ["message too large (no reply)", Object.assign(new Error("Message size larger than allowed"), { code: "EMESSAGE" }), "rejected"],
        ["protocol error (no reply)", Object.assign(new Error("Invalid greeting"), { code: "EPROTOCOL" }), "rejected"],
        ["a plain Error", new Error("boom"), "rejected"],
        ["a string", "boom", "rejected"],
        ["undefined", undefined, "rejected"],
    ];

    for (const [name, error, expected] of cases) {
        it(`${name} -> ${expected}`, () => {
            assert.equal(classifySmtpFailure(error), expected);
            assert.equal(isTransientSmtpError(error), expected === "retry");
        });
    }
});

describe("the fixtures used by the queue tests really are what nodemailer produces", () => {
    async function realError(behavior: FakeSmtpBehavior, client: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const server = await startFakeSmtpServer(behavior);
        try {
            const error = await loopbackTransport(server.port, client)
                .sendMail({ from: "a@example.test", to: "b@example.test", subject: "x", text: "x", html: "<p>x</p>" })
                .then(
                    () => undefined,
                    (failure: unknown) => failure as Record<string, unknown>
                );
            assert.ok(error);
            return error;
        } finally {
            await server.close();
        }
    }

    const same = (fixture: Error, real: Record<string, unknown>, fields: string[]) => {
        for (const field of fields) assert.equal((fixture as unknown as Record<string, unknown>)[field], real[field], field);
    };

    it("connection refused", async () => {
        const port = await closedLoopbackPort();
        const real = await loopbackTransport(port)
            .sendMail({ from: "a@example.test", to: "b@example.test", subject: "x", text: "x", html: "<p>x</p>" })
            .then(
                () => undefined,
                (failure: unknown) => failure as Record<string, unknown>
            );
        same(smtpErrors.connectionRefused(), real!, ["code", "syscall", "command"]);
    });

    it("greeting timeout", async () => {
        const real = await realError({ greeting: null }, { greetingTimeout: 300 });
        same(smtpErrors.greetingTimeout(), real, ["code", "command", "message"]);
    });

    it("dropped after the data / silent mid-session", async () => {
        same(smtpErrors.droppedAfterData(), await realError({ afterData: "drop" }), ["code", "command", "message"]);
        same(smtpErrors.silentMidSession(), await realError({ afterData: "silent" }, { socketTimeout: 400 }), ["code", "command", "message"]);
    });

    it("temporary and permanent replies, and failed authentication", async () => {
        same(smtpErrors.temporaryReply(451), await realError({ rcpt: "451 4.2.0 try again later" }), ["code", "responseCode", "command"]);
        same(smtpErrors.permanentReply(550), await realError({ rcpt: "550 5.1.1 no such user" }), ["code", "responseCode", "command"]);
        same(smtpErrors.authFailed(), await realError({ auth: "535 5.7.8 bad credentials" }, { auth: { user: "u", pass: "p" } }), ["code", "responseCode"]);
    });
});

describe("the production transport", () => {
    it("carries nodemailer's own timeouts, so a dead server cannot hold a send for an hour", () => {
        const options = buildPurchaseSmtpOptions();
        for (const [name, value] of Object.entries(PURCHASE_SMTP_TIMEOUTS)) {
            assert.equal((options as Record<string, unknown>)[name], value, name);
            assert.ok(value <= 60_000, `${name} is bounded`);
        }
        assert.ok(PURCHASE_SMTP_TIMEOUTS.socketTimeout * 2 <= DEFAULT_SEND_TIMEOUT_MS + PURCHASE_SMTP_TIMEOUTS.socketTimeout, "the watchdog sits above the socket timeout");
    });

    it("uses the same server, port and login as the rest of HealthAge email, and the real transport object honours the timeouts", () => {
        const options = buildPurchaseSmtpOptions();
        assert.equal(options.host, process.env.SMTP_HOST);
        assert.equal(options.port, Number(process.env.SMTP_PORT));
        assert.equal(options.secure, Number(process.env.SMTP_PORT) === 465);
        assert.equal(options.auth.user, process.env.SMTP_USER);

        const transport = createPurchaseSmtpTransport() as unknown as { transporter: { options: Record<string, unknown> } };
        assert.equal(transport.transporter.options.connectionTimeout, PURCHASE_SMTP_TIMEOUTS.connectionTimeout);
        assert.equal(transport.transporter.options.socketTimeout, PURCHASE_SMTP_TIMEOUTS.socketTimeout);
    });
});
