import "./shopify.test-env";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

import { errorHandlerPlugin } from "@plugins/error-handler.plugin";
import { shopifyOrderPaidWebhookRoutes, shopifyRoutes } from "./shopify.route";

const WEBHOOK_SECRET = "shopify-webhook-secret";
const BODY = '{"id":1001,"email":"buyer@example.com","line_items":[]}';

function sign(body: string): string {
    return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("base64");
}

async function buildWebhookApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(fastifyRawBody, {
        field: "rawBody",
        global: false,
        runFirst: true,
        encoding: false,
    });
    await app.register(errorHandlerPlugin);

    // Duplicate webhook path: transaction short-circuits as duplicate without touching Drizzle.
    app.decorate("db", {
        transaction: async () => true,
    });

    await app.register(shopifyRoutes, { prefix: "/api/v1/shopify" });
    await app.register(shopifyOrderPaidWebhookRoutes, { prefix: "/shopify/webhooks" });
    await app.ready();
    return app;
}

describe("Shopify webhook HTTP routes", () => {
    it("POST /shopify/webhooks/order-paid rejects invalid HMAC with 401", async () => {
        const app = await buildWebhookApp();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/shopify/webhooks/order-paid",
                headers: {
                    "content-type": "application/json",
                    "x-shopify-hmac-sha256": "invalid",
                    "x-shopify-topic": "orders/paid",
                    "x-shopify-webhook-id": "wh_invalid",
                    "x-shopify-shop-domain": "qfiprz-kw.myshopify.com",
                },
                payload: BODY,
            });

            assert.equal(response.statusCode, 401);
        } finally {
            await app.close();
        }
    });

    it("POST /shopify/webhooks/order-paid accepts a valid HMAC and returns 200", async () => {
        const app = await buildWebhookApp();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/shopify/webhooks/order-paid",
                headers: {
                    "content-type": "application/json",
                    "x-shopify-hmac-sha256": sign(BODY),
                    "x-shopify-topic": "orders/paid",
                    "x-shopify-webhook-id": "wh_valid",
                    "x-shopify-shop-domain": "qfiprz-kw.myshopify.com",
                },
                payload: BODY,
            });

            assert.equal(response.statusCode, 200);
            assert.deepEqual(response.json(), { ok: true });
        } finally {
            await app.close();
        }
    });

    it("POST /shopify/webhooks/order-paid defaults missing topic to orders/paid", async () => {
        const app = await buildWebhookApp();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/shopify/webhooks/order-paid",
                headers: {
                    "content-type": "application/json",
                    "x-shopify-hmac-sha256": sign(BODY),
                    "x-shopify-webhook-id": "wh_default_topic",
                    "x-shopify-shop-domain": "qfiprz-kw.myshopify.com",
                },
                payload: BODY,
            });

            assert.equal(response.statusCode, 200);
            assert.deepEqual(response.json(), { ok: true });
        } finally {
            await app.close();
        }
    });

    it("keeps POST /api/v1/shopify/webhook compatibility", async () => {
        const app = await buildWebhookApp();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/api/v1/shopify/webhook",
                headers: {
                    "content-type": "application/json",
                    "x-shopify-hmac-sha256": sign(BODY),
                    "x-shopify-topic": "orders/paid",
                    "x-shopify-webhook-id": "wh_compat",
                    "x-shopify-shop-domain": "qfiprz-kw.myshopify.com",
                },
                payload: BODY,
            });

            assert.equal(response.statusCode, 200);
            assert.deepEqual(response.json(), { ok: true });
        } finally {
            await app.close();
        }
    });

    it("returns 200 for a duplicate webhook delivery", async () => {
        const app = await buildWebhookApp();
        try {
            const headers = {
                "content-type": "application/json",
                "x-shopify-hmac-sha256": sign(BODY),
                "x-shopify-topic": "orders/paid",
                "x-shopify-webhook-id": "wh_duplicate",
                "x-shopify-shop-domain": "qfiprz-kw.myshopify.com",
            };

            const first = await app.inject({ method: "POST", url: "/shopify/webhooks/order-paid", headers, payload: BODY });
            const second = await app.inject({ method: "POST", url: "/shopify/webhooks/order-paid", headers, payload: BODY });

            assert.equal(first.statusCode, 200);
            assert.equal(second.statusCode, 200);
        } finally {
            await app.close();
        }
    });
});
