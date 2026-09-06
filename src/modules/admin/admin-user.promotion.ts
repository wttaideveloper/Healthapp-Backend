import { ConflictError, NotFoundError } from "@core/errors/http-errors";

/**
 * Promotion must not be used as a back door to reactivate a disabled account.
 * Reactivation is a separate, explicit flow and is not implemented here.
 */
export function assertUserEligibleForAdminPromotion<T extends { status: string }>(
    user: T | null
): asserts user is T {
    if (!user) {
        throw new NotFoundError("User not found for this email");
    }

    if (user.status === "disabled") {
        throw new ConflictError(
            "This account is disabled and cannot be promoted to admin. Disabled users must be reactivated through an explicit reactivation flow before their role can change."
        );
    }
}
