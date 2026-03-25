import { FastifyInstance } from "fastify";
import { AppError } from "@core/errors/app-error";

export async function errorHandlerPlugin(app: FastifyInstance) {
    app.setErrorHandler((error, req, reply) => {
        // Known, expected error
        if (error instanceof AppError) {
            req.log.warn(
                { err: error, code: error.code },
                error.message
            );

            return reply.status(error.statusCode).send({
                error: {
                    code: error.code,
                    message: error.message,
                    details: error.details ?? null,
                },
            });
        }

        // Unknown / programming error
        req.log.error({ err: error }, "Unhandled error");

        return reply.status(500).send({
            error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Something went wrong",
            },
        });
    });
}
