import { AppError } from "./app-error";

export class BadRequestError extends AppError {
    constructor(message = "Bad request", details?: unknown) {
        super({
            statusCode: 400,
            code: "BAD_REQUEST",
            message,
            details,
        });
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = "Unauthorized") {
        super({
            statusCode: 401,
            code: "UNAUTHORIZED",
            message,
        });
    }
}

export class ForbiddenError extends AppError {
    constructor(message = "Forbidden") {
        super({
            statusCode: 403,
            code: "FORBIDDEN",
            message,
        });
    }
}

export class NotFoundError extends AppError {
    constructor(message = "Not found") {
        super({
            statusCode: 404,
            code: "NOT_FOUND",
            message,
        });
    }
}

export class ConflictError extends AppError {
    constructor(message = "Conflict", details?: unknown) {
        super({
            statusCode: 409,
            code: "CONFLICT",
            message,
            details,
        });
    }
}

export class EntitlementOwnedByAnotherUserError extends AppError {
    constructor(message = "This store subscription is already linked to another account.") {
        super({
            statusCode: 409,
            code: "ENTITLEMENT_OWNED_BY_ANOTHER_USER",
            message,
        });
    }
}
