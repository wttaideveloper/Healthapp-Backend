import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";

import { auditLogs } from "@db/schema";

/**
 * Audit recording.
 *
 * One generic writer used by every module. Call sites stay a single statement so
 * business logic is not reshaped around auditing.
 *
 * FAILURE POLICY — deliberate and important:
 * `recordAuditEvent` never throws. An audit insert failing must not turn a
 * successful workspace creation into a 500 for the administrator who performed
 * it. Failures are logged at `error` level so they surface in normal log
 * monitoring instead of disappearing.
 *
 * The trade-off is explicit: this is a best-effort trail, not a
 * write-ahead-guaranteed compliance ledger. If a deployment ever needs the
 * stronger guarantee, pass the surrounding transaction as `db` and drop the
 * try/catch — the call sites do not change. See the deliverable notes.
 */

/** Anything that can execute an insert: the pooled db or an open transaction. */
export type AuditExecutor = Pick<FastifyInstance["db"], "insert">;

/**
 * Every action this system records. Values are stable machine keys — the admin
 * UI derives its filter list from what actually appears in the data, so adding a
 * key here is the only step needed to surface a new action.
 *
 * Naming: "<resource>.<past-tense-verb>".
 */
export const AUDIT_ACTIONS = {
    ADMIN_LOGIN: "auth.admin_login",
    PASSWORD_RESET: "auth.password_reset",

    ADMIN_CREATED: "admin.created",
    ADMIN_PROMOTED: "admin.promoted",

    WORKSPACE_CREATED: "workspace.created",
    WORKSPACE_UPDATED: "workspace.updated",
    WORKSPACE_REVOKED: "workspace.revoked",
    WORKSPACE_SUBSCRIPTION_CHANGED: "workspace.subscription_changed",
    WORKSPACE_PROVISIONED_SHOPIFY: "workspace.provisioned_shopify",
    WORKSPACE_CANCELLED_SHOPIFY: "workspace.cancelled_shopify",

    MEMBER_INVITED: "member.invited",
    MEMBER_JOINED: "member.joined",
    MEMBER_ROLE_CHANGED: "member.role_changed",
    MEMBER_RESTORED: "member.restored",
    MEMBER_REMOVED: "member.removed",
    INVITATION_REVOKED: "invitation.revoked",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_TARGETS = {
    WORKSPACE: "workspace",
    MEMBER: "member",
    USER: "user",
    SESSION: "session",
} as const;

export type AuditTargetType = (typeof AUDIT_TARGETS)[keyof typeof AUDIT_TARGETS];

export type AuditActor = {
    id?: string | null;
    email?: string | null;
    role?: string | null;
};

export type AuditEventInput = {
    action: AuditAction;
    /** Omit for system actors such as provider webhooks. */
    actor?: AuditActor | null;
    target?: {
        type: AuditTargetType;
        id?: string | null;
        /** Human-readable name kept alongside the id so the row stays legible. */
        label?: string | null;
    } | null;
    workspace?: { id?: string | null; name?: string | null } | null;
    result?: "success" | "failure";
    metadata?: Record<string, unknown> | null;
};

/** Pulls the signed-in actor off the request. Null when unauthenticated. */
export function auditActorFromRequest(req: FastifyRequest): AuditActor | null {
    const authUser = req.authUser;
    if (!authUser) return null;
    return { id: authUser.sub, email: authUser.email, role: authUser.role };
}

/** UUID columns reject arbitrary text; a malformed id must not fail the write. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuidOrNull(value: string | null | undefined): string | null {
    return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Writes one audit row. Never throws.
 *
 * @param db  Pooled db, or a transaction to tie the record to the same commit.
 */
export async function recordAuditEvent(
    db: AuditExecutor,
    log: FastifyBaseLogger,
    input: AuditEventInput
): Promise<void> {
    try {
        await db.insert(auditLogs).values({
            action: input.action,
            actorUserId: asUuidOrNull(input.actor?.id),
            actorEmail: input.actor?.email ?? null,
            actorRole: input.actor?.role ?? null,
            targetType: input.target?.type ?? null,
            targetId: input.target?.id ?? null,
            targetLabel: input.target?.label ?? null,
            workspaceId: asUuidOrNull(input.workspace?.id),
            workspaceName: input.workspace?.name ?? null,
            result: input.result ?? "success",
            metadata: input.metadata ?? null,
        });
    } catch (error) {
        log.error({ err: error, action: input.action }, "Failed to write audit log entry");
    }
}

/**
 * Field-level diff for update actions, limited to the keys that actually changed.
 *
 * Keeps metadata small and meaningful: an admin reading the drawer sees
 * `seatLimit: 20 -> 50`, not a dump of the whole record. Values are coerced to
 * primitives so nothing sensitive or unbounded can be captured by accident.
 */
export function buildAuditChangeSet<T extends Record<string, unknown>>(
    before: T,
    after: T,
    fields: ReadonlyArray<keyof T & string>
): Record<string, { from: unknown; to: unknown }> | null {
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const field of fields) {
        const from = normalizeAuditValue(before[field]);
        const to = normalizeAuditValue(after[field]);
        if (from !== to) changes[field] = { from, to };
    }

    return Object.keys(changes).length > 0 ? changes : null;
}

function normalizeAuditValue(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
}
