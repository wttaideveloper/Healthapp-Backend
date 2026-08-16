import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { workspaceMembers, workspaces } from "@db/schema";
import { ForbiddenError, NotFoundError } from "@core/errors/http-errors";
import type { SelectWorkspace } from "@db/schema/workspaces";

type SeatDb = Pick<FastifyInstance["db"], "select">;

export function hasAvailableWorkspaceSeat(assignedCount: number, seatLimit: number): boolean {
    return assignedCount < seatLimit;
}

export async function countNonRevokedWorkspaceSeats(db: SeatDb, workspaceId: string): Promise<number> {
    const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.status, "revoked")));

    return Number(countRow?.count ?? 0);
}

export async function lockWorkspaceForUpdate(db: SeatDb, workspaceId: string): Promise<SelectWorkspace | null> {
    const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update")
        .limit(1);

    return workspace ?? null;
}

export async function assertWorkspaceHasAvailableSeat(db: SeatDb, workspaceId: string): Promise<SelectWorkspace> {
    const workspace = await lockWorkspaceForUpdate(db, workspaceId);
    if (!workspace) {
        throw new NotFoundError("Workspace not found");
    }

    const assignedCount = await countNonRevokedWorkspaceSeats(db, workspaceId);
    if (!hasAvailableWorkspaceSeat(assignedCount, workspace.seatLimit)) {
        throw new ForbiddenError("Workspace seat limit reached");
    }

    return workspace;
}
