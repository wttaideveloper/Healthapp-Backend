import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { AppError } from "@core/errors/app-error";

/** Used when a framework error carries a status but no machine-readable code. */
const fallbackCodeByStatus: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    415: "UNSUPPORTED_MEDIA_TYPE",
    429: "RATE_LIMIT_EXCEEDED",
};

async function errorHandlerPluginCore(app: FastifyInstance) {
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

        // Framework-generated client errors: schema validation (400), rate limit
        // (429), unsupported media type (415), and similar. These already carry a
        // correct status and a safe message, so preserve them rather than
        // collapsing everything into a 500.
        const fastifyError = error as {
            statusCode?: unknown;
            code?: unknown;
            message?: unknown;
            validation?: unknown;
        };
        const statusCode =
            typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : null;

        if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
            const code =
                typeof fastifyError.code === "string"
                    ? fastifyError.code
                    : (fallbackCodeByStatus[statusCode] ?? "BAD_REQUEST");
            const message =
                typeof fastifyError.message === "string" ? fastifyError.message : "Bad request";

            req.log.warn({ err: error, code }, message);

            return reply.status(statusCode).send({
                error: {
                    code,
                    message,
                    details: fastifyError.validation ?? null,
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

/**
 * Wrapped with fastify-plugin so `setErrorHandler` applies to the root context.
 * Registered without it, the handler was scoped to its own (route-less) child
 * context and never ran.
 */
export const errorHandlerPlugin = fp(errorHandlerPluginCore, {
    name: "error-handler-plugin",
});
