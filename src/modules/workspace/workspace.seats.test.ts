import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasAvailableWorkspaceSeat } from "./workspace.seats";

describe("Workspace seat assignment", () => {
    it("M. cannot assign more members than available licenses", () => {
        assert.equal(hasAvailableWorkspaceSeat(3, 4), true);
        assert.equal(hasAvailableWorkspaceSeat(4, 4), false);
        assert.equal(hasAvailableWorkspaceSeat(5, 4), false);
        assert.equal(hasAvailableWorkspaceSeat(0, 1), true);
    });

    it("F. new invitations remain blocked when no seats remain after refund overflow", () => {
        assert.equal(hasAvailableWorkspaceSeat(4, 0), false);
        assert.equal(hasAvailableWorkspaceSeat(4, 4), false);
        assert.equal(hasAvailableWorkspaceSeat(3, 5), true);
    });
});
