import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BadRequestError, ConflictError, NotFoundError } from "@core/errors/http-errors";
import { AUDIT_ACTIONS, type AuditEventInput } from "@modules/audit/audit.service";
import {
    isLastOwnerEquivalentSeat,
    permanentlyDeleteMember,
    type LockedMember,
    type LockedWorkspace,
    type OwnerEquivalentSeat,
    type PermanentlyDeleteMemberStore,
} from "@modules/admin/admin-member.permanent-delete";

const ACTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OWNER_USER_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";
const MEMBER_ID = "33333333-3333-3333-3333-333333333333";
const OWNER_MEMBER_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_MEMBER_ID = "55555555-5555-5555-5555-555555555555";

type MemoryUser = { id: string; email: string };
type MemoryMember = LockedMember;
type MemoryWorkspace = LockedWorkspace;

type MemoryDb = {
    users: MemoryUser[];
    workspaces: MemoryWorkspace[];
    members: MemoryMember[];
    audit: AuditEventInput[];
    failOn?: "audit" | "delete";
};

function snapshot(db: MemoryDb): MemoryDb {
    return structuredClone({
        users: db.users,
        workspaces: db.workspaces,
        members: db.members,
        audit: db.audit,
    }) as MemoryDb;
}

function restore(db: MemoryDb, snap: MemoryDb): void {
    db.users = snap.users;
    db.workspaces = snap.workspaces;
    db.members = snap.members;
    db.audit = snap.audit;
}

function createStore(db: MemoryDb): PermanentlyDeleteMemberStore {
    return {
        async lockWorkspace(id) {
            return db.workspaces.find((workspace) => workspace.id === id) ?? null;
        },
        async lockMember(workspaceId, memberId) {
            return (
                db.members.find((member) => member.id === memberId && member.workspaceId === workspaceId) ?? null
            );
        },
        async listOwnerEquivalentSeats(workspaceId) {
            return db.members
                .filter(
                    (member): member is MemoryMember & OwnerEquivalentSeat =>
                        member.workspaceId === workspaceId && member.role === "owner" && member.status !== "revoked"
                )
                .map((member) => ({ id: member.id, userId: member.userId, email: member.email }));
        },
        async writeAudit(input) {
            if (db.failOn === "audit") throw new Error("audit write failed");
            db.audit.push(input);
        },
        async deleteMember(id) {
            if (db.failOn === "delete") throw new Error("delete failed");
            db.members = db.members.filter((member) => member.id !== id);
        },
    };
}

async function runInTransaction<T>(db: MemoryDb, fn: (store: PermanentlyDeleteMemberStore) => Promise<T>): Promise<T> {
    const snap = snapshot(db);
    try {
        return await fn(createStore(db));
    } catch (error) {
        restore(db, snap);
        throw error;
    }
}

function ownerWorkspace(overrides: Partial<MemoryWorkspace> = {}): MemoryWorkspace {
    return {
        id: WS_A,
        name: "Clinic A",
        ownerUserId: OWNER_USER_ID,
        ownerEmail: "owner@example.com",
        ...overrides,
    };
}

function ownerMember(overrides: Partial<MemoryMember> = {}): MemoryMember {
    return {
        id: OWNER_MEMBER_ID,
        workspaceId: WS_A,
        userId: OWNER_USER_ID,
        email: "owner@example.com",
        role: "owner",
        status: "active",
        ...overrides,
    };
}

function dummyMember(overrides: Partial<MemoryMember> = {}): MemoryMember {
    return {
        id: MEMBER_ID,
        workspaceId: WS_A,
        userId: USER_ID,
        email: "pat@example.com",
        role: "member",
        status: "active",
        ...overrides,
    };
}

function otherMember(overrides: Partial<MemoryMember> = {}): MemoryMember {
    return {
        id: OTHER_MEMBER_ID,
        workspaceId: WS_A,
        userId: OTHER_USER_ID,
        email: "other@example.com",
        role: "admin",
        status: "active",
        ...overrides,
    };
}

function seed(overrides: Partial<MemoryDb> = {}): MemoryDb {
    return {
        users: [
            { id: OWNER_USER_ID, email: "owner@example.com" },
            { id: USER_ID, email: "pat@example.com" },
            { id: OTHER_USER_ID, email: "other@example.com" },
        ],
        workspaces: [ownerWorkspace()],
        members: [ownerMember(), dummyMember(), otherMember()],
        audit: [],
        ...overrides,
    };
}

const actor = { id: ACTOR_ID, email: "admin@example.com", role: "admin" };

describe("isLastOwnerEquivalentSeat", () => {
    it("is false for a regular member when an owner seat remains", () => {
        assert.equal(
            isLastOwnerEquivalentSeat({
                member: dummyMember(),
                workspace: ownerWorkspace(),
                ownerSeats: [{ id: OWNER_MEMBER_ID, userId: OWNER_USER_ID, email: "owner@example.com" }],
            }),
            false
        );
    });

    it("is true when this identity is the only remaining owner", () => {
        assert.equal(
            isLastOwnerEquivalentSeat({
                member: dummyMember({
                    userId: OWNER_USER_ID,
                    email: "owner@example.com",
                    role: "admin",
                }),
                workspace: ownerWorkspace(),
                ownerSeats: [],
            }),
            true
        );
    });

    it("is false when another owner identity remains", () => {
        assert.equal(
            isLastOwnerEquivalentSeat({
                member: dummyMember({
                    userId: OWNER_USER_ID,
                    email: "owner@example.com",
                    role: "admin",
                }),
                workspace: ownerWorkspace({ ownerUserId: OTHER_USER_ID, ownerEmail: "other@example.com" }),
                ownerSeats: [{ id: OTHER_MEMBER_ID, userId: OTHER_USER_ID, email: "other@example.com" }],
            }),
            false
        );
    });
});

describe("permanentlyDeleteMember", () => {
    it("deletes a normal member and leaves the user, workspace, and other members", async () => {
        const db = seed();
        const result = await runInTransaction(db, (store) =>
            permanentlyDeleteMember(store, {
                actor,
                workspaceId: WS_A,
                memberId: MEMBER_ID,
                confirmation: "pat@example.com",
            })
        );

        assert.equal(result.id, MEMBER_ID);
        assert.equal(db.members.some((member) => member.id === MEMBER_ID), false);
        assert.equal(db.members.some((member) => member.id === OWNER_MEMBER_ID), true);
        assert.equal(db.members.some((member) => member.id === OTHER_MEMBER_ID), true);
        assert.equal(db.workspaces.length, 1);
        assert.equal(db.users.some((user) => user.id === USER_ID), true);
        assert.equal(db.users.length, 3);
    });

    it("accepts confirmation with different casing and surrounding whitespace", async () => {
        const db = seed();
        await runInTransaction(db, (store) =>
            permanentlyDeleteMember(store, {
                actor,
                workspaceId: WS_A,
                memberId: MEMBER_ID,
                confirmation: "  Pat@Example.com  ",
            })
        );
        assert.equal(db.members.some((member) => member.id === MEMBER_ID), false);
    });

    it("rejects owner delete with 409", async () => {
        const db = seed();
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_A,
                        memberId: OWNER_MEMBER_ID,
                        confirmation: "owner@example.com",
                    })
                ),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.match(error.message, /owner/i);
                return true;
            }
        );
        assert.equal(db.members.some((member) => member.id === OWNER_MEMBER_ID), true);
        assert.equal(db.audit.length, 0);
    });

    it("rejects the last remaining owner-equivalent seat with 409", async () => {
        const db = seed({
            members: [
                dummyMember({
                    userId: OWNER_USER_ID,
                    email: "owner@example.com",
                    role: "admin",
                }),
            ],
        });

        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_A,
                        memberId: MEMBER_ID,
                        confirmation: "owner@example.com",
                    })
                ),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.match(error.message, /last remaining owner-equivalent/i);
                return true;
            }
        );
        assert.equal(db.members.length, 1);
        assert.equal(db.audit.length, 0);
    });

    it("rejects incorrect confirmation with 400 and does not delete", async () => {
        const db = seed();
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_A,
                        memberId: MEMBER_ID,
                        confirmation: "wrong@example.com",
                    })
                ),
            (error: unknown) => {
                assert.ok(error instanceof BadRequestError);
                assert.match(error.message, /confirmation/i);
                return true;
            }
        );
        assert.equal(db.members.some((member) => member.id === MEMBER_ID), true);
        assert.equal(db.audit.length, 0);
    });

    it("returns 404 when the workspace is missing", async () => {
        const db = seed();
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_B,
                        memberId: MEMBER_ID,
                        confirmation: "pat@example.com",
                    })
                ),
            NotFoundError
        );
        assert.equal(db.members.length, 3);
    });

    it("returns 404 when the member is missing", async () => {
        const db = seed();
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_A,
                        memberId: "99999999-9999-9999-9999-999999999999",
                        confirmation: "pat@example.com",
                    })
                ),
            NotFoundError
        );
    });

    it("writes member.permanently_deleted before deleting the row", async () => {
        const db = seed();
        await runInTransaction(db, (store) =>
            permanentlyDeleteMember(store, {
                actor,
                workspaceId: WS_A,
                memberId: MEMBER_ID,
                confirmation: "pat@example.com",
            })
        );

        assert.equal(db.audit.length, 1);
        assert.equal(db.audit[0]?.action, AUDIT_ACTIONS.MEMBER_PERMANENTLY_DELETED);
        assert.notEqual(db.audit[0]?.action, AUDIT_ACTIONS.MEMBER_REMOVED);
        assert.equal(db.audit[0]?.throwOnFailure, true);
        assert.equal(db.audit[0]?.target?.id, MEMBER_ID);
        assert.equal(db.audit[0]?.workspace?.id, WS_A);
        assert.equal((db.audit[0]?.metadata as { deletionType?: string }).deletionType, "permanent");
    });

    it("rolls back the member row when the audit write fails", async () => {
        const db = seed({ failOn: "audit" });
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_A,
                        memberId: MEMBER_ID,
                        confirmation: "pat@example.com",
                    })
                ),
            /audit write failed/
        );
        assert.equal(db.members.some((member) => member.id === MEMBER_ID), true);
        assert.equal(db.audit.length, 0);
    });

    it("rolls back the audit when the delete fails after the audit write", async () => {
        const db = seed({ failOn: "delete" });
        await assert.rejects(
            () =>
                runInTransaction(db, (store) =>
                    permanentlyDeleteMember(store, {
                        actor,
                        workspaceId: WS_A,
                        memberId: MEMBER_ID,
                        confirmation: "pat@example.com",
                    })
                ),
            /delete failed/
        );
        assert.equal(db.members.some((member) => member.id === MEMBER_ID), true);
        assert.equal(db.audit.length, 0);
    });
});
