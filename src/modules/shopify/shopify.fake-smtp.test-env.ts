/**
 * Test support: a scriptable SMTP server on LOOPBACK, so real nodemailer produces real errors, plus realistic error
 * fixtures for the tests that do not need a socket. Test-only: the `.test-env.ts` suffix keeps it out of the build.
 *
 * Everything listens on 127.0.0.1 and nothing leaves this machine. No real email is ever sent.
 */
import net from "node:net";

import nodemailer from "nodemailer";

import type { ShopifyPurchaseEmailTransport } from "./shopify.email-delivery";

export type FakeSmtpBehavior = {
    /** The first line the server sends. `null`: it accepts the connection and says nothing at all. */
    greeting?: string | null;
    /** When set the server advertises AUTH PLAIN and answers it with this reply line (e.g. "535 5.7.8 bad credentials"). */
    auth?: string;
    mailFrom?: string;
    rcpt?: string;
    /** What happens once the WHOLE message body has arrived: accept it (250), drop the connection, say nothing, or a reply line. */
    afterData?: "accept" | "drop" | "silent" | string;
    /** Wait this long before the final reply, to model a slow server. */
    dataReplyDelayMs?: number;
    /** Destroy the connection right after answering EHLO. */
    dropAfterEhlo?: boolean;
};

export type FakeSmtpServer = {
    port: number;
    /** Messages whose whole body reached the server, whatever it then did with them. */
    received: Array<{ to: string[]; body: string }>;
    /** Messages the server really accepted (answered 250 to). */
    readonly accepted: number;
    readonly connections: number;
    close(): Promise<void>;
};

const CRLF = "\r\n";
const END_OF_DATA = "\r\n.\r\n";

export async function startFakeSmtpServer(behavior: FakeSmtpBehavior = {}): Promise<FakeSmtpServer> {
    const state = { accepted: 0, connections: 0 };
    const received: FakeSmtpServer["received"] = [];
    const sockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
        state.connections += 1;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);

        let inData = false;
        let buffer = "";
        let body = "";
        const recipients: string[] = [];
        const reply = (line: string) => socket.write(`${line}${CRLF}`);

        if (behavior.greeting !== null) reply(behavior.greeting ?? "220 fake ESMTP");

        const finishData = () => {
            received.push({ to: [...recipients], body });
            const after = behavior.afterData ?? "accept";
            const respond = () => {
                if (after === "drop") return socket.destroy();
                if (after === "silent") return undefined;
                if (after === "accept") {
                    state.accepted += 1;
                    return reply("250 2.0.0 queued");
                }
                return reply(after);
            };
            if (behavior.dataReplyDelayMs) setTimeout(respond, behavior.dataReplyDelayMs);
            else respond();
        };

        const takeBody = (): boolean => {
            const end = buffer.indexOf(END_OF_DATA);
            if (end === -1) return false;
            body = buffer.slice(0, end);
            buffer = buffer.slice(end + END_OF_DATA.length);
            inData = false;
            finishData();
            return true;
        };

        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            if (inData) {
                takeBody();
                return;
            }
            let newline: number;
            while (!inData && (newline = buffer.indexOf(CRLF)) !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + CRLF.length);
                if (/^EHLO/i.test(line)) {
                    if (behavior.auth) socket.write(`250-fake${CRLF}250 AUTH PLAIN${CRLF}`);
                    else reply("250 fake");
                    if (behavior.dropAfterEhlo) {
                        socket.destroy();
                        return;
                    }
                } else if (/^AUTH/i.test(line)) {
                    reply(behavior.auth ?? "235 2.7.0 ok");
                } else if (/^MAIL/i.test(line)) {
                    reply(behavior.mailFrom ?? "250 2.1.0 ok");
                } else if (/^RCPT/i.test(line)) {
                    const answer = behavior.rcpt ?? "250 2.1.5 ok";
                    if (answer.startsWith("2")) recipients.push(line.replace(/^RCPT TO:\s*<?/i, "").replace(/>?\s*$/, ""));
                    reply(answer);
                } else if (/^DATA/i.test(line)) {
                    reply("354 go ahead");
                    inData = true;
                    takeBody();
                } else if (/^QUIT/i.test(line)) {
                    socket.end(`221 bye${CRLF}`);
                } else if (/^(RSET|NOOP)/i.test(line)) {
                    reply("250 ok");
                }
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as net.AddressInfo;

    return {
        port,
        received,
        get accepted() {
            return state.accepted;
        },
        get connections() {
            return state.connections;
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** A port nothing listens on: connecting to it is refused. */
export async function closedLoopbackPort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

/** A REAL nodemailer transport aimed at a loopback port, with short timeouts so the failure scenarios run fast. */
export function loopbackTransport(port: number, overrides: Record<string, unknown> = {}): ShopifyPurchaseEmailTransport {
    return nodemailer.createTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        ignoreTLS: true,
        connectionTimeout: 2_000,
        greetingTimeout: 2_000,
        socketTimeout: 2_000,
        ...overrides,
    });
}

/**
 * Error shapes as real nodemailer produces them. shopify.email-delivery.test.ts proves each one against the real library
 * and a local fake server, so these cheap stand-ins for the queue tests cannot drift from reality.
 */
export const smtpErrors = {
    /** Connection refused / host unreachable: nodemailer relabels it ESOCKET but Node keeps syscall "connect". */
    connectionRefused: () =>
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:25"), {
            code: "ESOCKET",
            syscall: "connect",
            errno: -111,
            address: "127.0.0.1",
            port: 25,
            command: "CONN",
        }),
    connectTimeout: () => Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" }),
    greetingTimeout: () => Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT", command: "CONN" }),
    /** The server took the whole message and then dropped the connection: it may have it. */
    droppedAfterData: () => Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION", command: "CONN" }),
    /** The server went silent in the middle of the conversation. */
    silentMidSession: () => Object.assign(new Error("Timeout"), { code: "ETIMEDOUT", command: "CONN" }),
    temporaryReply: (responseCode = 451) =>
        Object.assign(new Error(`Recipient command failed: ${responseCode} 4.2.0 try again later`), { code: "EENVELOPE", responseCode, command: "RCPT TO" }),
    permanentReply: (responseCode = 550) =>
        Object.assign(new Error(`Recipient command failed: ${responseCode} 5.1.1 no such user`), { code: "EENVELOPE", responseCode, command: "RCPT TO" }),
    authFailed: () => Object.assign(new Error("Invalid login: 535 5.7.8 bad credentials"), { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }),
};
