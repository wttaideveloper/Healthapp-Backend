import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isWorkspaceAccessActive } from "../workspace/workspace.util";

import { selectPreferredWorkspaceAccess, type WorkspaceAccessCandidate } from "./entitlement.service";

function candidate(overrides: Partial<WorkspaceAccessCandidate>): WorkspaceAccessCandidate {
    return {
        workspaceId: "11111111-1111-1111-1111-111111111111",
        workspaceName: "Org",
        role: "owner",
        memberStatus: "active",
        plan: "organization",
        seatLimit: 4,
        workspaceStatus: "active",
        subscriptionStatus: "active",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
    };
}

describe("Entitlement workspace selection", () => {
    it("G. prefers an active workspace over a cancelled one", () => {
        const selected = selectPreferredWorkspaceAccess([
            candidate({
                workspaceId: "22222222-2222-2222-2222-222222222222",
                workspaceName: "Cancelled",
                subscriptionStatus: "canceled",
                updatedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
            candidate({
                workspaceId: "11111111-1111-1111-1111-111111111111",
                workspaceName: "Active",
                updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
        ]);

        assert.equal(selected?.workspaceId, "11111111-1111-1111-1111-111111111111");
        assert.equal(selected?.workspaceName, "Active");
    });

    it("H. prefers an active workspace over an expired one", () => {
        const selected = selectPreferredWorkspaceAccess([
            candidate({
                workspaceId: "22222222-2222-2222-2222-222222222222",
                workspaceName: "Expired",
                expiresAt: new Date("2020-01-01T00:00:00.000Z"),
                updatedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
            candidate({
                workspaceId: "11111111-1111-1111-1111-111111111111",
                workspaceName: "Active",
            }),
        ]);

        assert.equal(selected?.workspaceName, "Active");
    });

    it("I. returns null when no active workspace exists so individual access can apply", () => {
        const selected = selectPreferredWorkspaceAccess([
            candidate({
                subscriptionStatus: "canceled",
            }),
        ]);
        assert.equal(selected, null);
    });

    it("K. expired workspace does not grant access (hasAccess false)", () => {
        const expired = candidate({
            expiresAt: new Date("2020-01-01T00:00:00.000Z"),
            subscriptionStatus: "active",
            workspaceStatus: "active",
        });

        assert.equal(
            isWorkspaceAccessActive({
                workspaceStatus: expired.workspaceStatus,
                subscriptionStatus: expired.subscriptionStatus,
                expiresAt: expired.expiresAt,
            }),
            false
        );
        assert.equal(selectPreferredWorkspaceAccess([expired]), null);
    });

    it("is deterministic when multiple active workspaces exist", () => {
        const selected = selectPreferredWorkspaceAccess([
            candidate({
                workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                updatedAt: new Date("2026-02-01T00:00:00.000Z"),
            }),
            candidate({
                workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                updatedAt: new Date("2026-02-01T00:00:00.000Z"),
            }),
        ]);
        assert.equal(selected?.workspaceId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    });
});
