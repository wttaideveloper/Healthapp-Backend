import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { createTx } from "../db";

async function transactionPluginCore(app: FastifyInstance) {
    app.addHook("onRequest", async (req) => {
        const client = await app.pgPool.connect();

        try {
            await client.query("BEGIN");

            req.tx = createTx(client);
            //req.container = buildRequestContainer({ tx: req.tx, app });
            (req as any)._pgClient = client;
        } catch (err) {
            client.release();
            throw err;
        }
    });

    app.addHook("onResponse", async (req) => {
        const client = (req as any)._pgClient;
        if (!client) return;

        try {
            await client.query("COMMIT");
        } finally {
            client.release();
        }
    });

    app.addHook("onError", async (req) => {
        const client = (req as any)._pgClient;
        if (!client) return;

        try {
            await client.query("ROLLBACK");
        } finally {
            client.release();
        }
    });
}

export const transactionPlugin = fp(transactionPluginCore, {
    name: 'transaction-plugin',
    dependencies: ['db-plugin']
});