import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BadRequestError, ConflictError, NotFoundError } from "@core/errors/http-errors";
import { AUDIT_ACTIONS, type AuditEventInput } from "@modules/audit/audit.service";
import {
    isShopifyManagedBillingSource,
    permanentlyDeleteWorkspace,
    workspaceConfirmationMatches,
    type LockedWorkspaceForPermanentDelete,
    type PermanentlyDeleteWorkspaceStore,
} from "@modules/admin/admin-workspace.permanent-delete";

const ACTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEMBER_USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_USER_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";
const MEMBER_A = "33333333-3333-3333-3333-333333333333";
const MEMBER_B = "44444444-4444-4444-4444-444444444444";
const OTHER_MEMBER = "55555555-5555-5555-5555-555555555555";

type MemoryUser = { id: string; email: string };
type MemoryMember = {
    id: string;
    workspaceId: string;
    userId: string | null;
    email: string;
    role: string;
    status: string;
};
type MemoryWorkspace = LockedWorkspaceForPermanentDelete;
type MemoryShopifyOrder = { id: string; workspaceId: string | null };
type MemoryShopifySubscription = { id: string; workspaceId: string | null };
type MemoryShopifyShop = { id: string };
type MemoryBillingEvent = { id: string; provider: string };
type MemoryStripe = { userId: string; status: string };
type MemoryIap = { ownerUserId: string; isActive: boolean };
type MemoryRc = { userId: string; isActive: boolean };

type MemoryDb = {
    users: MemoryUser[];
    workspaces: MemoryWorkspace[];
    members: MemoryMember[];
    shopifyOrders: MemoryShopifyOrder[];
    shopifySubscriptions: MemoryShopifySubscription[];
    shopifyShops: MemoryShopifyShop[];
    billingEvents: MemoryBillingEvent[];
    stripeRows: MemoryStripe[];
    iapRows: MemoryIap[];
    revenuecatRows: MemoryRc[];
    audit: AuditEventInput[];
    failOn?: "audit" | "deleteMembers" | "deleteWorkspace";
};

function snapshot(db: MemoryDb): MemoryDb {
    return structuredClone({
        users: db.users,
        workspaces: db.workspaces,
        members: db.members,
        shopifyOrders: db.shopifyOrders,
        shopifySubscriptions: db.shopifySubscriptions,
        shopifyShops: db.shopifyShops,
        billingEvents: db.billingEvents,
        stripeRows: db.stripeRows,
        iapRows: db.iapRows,
        revenuecatRows: db.revenuecatRows,
        audit: db.audit,
    }) as MemoryDb;
}

function restore(db: MemoryDb, snap: MemoryDb): void {
    db.users = snap.users;
    db.workspaces = snap.workspaces;
    db.members = snap.members;
    db.shopifyOrders = snap.shopifyOrders;
    db.shopifySubscriptions = snap.shopifySubscriptions;
    db.shopifyShops = snap.shopifyShops;
    db.billingEvents = snap.billingEvents;
    db.stripeRows = snap.stripeRows;
    db.iapRows = snap.iapRows;
    db.revenuecatRows = snap.revenuecatRows;
    db.audit = snap.audit;
}

function createStore(db: MemoryDb): PermanentlyDeleteWorkspaceStore {
    return {
        async lockWorkspace(id) {
            return db.workspaces.find((workspace) => workspace.id === id) ?? null;
        },
        async countMembers(workspaceId) {
            return db.members.filter((member) => member.workspaceId === workspaceId).length;
        },
        async countShopifyOrders(workspaceId) {
            return db.shopifyOrders.filter((order) => order.workspaceId === workspaceId).length;
        },
        async countShopifySubscriptions(workspaceId) {
            return db.shopifySubscriptions.filter((row) => row.workspaceId === workspaceId).length;
        },
        async writeAudit(input) {
            if (db.failOn === "audit") throw new Error("audit write failed");
            db.audit.push(input);
        },
        async deleteMembers(workspaceId) {
            if (db.failOn === "deleteMembers") throw new Error("delete members failed");
            const before = db.members.length;
            db.members = db.members.filter((member) => member.workspaceId !== workspaceId);
            return before - db.members.length;
        },
        async deleteWorkspace(id) {
            if (db.failOn === "deleteWorkspace") throw new Error("delete workspace failed");
            db.workspaces = db.workspaces.filter((workspace) => workspace.id !== id);
        },
    };
}

async function runInTransaction<T>(
    db: MemoryDb,
    fn: (store: PermanentlyDeleteWorkspaceStore) => Promise<T>
): Promise<T> {
    const snap = snapshot(db);
    try {
        return await fn(createStore(db));
    } catch (error) {
        restore(db, snap);
        throw error;
    }
}

function manualWorkspace(overrides: Partial<MemoryWorkspace> = {}): MemoryWorkspace {
    return {
        id: WS_A,
        name: "Test workspace",
        ownerUserId: OWNER_USER_ID,
        ownerEmail: "owner@example.com",
        status: "active",
        subscriptionStatus: "active",
        billingSource: "manual",
        seatLimit: 10,
        shopifyShopId: null,
        ...overrides,
    };
}

function seed(overrides: Partial<MemoryDb> = {}): MemoryDb {
    return {
        users: [
            { id: OWNER_USER_ID, email: "owner@example.com" },
            { id: MEMBER_USER_ID, email: "pat@example.com" },
            { id: OTHER_USER_ID, email: "other@example.com" },
        ],
        workspaces: [
            manualWorkspace(),
            manualWorkspace({
                id: WS_B,
                name: "Other clinic",
                ownerUserId: OTHER_USER_ID,
                ownerEmail: "other@example.com",
            }),
        ],
        members: [
            {
                id: MEMBER_A,
                workspaceId: WS_A,
                userId: OWNER_USER_ID,
                email: "owner@example.com",
                role: "owner",
                status: "active",
            },
            {
                id: MEMBER_B,
                workspaceId: WS_A,
                userId: MEMBER_USER_ID,
                email: "pat@example.com",
                role: "member",
                status: "active",
            },
            {
                id: OTHER_MEMBER,
                workspaceId: WS_B,
                userId: OTHER_USER_ID,
                email: "other@example.com",
                role: "owner",
                status: "active",
            },
        ],
        shopifyOrders: [],
        shopifySubscriptions: [],
        shopifyShops: [{ id: "shop-1" }],
        billingEvents: [{ id: "evt-1", provider: "stripe" }],
        stripeRows: [{ userId: MEMBER_USER_ID, status: "active" }],
        iapRows: [{ ownerUserId: MEMBER_USER_ID, isActive: true }],
        revenuecatRows: [{ userId: MEMBER_USER_ID, isActive: true }],
        audit: [
            {
                action: AUDIT_ACTIONS.WORKSPACE_CREATED,
                target: { type: "workspace", id: WS_A, label: "Test workspace" },
            },
        ],
        ...overrides,
    };
}

const actor = { id: ACTOR_ID, email: "admin@example.com", role: "admin" };

function deleteWs(db: MemoryDb, confirmation = "Test workspace", workspaceId = WS_A) {
    return runInTransaction(db, (store) =>
        permanentlyDeleteWorkspace(store, { actor, workspaceId, confirmation })
    );
}

describe("workspaceConfirmationMatches", () => {
    it("trims but does not fold case", () => {
        assert.equal(workspaceConfirmationMatches("  Test workspace  ", "Test workspace"), true);
        assert.equal(workspaceConfirmationMatches("test workspace", "Test workspace"), false);
        assert.equal(workspaceConfirmationMatches("Wrong", "Test workspace"), false);
    });
});

describe("isShopifyManagedBillingSource", () => {
    it("detects shopify billing regardless of surrounding case", () => {
        assert.equal(isShopifyManagedBillingSource("shopify"), true);
        assert.equal(isShopifyManagedBillingSource("Shopify"), true);
        assert.equal(isShopifyManagedBillingSource("manual"), false);
    });
});

describe("permanentlyDeleteWorkspace", () => {
    it("deletes a manual dummy workspace and its members, leaving users and other workspaces", async () => {
        const db = seed();
        const result = await deleteWs(db);

        assert.equal(result.id, WS_A);
        assert.equal(result.deletedMemberCount, 2);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), false);
        assert.equal(db.members.some((member) => member.workspaceId === WS_A), false);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_B), true);
        assert.equal(db.members.some((member) => member.id === OTHER_MEMBER), true);
        assert.equal(db.users.length, 3);
        assert.equal(db.users.some((user) => user.id === OWNER_USER_ID), true);
        assert.equal(db.users.some((user) => user.id === MEMBER_USER_ID), true);
    });

    it("keeps historical audit rows and writes workspace.permanently_deleted", async () => {
        const db = seed();
        await deleteWs(db);

        assert.equal(db.audit.some((row) => row.action === AUDIT_ACTIONS.WORKSPACE_CREATED), true);
        const created = db.audit.find((row) => row.action === AUDIT_ACTIONS.WORKSPACE_PERMANENTLY_DELETED);
        assert.ok(created);
        assert.equal(created.throwOnFailure, true);
        assert.equal(created.target?.id, WS_A);
        assert.equal((created.metadata as { deletionType?: string }).deletionType, "permanent");
        assert.equal((created.metadata as { memberCount?: number }).memberCount, 2);
        assert.notEqual(created.action, AUDIT_ACTIONS.WORKSPACE_REVOKED);
    });

    it("does not delete billing events, Shopify shops, Stripe, IAP, or RevenueCat rows", async () => {
        const db = seed();
        await deleteWs(db);

        assert.equal(db.billingEvents.length, 1);
        assert.equal(db.shopifyShops.length, 1);
        assert.equal(db.stripeRows.length, 1);
        assert.equal(db.iapRows.length, 1);
        assert.equal(db.revenuecatRows.length, 1);
        assert.equal(db.shopifyOrders.length, 0);
        assert.equal(db.shopifySubscriptions.length, 0);
    });

    it("rejects a Shopify-managed workspace with 409 and does not mutate data", async () => {
        const db = seed({
            workspaces: [manualWorkspace({ billingSource: "shopify" }), seed().workspaces[1]!],
        });
        await assert.rejects(() => deleteWs(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /Shopify-managed workspaces cannot be permanently deleted/i);
            return true;
        });
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
        assert.equal(db.members.filter((member) => member.workspaceId === WS_A).length, 2);
        assert.equal(db.audit.length, 1);
    });

    it("rejects a workspace linked to a Shopify shop with 409", async () => {
        const db = seed({
            workspaces: [manualWorkspace({ shopifyShopId: "shop-1" }), seed().workspaces[1]!],
        });
        await assert.rejects(() => deleteWs(db), ConflictError);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
    });

    it("rejects a workspace with Shopify orders with 409 and leaves orders in place", async () => {
        const db = seed({
            shopifyOrders: [{ id: "ord-1", workspaceId: WS_A }],
        });
        await assert.rejects(() => deleteWs(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /Shopify orders/i);
            return true;
        });
        assert.equal(db.shopifyOrders.length, 1);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
    });

    it("rejects a workspace with Shopify subscriptions with 409 and leaves subscriptions in place", async () => {
        const db = seed({
            shopifySubscriptions: [{ id: "sub-1", workspaceId: WS_A }],
        });
        await assert.rejects(() => deleteWs(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /Shopify subscriptions/i);
            return true;
        });
        assert.equal(db.shopifySubscriptions.length, 1);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
    });

    it("rejects incorrect confirmation with 400", async () => {
        const db = seed();
        await assert.rejects(() => deleteWs(db, "wrong name"), (error: unknown) => {
            assert.ok(error instanceof BadRequestError);
            assert.match(error.message, /confirmation/i);
            return true;
        });
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
        assert.equal(db.audit.length, 1);
    });

    it("rejects case-folded confirmation that does not match the stored name", async () => {
        const db = seed();
        await assert.rejects(() => deleteWs(db, "test workspace"), BadRequestError);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
    });

    it("returns 404 when the workspace is missing", async () => {
        const db = seed({ workspaces: [seed().workspaces[1]!] });
        await assert.rejects(() => deleteWs(db), NotFoundError);
    });

    it("treats a second delete of the same workspace as 404", async () => {
        const db = seed();
        await deleteWs(db);
        await assert.rejects(() => deleteWs(db), NotFoundError);
    });

    it("rolls back when the audit write fails", async () => {
        const db = seed({ failOn: "audit" });
        await assert.rejects(() => deleteWs(db), /audit write failed/);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
        assert.equal(db.members.filter((member) => member.workspaceId === WS_A).length, 2);
        assert.equal(db.audit.length, 1);
    });

    it("rolls back when member deletion fails after the audit write", async () => {
        const db = seed({ failOn: "deleteMembers" });
        await assert.rejects(() => deleteWs(db), /delete members failed/);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
        assert.equal(db.members.filter((member) => member.workspaceId === WS_A).length, 2);
        assert.equal(db.audit.length, 1);
    });

    it("rolls back when workspace deletion fails after members would have been removed", async () => {
        const db = seed({ failOn: "deleteWorkspace" });
        await assert.rejects(() => deleteWs(db), /delete workspace failed/);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), true);
        assert.equal(db.members.filter((member) => member.workspaceId === WS_A).length, 2);
        assert.equal(db.audit.length, 1);
    });

    it("can delete an already-revoked manual workspace and does not convert revoke into a no-op", async () => {
        const db = seed({
            workspaces: [manualWorkspace({ status: "revoked" }), seed().workspaces[1]!],
        });
        await deleteWs(db);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_A), false);
    });
});
