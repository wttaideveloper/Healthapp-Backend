import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConflictError, NotFoundError, UnauthorizedError } from "@core/errors/http-errors";
import { assertAuthenticatedAccount, isUserAllowedToAuthenticate } from "@core/auth/session";
import {
    AUDIT_ACTIONS,
    type AuditEventInput,
} from "@modules/audit/audit.service";
import {
    deactivateUser,
    isSoleOwnerOfActiveWorkspace,
    type DeactivateLockedUser,
    type DeactivateUserStore,
    type RevokedMembershipAudit,
} from "@modules/admin/admin-user.deactivate";

const ACTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_MEMBER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ADMIN_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";

type MemoryUser = DeactivateLockedUser;
type MemoryMember = {
    id: string;
    workspaceId: string;
    workspaceName: string;
    userId: string | null;
    email: string;
    role: string;
    status: string;
};
type MemoryWorkspace = {
    id: string;
    name: string;
    status: string;
    ownerUserId: string | null;
    ownerEmail: string;
};

type MemoryDb = {
    users: MemoryUser[];
    members: MemoryMember[];
    workspaces: MemoryWorkspace[];
    stripeRows: Array<{ userId: string; status: string }>;
    iapRows: Array<{ ownerUserId: string; status: string }>;
    revenuecatRows: Array<{ userId: string; isActive: boolean }>;
    audit: AuditEventInput[];
    failOn?: "audit" | "disable" | "revoke";
};

function snapshot(db: MemoryDb): MemoryDb {
    return structuredClone({
        users: db.users,
        members: db.members,
        workspaces: db.workspaces,
        stripeRows: db.stripeRows,
        iapRows: db.iapRows,
        revenuecatRows: db.revenuecatRows,
        audit: db.audit,
    }) as MemoryDb;
}

function restore(db: MemoryDb, snap: MemoryDb): void {
    db.users = snap.users;
    db.members = snap.members;
    db.workspaces = snap.workspaces;
    db.stripeRows = snap.stripeRows;
    db.iapRows = snap.iapRows;
    db.revenuecatRows = snap.revenuecatRows;
    db.audit = snap.audit;
}

function createStore(db: MemoryDb): DeactivateUserStore {
    return {
        async lockUser(id) {
            return db.users.find((user) => user.id === id) ?? null;
        },
        async countActiveAdmins() {
            return db.users.filter((user) => user.role === "admin" && user.status === "active").length;
        },
        async findSoleOwnedActiveWorkspaces(user) {
            return db.workspaces
                .filter((workspace) => workspace.status === "active")
                .filter((workspace) =>
                    isSoleOwnerOfActiveWorkspace({
                        userId: user.id,
                        email: user.email,
                        workspace,
                        ownerMembers: db.members
                            .filter((member) => member.workspaceId === workspace.id && member.role === "owner" && member.status !== "revoked")
                            .map((member) => ({ userId: member.userId, email: member.email })),
                    })
                )
                .map((workspace) => ({ id: workspace.id, name: workspace.name }));
        },
        async listRevocableMemberships(user) {
            const email = user.email.trim().toLowerCase();
            return db.members
                .filter(
                    (member) =>
                        member.status !== "revoked" && (member.userId === user.id || member.email.toLowerCase() === email)
                )
                .map(
                    (member): RevokedMembershipAudit => ({
                        memberId: member.id,
                        workspaceId: member.workspaceId,
                        workspaceName: member.workspaceName,
                        role: member.role,
                        previousStatus: member.status,
                    })
                );
        },
        async writeAudit(input) {
            if (db.failOn === "audit") throw new Error("audit write failed");
            db.audit.push(input);
        },
        async setUserDisabled(id, _now) {
            if (db.failOn === "disable") throw new Error("disable failed");
            const user = db.users.find((row) => row.id === id);
            if (user) user.status = "disabled";
        },
        async revokeUserMemberships(user, _now) {
            if (db.failOn === "revoke") throw new Error("revoke failed");
            const email = user.email.trim().toLowerCase();
            for (const member of db.members) {
                if (member.status === "revoked") continue;
                if (member.userId === user.id || member.email.toLowerCase() === email) {
                    member.status = "revoked";
                }
            }
        },
    };
}

async function runInTransaction<T>(db: MemoryDb, fn: (store: DeactivateUserStore) => Promise<T>): Promise<T> {
    const snap = snapshot(db);
    try {
        return await fn(createStore(db));
    } catch (error) {
        restore(db, snap);
        throw error;
    }
}

function normalUser(overrides: Partial<MemoryUser> = {}): MemoryUser {
    return {
        id: USER_ID,
        name: "Pat Member",
        email: "pat@example.com",
        role: "user",
        status: "active",
        ...overrides,
    };
}

function actorAdmin(): MemoryUser {
    return {
        id: ACTOR_ID,
        name: "Platform Admin",
        email: "admin@example.com",
        role: "admin",
        status: "active",
    };
}

describe("isUserAllowedToAuthenticate / JWT after deactivation", () => {
    it("2. disabled users cannot log in", () => {
        assert.equal(isUserAllowedToAuthenticate("active"), true);
        assert.equal(isUserAllowedToAuthenticate("disabled"), false);
        assert.equal(isUserAllowedToAuthenticate("pending"), false);
    });

    it("3. an existing JWT is rejected once the account is disabled", () => {
        assert.doesNotThrow(() => assertAuthenticatedAccount({ status: "active" }));
        assert.throws(() => assertAuthenticatedAccount(null), UnauthorizedError);
        assert.throws(() => assertAuthenticatedAccount({ status: "disabled" }), (error: unknown) => {
            assert.ok(error instanceof UnauthorizedError);
            assert.equal(error.statusCode, 401);
            assert.match(error.message, /deactivated/i);
            return true;
        });
    });
});

describe("deactivateUser", () => {
    it("1. admin can deactivate a normal user", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            members: [],
            workspaces: [],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        const result = await runInTransaction(db, (store) =>
            deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID, email: "admin@example.com", role: "admin" }, targetUserId: USER_ID })
        );

        assert.equal(result.status, "disabled");
        assert.equal(db.users.find((user) => user.id === USER_ID)?.status, "disabled");
        assert.equal(db.users.find((user) => user.id === ACTOR_ID)?.status, "active");
        assert.equal(result.alreadyDisabled, false);
    });

    it("4/5/6. revokes this user's memberships in every workspace and leaves others unchanged", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            workspaces: [
                { id: WS_A, name: "Clinic A", status: "active", ownerUserId: ACTOR_ID, ownerEmail: "admin@example.com" },
                { id: WS_B, name: "Clinic B", status: "active", ownerUserId: ACTOR_ID, ownerEmail: "admin@example.com" },
            ],
            members: [
                {
                    id: "m-pat-a",
                    workspaceId: WS_A,
                    workspaceName: "Clinic A",
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "member",
                    status: "active",
                },
                {
                    id: "m-pat-b",
                    workspaceId: WS_B,
                    workspaceName: "Clinic B",
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "admin",
                    status: "active",
                },
                {
                    id: "m-other-a",
                    workspaceId: WS_A,
                    workspaceName: "Clinic A",
                    userId: OTHER_MEMBER_ID,
                    email: "other@example.com",
                    role: "member",
                    status: "active",
                },
                {
                    id: "m-owner-a",
                    workspaceId: WS_A,
                    workspaceName: "Clinic A",
                    userId: ACTOR_ID,
                    email: "admin@example.com",
                    role: "owner",
                    status: "active",
                },
            ],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        await runInTransaction(db, (store) =>
            deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
        );

        assert.equal(db.members.find((member) => member.id === "m-pat-a")?.status, "revoked");
        assert.equal(db.members.find((member) => member.id === "m-pat-b")?.status, "revoked");
        assert.equal(db.members.find((member) => member.id === "m-other-a")?.status, "active");
        assert.equal(db.members.find((member) => member.id === "m-owner-a")?.status, "active");
        assert.equal(db.workspaces.find((workspace) => workspace.id === WS_A)?.status, "active");
        assert.equal(db.workspaces.find((workspace) => workspace.id === WS_B)?.status, "active");
        assert.equal(db.workspaces.length, 2);
    });

    it("7/8. keeps Stripe and IAP/RevenueCat rows for the deactivated user", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            members: [],
            workspaces: [],
            stripeRows: [{ userId: USER_ID, status: "active" }],
            iapRows: [{ ownerUserId: USER_ID, status: "active" }],
            revenuecatRows: [{ userId: USER_ID, isActive: true }],
            audit: [],
        };

        await runInTransaction(db, (store) =>
            deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
        );

        assert.equal(db.users.find((user) => user.id === USER_ID)?.status, "disabled");
        assert.deepEqual(db.stripeRows, [{ userId: USER_ID, status: "active" }]);
        assert.deepEqual(db.iapRows, [{ ownerUserId: USER_ID, status: "active" }]);
        assert.deepEqual(db.revenuecatRows, [{ userId: USER_ID, isActive: true }]);
    });

    it("9. last remaining active platform admin cannot be deactivated", async () => {
        const db: MemoryDb = {
            users: [
                actorAdmin(),
                { id: ADMIN_B_ID, name: "Other Admin", email: "other-admin@example.com", role: "admin", status: "active" },
            ],
            members: [],
            workspaces: [],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };
        // Pretend a concurrent deactivate already removed the actor from the active-admin count.
        const store = createStore(db);
        store.countActiveAdmins = async () => 1;

        await assert.rejects(
            () => deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: ADMIN_B_ID }),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.equal(error.statusCode, 409);
                assert.match(error.message, /last remaining active platform admin/i);
                return true;
            }
        );
        assert.equal(db.users.find((user) => user.id === ADMIN_B_ID)?.status, "active");
    });

    it("10. current admin cannot deactivate themselves", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), { id: ADMIN_B_ID, name: "Other Admin", email: "b@example.com", role: "admin", status: "active" }],
            members: [],
            workspaces: [],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: ACTOR_ID })
                ),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.equal(error.statusCode, 409);
                assert.match(error.message, /your own account/i);
                return true;
            }
        );
        assert.equal(db.users.find((user) => user.id === ACTOR_ID)?.status, "active");
        assert.equal(db.audit.length, 0);
    });

    it("11. sole owner of an active workspace cannot be deactivated", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser({ role: "user" })],
            workspaces: [
                { id: WS_A, name: "Pat Clinic", status: "active", ownerUserId: USER_ID, ownerEmail: "pat@example.com" },
            ],
            members: [
                {
                    id: "m-owner",
                    workspaceId: WS_A,
                    workspaceName: "Pat Clinic",
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "owner",
                    status: "active",
                },
            ],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
                ),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.equal(error.statusCode, 409);
                assert.match(error.message, /sole owner of an active workspace/i);
                assert.match(error.message, /Pat Clinic/);
                return true;
            }
        );
        assert.equal(db.users.find((user) => user.id === USER_ID)?.status, "active");
        assert.equal(db.members[0].status, "active");
        assert.equal(db.workspaces[0].status, "active");
    });

    it("allows deactivation when another owner remains on the workspace", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            workspaces: [
                { id: WS_A, name: "Shared Clinic", status: "active", ownerUserId: ACTOR_ID, ownerEmail: "admin@example.com" },
            ],
            members: [
                {
                    id: "m-owner",
                    workspaceId: WS_A,
                    workspaceName: "Shared Clinic",
                    userId: ACTOR_ID,
                    email: "admin@example.com",
                    role: "owner",
                    status: "active",
                },
                {
                    id: "m-pat",
                    workspaceId: WS_A,
                    workspaceName: "Shared Clinic",
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "owner",
                    status: "active",
                },
            ],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        await runInTransaction(db, (store) =>
            deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
        );

        assert.equal(db.users.find((user) => user.id === USER_ID)?.status, "disabled");
        assert.equal(db.members.find((member) => member.id === "m-pat")?.status, "revoked");
        assert.equal(db.members.find((member) => member.id === "m-owner")?.status, "active");
        assert.equal(db.workspaces[0].status, "active");
    });

    it("12. writes user.deactivated inside the transaction, not member.removed", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            workspaces: [
                { id: WS_A, name: "Clinic A", status: "active", ownerUserId: ACTOR_ID, ownerEmail: "admin@example.com" },
            ],
            members: [
                {
                    id: "m-pat",
                    workspaceId: WS_A,
                    workspaceName: "Clinic A",
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "member",
                    status: "invited",
                },
            ],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        await runInTransaction(db, (store) =>
            deactivateUser(store, {
                actorUserId: ACTOR_ID,
                actor: { id: ACTOR_ID, email: "admin@example.com", role: "admin" },
                targetUserId: USER_ID,
            })
        );

        assert.equal(db.audit.length, 1);
        assert.equal(db.audit[0].action, AUDIT_ACTIONS.USER_DEACTIVATED);
        assert.notEqual(db.audit[0].action, AUDIT_ACTIONS.MEMBER_REMOVED);
        assert.equal(db.audit[0].target?.id, USER_ID);
        assert.equal(db.audit[0].target?.label, "pat@example.com");
        const metadata = db.audit[0].metadata as { name?: string; revokedMemberships?: RevokedMembershipAudit[] };
        assert.equal(metadata.name, "Pat Member");
        assert.equal(metadata.revokedMemberships?.[0]?.workspaceName, "Clinic A");
        assert.equal(metadata.revokedMemberships?.[0]?.previousStatus, "invited");
    });

    it("13. rolls back user, memberships, and audit if a later step fails", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            workspaces: [
                { id: WS_A, name: "Clinic A", status: "active", ownerUserId: ACTOR_ID, ownerEmail: "admin@example.com" },
            ],
            members: [
                {
                    id: "m-pat",
                    workspaceId: WS_A,
                    workspaceName: "Clinic A",
                    userId: USER_ID,
                    email: "pat@example.com",
                    role: "member",
                    status: "active",
                },
            ],
            stripeRows: [{ userId: USER_ID, status: "active" }],
            iapRows: [{ ownerUserId: USER_ID, status: "active" }],
            revenuecatRows: [{ userId: USER_ID, isActive: true }],
            audit: [],
            failOn: "revoke",
        };

        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
                ),
            /revoke failed/
        );

        assert.equal(db.users.find((user) => user.id === USER_ID)?.status, "active");
        assert.equal(db.members[0].status, "active");
        assert.equal(db.audit.length, 0);
        assert.deepEqual(db.stripeRows, [{ userId: USER_ID, status: "active" }]);
        assert.deepEqual(db.iapRows, [{ ownerUserId: USER_ID, status: "active" }]);
    });

    it("rolls back when the audit write fails", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser()],
            members: [],
            workspaces: [],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
            failOn: "audit",
        };

        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
                ),
            /audit write failed/
        );
        assert.equal(db.users.find((user) => user.id === USER_ID)?.status, "active");
        assert.equal(db.audit.length, 0);
    });

    it("returns not found for an unknown user", async () => {
        const db: MemoryDb = {
            users: [actorAdmin()],
            members: [],
            workspaces: [],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
                ),
            NotFoundError
        );
    });

    it("is idempotent when the user is already disabled", async () => {
        const db: MemoryDb = {
            users: [actorAdmin(), normalUser({ status: "disabled" })],
            members: [],
            workspaces: [],
            stripeRows: [],
            iapRows: [],
            revenuecatRows: [],
            audit: [],
        };

        const result = await runInTransaction(db, (store) =>
            deactivateUser(store, { actorUserId: ACTOR_ID, actor: { id: ACTOR_ID }, targetUserId: USER_ID })
        );
        assert.equal(result.alreadyDisabled, true);
        assert.equal(db.audit.length, 0);
    });
});

describe("isSoleOwnerOfActiveWorkspace", () => {
    it("is true when the user is the only listed owner and there are no other owner members", () => {
        assert.equal(
            isSoleOwnerOfActiveWorkspace({
                userId: USER_ID,
                email: "pat@example.com",
                workspace: { ownerUserId: USER_ID, ownerEmail: "pat@example.com" },
                ownerMembers: [{ userId: USER_ID, email: "pat@example.com" }],
            }),
            true
        );
    });

    it("is false when another unrevoked owner member exists", () => {
        assert.equal(
            isSoleOwnerOfActiveWorkspace({
                userId: USER_ID,
                email: "pat@example.com",
                workspace: { ownerUserId: USER_ID, ownerEmail: "pat@example.com" },
                ownerMembers: [
                    { userId: USER_ID, email: "pat@example.com" },
                    { userId: ACTOR_ID, email: "admin@example.com" },
                ],
            }),
            false
        );
    });

    it("is false when the workspace listed owner is someone else", () => {
        assert.equal(
            isSoleOwnerOfActiveWorkspace({
                userId: USER_ID,
                email: "pat@example.com",
                workspace: { ownerUserId: ACTOR_ID, ownerEmail: "admin@example.com" },
                ownerMembers: [
                    { userId: ACTOR_ID, email: "admin@example.com" },
                    { userId: USER_ID, email: "pat@example.com" },
                ],
            }),
            false
        );
    });
});
