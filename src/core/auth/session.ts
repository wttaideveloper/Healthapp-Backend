import { UnauthorizedError } from "@core/errors/http-errors";

/**
 * Account statuses that may receive a new session or continue using an
 * existing JWT. `pending` cannot sign in (login already requires `active`).
 * `disabled` is a platform-admin deactivation: the row is kept, but the
 * account must not authenticate.
 */
export function isUserAllowedToAuthenticate(status: string): boolean {
    return status === "active";
}

/**
 * Rejects a verified JWT whose subject is missing or has been deactivated.
 *
 * Disabled accounts must not keep using an unexpired token. Call this from
 * `authenticate` so every protected route is covered — not only login.
 */
export function assertAuthenticatedAccount(user: { status: string } | null): void {
    if (!user) {
        throw new UnauthorizedError("Authenticated user not found");
    }

    if (user.status === "disabled") {
        throw new UnauthorizedError("This account has been deactivated");
    }
}
