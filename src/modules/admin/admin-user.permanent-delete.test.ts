import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "@core/errors/http-errors";
import { assertAuthenticatedAccount } from "@core/auth/session";
import { AUDIT_ACTIONS, type AuditEventInput } from "@modules/audit/audit.service";
import {
    permanentlyDeleteUser,
    type LockedUserForPermanentDelete,
    type NamedWorkspace,
    type PermanentlyDeleteUserStore,
    type RevenuecatSnapshot,
    type StoreEntitlementSnapshot,
    type StripeSubscriptionSnapshot,
} from "@modules/admin/admin-user.permanent-delete";

const ACTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ADMIN_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";

type MemoryUser = LockedUserForPermanentDelete;
type MemoryMember = {
    id: string;
    workspaceId: string;
    userId: string | null;
    email: string;
    role: string;
    status: string;
};
type MemoryWorkspace = NamedWorkspace & { ownerUserId: string | null; ownerEmail: string; shopifyShopId?: string | null };

type MemoryDb = {
    users: MemoryUser[];
    workspaces: MemoryWorkspace[];
    members: MemoryMember[];
    stripeCustomers: Array<{ id: string; userId: string }>;
    stripeSubscriptions: Array<StripeSubscriptionSnapshot & { userId: string }>;
    revenuecat: Array<RevenuecatSnapshot & { userId: string }>;
    storeEntitlements: Array<StoreEntitlementSnapshot & { ownerUserId: string }>;
    emailVerifications: Array<{ id: string; userId: string }>;
    passwordResets: Array<{ id: string; userId: string }>;
    billingEvents: Array<{ id: string }>;
    audit: AuditEventInput[];
    failOn?: "audit" | "deleteUser";
};

function snapshot(db: MemoryDb): MemoryDb {
    return structuredClone({
        users: db.users,
        workspaces: db.workspaces,
        members: db.members,
        stripeCustomers: db.stripeCustomers,
        stripeSubscriptions: db.stripeSubscriptions,
        revenuecat: db.revenuecat,
        storeEntitlements: db.storeEntitlements,
        emailVerifications: db.emailVerifications,
        passwordResets: db.passwordResets,
        billingEvents: db.billingEvents,
        audit: db.audit,
    }) as MemoryDb;
}

function restore(db: MemoryDb, snap: MemoryDb): void {
    Object.assign(db, snap);
}

function createStore(db: MemoryDb): PermanentlyDeleteUserStore {
    const emailOf = (user: { id: string; email: string }) => user.email.trim().toLowerCase();
    const matchesUser = (member: MemoryMember, user: { id: string; email: string }) =>
        member.userId === user.id || member.email.toLowerCase() === emailOf(user);

    return {
        async lockUser(id) {
            return db.users.find((user) => user.id === id) ?? null;
        },
        async listOwnedWorkspaces(user) {
            const email = emailOf(user);
            return db.workspaces.filter(
                (workspace) => workspace.ownerUserId === user.id || workspace.ownerEmail.toLowerCase() === email
            );
        },
        async listOwnerMemberships(user) {
            return db.members
                .filter((member) => member.role === "owner" && matchesUser(member, user))
                .map((member) => {
                    const workspace = db.workspaces.find((row) => row.id === member.workspaceId);
                    return {
                        id: member.workspaceId,
                        name: workspace?.name ?? member.workspaceId,
                        billingSource: workspace?.billingSource ?? "manual",
                        status: workspace?.status ?? "active",
                    };
                });
        },
        async listMemberships(user) {
            return db.members
                .filter((member) => matchesUser(member, user))
                .map((member) => ({ id: member.id, workspaceId: member.workspaceId, role: member.role }));
        },
        async listStripeCustomers(userId) {
            return db.stripeCustomers.filter((row) => row.userId === userId);
        },
        async listStripeSubscriptions(userId) {
            return db.stripeSubscriptions.filter((row) => row.userId === userId);
        },
        async listRevenuecatSubscriptions(userId) {
            return db.revenuecat.filter((row) => row.userId === userId);
        },
        async listStoreEntitlements(userId) {
            return db.storeEntitlements.filter((row) => row.ownerUserId === userId);
        },
        async writeAudit(input) {
            if (db.failOn === "audit") throw new Error("audit write failed");
            db.audit.push(input);
        },
        async deleteEmailVerifications(userId) {
            const before = db.emailVerifications.length;
            db.emailVerifications = db.emailVerifications.filter((row) => row.userId !== userId);
            return before - db.emailVerifications.length;
        },
        async deletePasswordResets(userId) {
            const before = db.passwordResets.length;
            db.passwordResets = db.passwordResets.filter((row) => row.userId !== userId);
            return before - db.passwordResets.length;
        },
        async deleteUser(id) {
            if (db.failOn === "deleteUser") throw new Error("delete user failed");
            db.users = db.users.filter((user) => user.id !== id);
        },
    };
}

async function runInTransaction<T>(db: MemoryDb, fn: (store: PermanentlyDeleteUserStore) => Promise<T>): Promise<T> {
    const snap = snapshot(db);
    try {
        return await fn(createStore(db));
    } catch (error) {
        restore(db, snap);
        throw error;
    }
}

function dummyUser(overrides: Partial<MemoryUser> = {}): MemoryUser {
    return {
        id: USER_ID,
        name: "Pat Dummy",
        email: "pat@example.com",
        role: "user",
        status: "disabled",
        ...overrides,
    };
}

function actorAdmin(): MemoryUser {
    return { id: ACTOR_ID, name: "Admin", email: "admin@example.com", role: "admin", status: "active" };
}

function seed(overrides: Partial<MemoryDb> = {}): MemoryDb {
    return {
        users: [actorAdmin(), dummyUser(), { id: OTHER_ID, name: "Other", email: "other@example.com", role: "user", status: "active" }],
        workspaces: [
            {
                id: WS_B,
                name: "Other clinic",
                billingSource: "manual",
                status: "active",
                ownerUserId: OTHER_ID,
                ownerEmail: "other@example.com",
                shopifyShopId: null,
            },
        ],
        members: [
            {
                id: "m-other",
                workspaceId: WS_B,
                userId: OTHER_ID,
                email: "other@example.com",
                role: "owner",
                status: "active",
            },
        ],
        stripeCustomers: [],
        stripeSubscriptions: [],
        revenuecat: [],
        storeEntitlements: [],
        emailVerifications: [{ id: "ev-1", userId: USER_ID }],
        passwordResets: [{ id: "pr-1", userId: USER_ID }],
        billingEvents: [{ id: "evt-1" }],
        audit: [{ action: AUDIT_ACTIONS.USER_DEACTIVATED, target: { type: "user", id: USER_ID, label: "pat@example.com" } }],
        ...overrides,
    };
}

const actor = { id: ACTOR_ID, email: "admin@example.com", role: "admin" };

function deleteUser(db: MemoryDb, confirmation = "pat@example.com", targetUserId = USER_ID) {
    return runInTransaction(db, (store) =>
        permanentlyDeleteUser(store, { actorUserId: ACTOR_ID, actor, targetUserId, confirmation })
    );
}

describe("permanentlyDeleteUser", () => {
    it("deletes a disabled dummy user with no relationships and keeps auth artifacts cleaned", async () => {
        const db = seed();
        const result = await deleteUser(db);
        assert.equal(result.id, USER_ID);
        assert.equal(db.users.some((user) => user.id === USER_ID), false);
        assert.equal(db.users.some((user) => user.id === OTHER_ID), true);
        assert.equal(db.users.some((user) => user.id === ACTOR_ID), true);
        assert.equal(db.emailVerifications.length, 0);
        assert.equal(db.passwordResets.length, 0);
        assert.equal(db.workspaces.some((workspace) => workspace.id === WS_B), true);
        assert.equal(db.members.some((member) => member.id === "m-other"), true);
        assert.equal(db.billingEvents.length, 1);
    });

    it("keeps historical audit rows and writes user.permanently_deleted", async () => {
        const db = seed();
        await deleteUser(db);
        assert.equal(db.audit.some((row) => row.action === AUDIT_ACTIONS.USER_DEACTIVATED), true);
        const created = db.audit.find((row) => row.action === AUDIT_ACTIONS.USER_PERMANENTLY_DELETED);
        assert.ok(created);
        assert.equal(created.throwOnFailure, true);
        assert.equal(created.target?.id, USER_ID);
        assert.equal(created.actor?.id, ACTOR_ID);
        assert.equal(created.actor?.email, "admin@example.com");
        assert.equal(created.metadata?.deletionType, "permanent");
        assert.equal(created.metadata?.email, "pat@example.com");
        assert.equal(created.metadata?.confirmation, "pat@example.com");
        assert.notEqual(created.action, AUDIT_ACTIONS.USER_DEACTIVATED);
    });

    it("rejects self-delete with 409", async () => {
        const db = seed();
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteUser(store, {
                        actorUserId: USER_ID,
                        actor,
                        targetUserId: USER_ID,
                        confirmation: "pat@example.com",
                    })
                ),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.match(error.message, /your own account/i);
                return true;
            }
        );
        assert.equal(db.users.some((user) => user.id === USER_ID), true);
    });

    it("rejects any platform admin, including when another admin exists", async () => {
        const db = seed({
            users: [
                actorAdmin(),
                dummyUser({ id: ADMIN_B_ID, role: "admin", email: "admin-b@example.com", status: "disabled" }),
            ],
        });
        await assert.rejects(
            () => deleteUser(db, "admin-b@example.com", ADMIN_B_ID),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.match(error.message, /Platform administrator accounts cannot be permanently deleted/i);
                return true;
            }
        );
    });

    it("rejects the last remaining admin", async () => {
        const db = seed({ users: [actorAdmin()] });
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteUser(store, {
                        actorUserId: OTHER_ID,
                        actor,
                        targetUserId: ACTOR_ID,
                        confirmation: "admin@example.com",
                    })
                ),
            ConflictError
        );
        assert.equal(db.users.some((user) => user.id === ACTOR_ID), true);
    });

    it("rejects an active user until they are deactivated", async () => {
        const db = seed({ users: [actorAdmin(), dummyUser({ status: "active" })] });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /Deactivate the user before permanently deleting/i);
            return true;
        });
    });

    it("rejects a workspace owner, including revoked workspaces", async () => {
        const db = seed({
            workspaces: [
                {
                    id: WS_A,
                    name: "Clinic A",
                    billingSource: "manual",
                    status: "revoked",
                    ownerUserId: USER_ID,
                    ownerEmail: "pat@example.com",
                    shopifyShopId: null,
                },
                seed().workspaces[0]!,
            ],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /still owns a workspace/i);
            assert.match(error.message, /Clinic A/);
            return true;
        });
        assert.equal(db.users.some((user) => user.id === USER_ID), true);
    });

    it("rejects an owner-role membership even when listed owner is someone else", async () => {
        const db = seed({
            members: [
                ...seed().members,
                {
                    id: "m-pat-owner",
                    workspaceId: WS_B,
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "owner",
                    status: "revoked",
                },
            ],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /still owns a workspace/i);
            return true;
        });
    });

    it("rejects any remaining membership, including multiple workspaces", async () => {
        const db = seed({
            members: [
                ...seed().members,
                {
                    id: "m-pat-a",
                    workspaceId: WS_A,
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "member",
                    status: "revoked",
                },
                {
                    id: "m-pat-b",
                    workspaceId: WS_B,
                    userId: null,
                    email: "pat@example.com",
                    role: "member",
                    status: "invited",
                },
            ],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /still belongs to one or more workspaces/i);
            return true;
        });
        assert.equal(db.members.filter((member) => member.email === "pat@example.com").length, 2);
    });

    it("rejects an active Stripe subscription", async () => {
        const db = seed({
            stripeSubscriptions: [{ userId: USER_ID, status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) }],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /active Stripe subscription/i);
            return true;
        });
    });

    it("rejects a Stripe customer mapping even without an active subscription", async () => {
        const db = seed({ stripeCustomers: [{ id: "cus-row", userId: USER_ID }] });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /unsafe billing relationship/i);
            return true;
        });
    });

    it("rejects an active RevenueCat subscription", async () => {
        const db = seed({ revenuecat: [{ userId: USER_ID, isActive: true, expiresAt: null }] });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /active RevenueCat subscription/i);
            return true;
        });
    });

    it("rejects an active IAP entitlement", async () => {
        const db = seed({
            storeEntitlements: [{ ownerUserId: USER_ID, isActive: true, expiresAt: null, status: "active" }],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /active IAP entitlement/i);
            return true;
        });
    });

    it("rejects a Shopify-owned workspace relationship", async () => {
        const db = seed({
            workspaces: [
                {
                    id: WS_A,
                    name: "Shopify clinic",
                    billingSource: "shopify",
                    status: "active",
                    ownerUserId: USER_ID,
                    ownerEmail: "pat@example.com",
                    shopifyShopId: "shop-1",
                },
                seed().workspaces[0]!,
            ],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /Shopify business relationship/i);
            return true;
        });
    });

    it("accepts confirmation with different casing and surrounding whitespace", async () => {
        const db = seed();
        await deleteUser(db, "  Pat@Example.com  ");
        assert.equal(db.users.some((user) => user.id === USER_ID), false);
    });

    it("rejects leftover Stripe subscriptions even when they are no longer active", async () => {
        const db = seed({
            stripeSubscriptions: [{ userId: USER_ID, status: "canceled", currentPeriodEnd: new Date("2020-01-01") }],
        });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /unsafe billing relationship/i);
            return true;
        });
    });

    it("rejects leftover RevenueCat rows even when they are no longer active", async () => {
        const db = seed({ revenuecat: [{ userId: USER_ID, isActive: false, expiresAt: new Date("2020-01-01") }] });
        await assert.rejects(() => deleteUser(db), (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.match(error.message, /unsafe billing relationship/i);
            return true;
        });
    });

    it("allows an inactive IAP entitlement that will be detached rather than cascade-deleted", async () => {
        const db = seed({
            storeEntitlements: [{ ownerUserId: USER_ID, isActive: false, expiresAt: new Date("2020-01-01"), status: "expired" }],
        });
        await deleteUser(db);
        assert.equal(db.users.some((user) => user.id === USER_ID), false);
        assert.equal(db.storeEntitlements.length, 1);
    });

    it("rejects incorrect confirmation with 400", async () => {
        const db = seed();
        await assert.rejects(() => deleteUser(db, "wrong@example.com"), BadRequestError);
        assert.equal(db.users.some((user) => user.id === USER_ID), true);
        assert.equal(db.audit.length, 1);
    });

    it("returns 404 when the user is missing", async () => {
        const db = seed({ users: [actorAdmin()] });
        await assert.rejects(() => deleteUser(db), NotFoundError);
    });

    it("rolls back when the audit write fails", async () => {
        const db = seed({ failOn: "audit" });
        await assert.rejects(() => deleteUser(db), /audit write failed/);
        assert.equal(db.users.some((user) => user.id === USER_ID), true);
        assert.equal(db.emailVerifications.length, 1);
        assert.equal(db.audit.length, 1);
    });

    it("rolls back when user deletion fails after the audit write", async () => {
        const db = seed({ failOn: "deleteUser" });
        await assert.rejects(() => deleteUser(db), /delete user failed/);
        assert.equal(db.users.some((user) => user.id === USER_ID), true);
        assert.equal(db.audit.length, 1);
    });

    it("makes an existing JWT fail authentication after the user row is gone", async () => {
        const db = seed();
        await deleteUser(db);
        assert.throws(() => assertAuthenticatedAccount(null), UnauthorizedError);
    });

    it("frees the email so a new account cannot inherit a workspace", async () => {
        const db = seed();
        await deleteUser(db);
        assert.equal(db.users.some((user) => user.email === "pat@example.com"), false);

        const invitedSeat = db.members.some(
            (member) =>
                member.email === "pat@example.com" && member.userId === null && member.status === "invited"
        );
        const unclaimedOwner = db.workspaces.some(
            (workspace) => workspace.ownerEmail === "pat@example.com" && workspace.ownerUserId === null
        );
        assert.equal(invitedSeat || unclaimedOwner, false);
        assert.equal(
            db.members.some((member) => member.userId === USER_ID || member.email === "pat@example.com"),
            false
        );
    });
});
