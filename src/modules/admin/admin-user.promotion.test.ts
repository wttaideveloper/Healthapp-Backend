import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConflictError, NotFoundError } from "@core/errors/http-errors";
import { assertUserEligibleForAdminPromotion } from "@modules/admin/admin-user.promotion";

describe("assertUserEligibleForAdminPromotion", () => {
    it("rejects a missing user with 404 and does not imply a write", () => {
        assert.throws(() => assertUserEligibleForAdminPromotion(null), (error: unknown) => {
            assert.ok(error instanceof NotFoundError);
            assert.equal(error.statusCode, 404);
            return true;
        });
    });

    it("rejects a disabled user with 409 and leaves role/status unchanged", () => {
        const user = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "pat@example.com", role: "user", status: "disabled" };

        assert.throws(() => assertUserEligibleForAdminPromotion(user), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.equal(error.statusCode, 409);
            assert.match(error.message, /disabled/i);
            assert.match(error.message, /reactivat/i);
            return true;
        });

        assert.equal(user.status, "disabled");
        assert.equal(user.role, "user");
    });

    it("allows promotion of an active non-admin user", () => {
        assert.doesNotThrow(() =>
            assertUserEligibleForAdminPromotion({
                id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                email: "pat@example.com",
                role: "user",
                status: "active",
            })
        );
    });

    it("allows promotion of a pending user", () => {
        assert.doesNotThrow(() =>
            assertUserEligibleForAdminPromotion({
                id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                email: "pat@example.com",
                role: "user",
                status: "pending",
            })
        );
    });
});
