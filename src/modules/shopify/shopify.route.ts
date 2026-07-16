import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";

import { env } from "@config/env";
import { BadRequestError, UnauthorizedError } from "@core/errors/http-errors";
import {
    recordShopifyWebhookEvent,
    sendShopifyWorkspaceOwnerWelcomeEmail,
    verifyShopifyWebhookHmac,
} from "./shopify.service";

function headerString(value: string | string[] | undefined): string | null {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
        return value[0];
    }
    return null;
}

/**
 * Shopify licensing routes.
 */
export const shopifyRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/webhook",
        {
            config: {
                rawBody: true,
            },
            schema: {
                summary: "Shopify webhook receiver",
                response: {
                    200: z.object({
                        ok: z.literal(true),
                    }),
                },
            },
        },
        async (req) => {
            if (!env.SHOPIFY_WEBHOOK_SECRET) {
                throw new BadRequestError("Shopify is not configured: missing SHOPIFY_WEBHOOK_SECRET");
            }

            const hmacHeader = headerString(req.headers["x-shopify-hmac-sha256"]);
            if (!hmacHeader) {
                throw new UnauthorizedError("Missing X-Shopify-Hmac-Sha256 header");
            }

            const topic = headerString(req.headers["x-shopify-topic"]);
            if (!topic) {
                throw new BadRequestError("Missing X-Shopify-Topic header");
            }

            const webhookId = headerString(req.headers["x-shopify-webhook-id"]);
            if (!webhookId) {
                throw new BadRequestError("Missing X-Shopify-Webhook-Id header");
            }

            const shopDomain = headerString(req.headers["x-shopify-shop-domain"]);

            const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
            if (!rawBody) {
                throw new BadRequestError("Missing raw webhook body");
            }

            const signatureValid = verifyShopifyWebhookHmac(rawBody, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET);
            if (!signatureValid) {
                req.log.warn({ topic, webhookId, shopDomain }, "Invalid Shopify webhook signature");
                throw new UnauthorizedError("Invalid Shopify webhook signature");
            }

            let payloadJson: Record<string, unknown>;
            try {
                payloadJson = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
            } catch (error) {
                req.log.warn({ err: error, topic, webhookId }, "Invalid Shopify webhook JSON body");
                throw new BadRequestError("Invalid Shopify webhook JSON body");
            }

            let result: Awaited<ReturnType<typeof recordShopifyWebhookEvent>>;
            try {
                result = await recordShopifyWebhookEvent(app, {
                    webhookId,
                    topic,
                    payloadJson,
                    shopDomain,
                    log: req.log,
                });
            } catch (error) {
                req.log.error({ err: error, topic, webhookId, shopDomain }, "Failed to process Shopify webhook");
                throw error;
            }

            if (result.duplicate) {
                req.log.info({ webhookId, topic, shopDomain }, "Ignoring duplicate Shopify webhook");
                return { ok: true as const };
            }

            if (result.ownerEmail) {
                await sendShopifyWorkspaceOwnerWelcomeEmail(req.log, result.ownerEmail);
            }

            req.log.info({ webhookId, topic, shopDomain }, "Processed Shopify webhook");

            return { ok: true as const };
        }
    );
};
