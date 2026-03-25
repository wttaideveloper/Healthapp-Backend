export type AppErrorOptions = {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
    isOperational?: boolean;
};

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly details?: unknown;
    public readonly isOperational: boolean;

    constructor({
        statusCode,
        code,
        message,
        details,
        isOperational = true,
    }: AppErrorOptions) {
        super(message);

        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.isOperational = isOperational;

        // Important for stack traces
        Error.captureStackTrace(this, this.constructor);
    }
}
